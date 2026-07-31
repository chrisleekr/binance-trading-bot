import { asUserId, errorCodeToStatus, type ErrorCode } from '@app/contracts';
import { OpenAPIHono } from '@hono/zod-openapi';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import type { DI } from '../../src/di.js';
import { authRouter } from '../../src/routes/auth.js';
import type { Env } from '../../src/types.js';

const USER = asUserId('00000000-0000-0000-0000-0000000c0001');

interface Harness {
  app: OpenAPIHono<Env>;
  changePassword: ReturnType<typeof vi.fn>;
  audited: ({ event: string; payload?: unknown } | undefined)[];
}

const isCoded = (err: unknown): err is { code: ErrorCode; message: string } =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as { code?: unknown }).code === 'string' &&
  typeof (err as { message?: unknown }).message === 'string';

const buildHarness = (): Harness => {
  const logger = pino({ level: 'silent' });
  const changePassword = vi.fn();
  const audited: Harness['audited'] = [];

  const di: DI = {
    db: {} as DI['db'],
    logger,
    // authRouter mounts requireNotDemo(di), which reads di.env.LIVE_DEMO.
    env: { LIVE_DEMO: false } as unknown as DI['env'],
    auth: {
      api: { changePassword },
      handler: () => new Response(null, { status: 404 }),
    } as unknown as DI['auth'],
  } as unknown as DI;

  const app = new OpenAPIHono<Env>();
  // Duck-typed error handler — errorEnvelope's `instanceof HttpError` check
  // fails when the route's `HttpError` and the test's import resolve to
  // different module instances under Vite. The wire shape matches errorEnvelope.
  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        { error: { code: 'VALIDATION_FAILED', message: 'invalid request', details: err.issues } },
        422,
      );
    }
    if (isCoded(err)) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        errorCodeToStatus(err.code) as 400 | 401 | 403 | 404 | 422 | 429 | 500 | 502,
      );
    }
    return c.json({ error: { code: 'INTERNAL', message: 'internal' } }, 500);
  });
  app.use('*', async (c, next) => {
    const headerUser = c.req.header('x-test-user-id');
    if (headerUser) c.set('userId', asUserId(headerUser));
    await next();
    audited.push(c.get('auditEvent'));
  });
  app.route('/api/auth', authRouter(di));
  return { app, changePassword, audited };
};

const post = (
  app: OpenAPIHono<Env>,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app.fetch(
    new Request('http://test.local/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/auth/change-password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the credential check to Better Auth and returns 204 on success', async () => {
    const { app, changePassword, audited } = buildHarness();
    changePassword.mockResolvedValue(undefined);

    const res = await post(
      app,
      { oldPassword: 'oldpw12345', newPassword: 'newpassword12345' },
      { 'x-test-user-id': USER },
    );

    expect(res.status).toBe(204);
    expect(changePassword).toHaveBeenCalledTimes(1);
    const arg = changePassword.mock.calls[0]?.[0] as {
      body: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean };
    };
    expect(arg.body).toEqual({
      currentPassword: 'oldpw12345',
      newPassword: 'newpassword12345',
      revokeOtherSessions: false,
    });
    expect(audited).toContainEqual({ event: 'change-password' });
  });

  it('returns 401 INVALID_PASSWORD when Better Auth rejects oldPassword and skips the audit row', async () => {
    const { app, changePassword, audited } = buildHarness();
    changePassword.mockRejectedValue(new Error('wrong password'));

    const res = await post(
      app,
      { oldPassword: 'wrong', newPassword: 'newpassword12345' },
      { 'x-test-user-id': USER },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_PASSWORD');
    expect(audited).not.toContainEqual({ event: 'change-password' });
  });

  it('returns 401 UNAUTHENTICATED when no session is bound', async () => {
    const { app, changePassword } = buildHarness();

    const res = await post(app, { oldPassword: 'oldpw12345', newPassword: 'newpassword12345' });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(changePassword).not.toHaveBeenCalled();
  });
});
