// The operator's sign-in and security routes, driven with real Better Auth cookies through the production session resolver (lifetime and epoch checks included), not the test header shortcut: every case here is about which session a cookie still grants.

import { OpenAPIHono } from '@hono/zod-openapi';
import { repo } from '@app/db';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { APIError } from 'better-auth/api';

import { isKnownDevice } from '../../src/auth/known-device.js';
import { requireReauthentication } from '../../src/auth/reauthentication.js';
import type { Auth } from '../../src/auth.js';
import { audit } from '../../src/middleware/audit.js';
import { sessionResolver } from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/error.js';
import { authRouter } from '../../src/routes/auth.js';
import type { Env } from '../../src/types.js';

import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

const EMAIL = 'operator@example.test';
const PASSWORD = 'operator-password-123';

describeIfInfra('operator sign-in and security routes', () => {
  let fx: ApiFixture;
  let app: OpenAPIHono<Env>;

  const cookieOf = (res: Response): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .filter((c): c is string => c !== undefined && c.includes('session_token'))
      .join('; ');
  const request = (
    path: string,
    init: { method?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(`/api/auth${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
  const signIn = async (password = PASSWORD): Promise<Response> =>
    request('/sign-in/email', { method: 'POST', body: { email: EMAIL, password } });
  const session = async (): Promise<string> => cookieOf(await signIn());
  const events = async (event: string): Promise<Record<string, unknown>[]> =>
    (
      await fx.di.pool.query<{ payload: Record<string, unknown> }>(
        `select payload from audit_logs where category = 'security' and event = $1`,
        [event],
      )
    ).rows.map((r) => r.payload);
  const sessionId = async (cookie: string): Promise<string> => {
    const listed = (await (await request('/sessions', { cookie })).json()) as {
      sessions: { id: string; current: boolean }[];
    };
    return listed.sessions.find((s) => s.current)?.id ?? '';
  };

  beforeAll(async () => {
    fx = await setupApp({ seed: false });
    app = new OpenAPIHono<Env>();
    app.onError(errorHandler(pino({ level: 'silent' })));
    app.use(
      '*',
      sessionResolver(fx.di.auth, null, {
        db: fx.di.db,
        settings: fx.di.security.settings,
        events: fx.di.security.events,
      }),
    );
    app.use('*', audit(fx.di));
    app.route('/api/auth', authRouter(fx.di));
    const res = await request('/sign-up', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, displayName: 'Operator' },
    });
    expect(res.status).toBe(200);
  });
  beforeEach(async () => {
    await fx.di.pool.query(`delete from audit_logs where category = 'security'`);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('signs in with the session in an httpOnly cookie only, marks the device, and records the sign-in', async () => {
    const res = await signIn();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('app.session_token=') && c.includes('HttpOnly'))).toBe(
      true,
    );
    expect(cookies.some((c) => c.startsWith('app.known_device='))).toBe(true);
    // A password sign-in has no identity provider account to name.
    expect(await events('sign-in-succeeded')).toEqual([
      expect.objectContaining({ method: 'password', detail: {} }),
    ]);
  });

  it('records a wrong password against the real address individually, without saying which part was wrong', async () => {
    const res = await signIn('not-the-password-at-all');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('The email or password is not correct.');
    const failed = await events('sign-in-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: 'invalid_credentials', emailMatched: true });
    // The typed address is never stored.
    expect(JSON.stringify(failed)).not.toContain(EMAIL);
  });

  it('lists sessions without tokens and marks the current one', async () => {
    const a = await session();
    await session();
    const res = await request('/sessions', { cookie: a });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(body.sessions.filter((s) => s['current'] === true)).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('revokes one other session, which stops working at once', async () => {
    const a = await session();
    const b = await session();
    const res = await request(`/sessions/${await sessionId(b)}/revoke`, {
      method: 'POST',
      cookie: a,
    });
    expect(res.status).toBe(204);
    expect((await request('/session', { cookie: b })).status).toBe(401);
    expect((await request('/session', { cookie: a })).status).toBe(200);
    expect(await events('session-revoked')).toHaveLength(1);
    // Someone else's or an unknown session id is not found, not silently accepted.
    expect(
      (await request('/sessions/no-such-session/revoke', { method: 'POST', cookie: a })).status,
    ).toBe(404);
  });

  it('revokes every other session and keeps this one', async () => {
    const a = await session();
    const b = await session();
    const c = await session();
    expect((await request('/sessions/revoke-others', { method: 'POST', cookie: a })).status).toBe(
      204,
    );
    expect((await request('/session', { cookie: b })).status).toBe(401);
    expect((await request('/session', { cookie: c })).status).toBe(401);
    expect((await request('/session', { cookie: a })).status).toBe(200);
  });

  it('refuses sign-out-everywhere without the password and records the failed re-authentication', async () => {
    const a = await session();
    const res = await request('/sign-out-everywhere', {
      method: 'POST',
      cookie: a,
      body: { reauthentication: { method: 'password', password: 'wrong-password-here' } },
    });
    // 403, not 401: the session is still valid, and the web client treats any 401 as signed out.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PASSWORD');
    expect(await events('reauthentication-failed')).toHaveLength(1);
    expect((await request('/session', { cookie: a })).status).toBe(200);
  });

  it('refuses a single sign-on re-authentication from a password session', async () => {
    const a = await session();
    const res = await request('/sign-out-everywhere', {
      method: 'POST',
      cookie: a,
      body: { reauthentication: { method: 'singleSignOn' } },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
  });

  it('refuses the correct password as re-authentication while password sign-in is off', async () => {
    const a = await session();
    const security = fx.di.security as { passwordSignIn: boolean };
    security.passwordSignIn = false;
    try {
      const res = await request('/sign-out-everywhere', {
        method: 'POST',
        cookie: a,
        body: { reauthentication: { method: 'password', password: PASSWORD } },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'REAUTHENTICATION_REQUIRED',
      );
      expect(await events('reauthentication-failed')).toEqual([
        expect.objectContaining({ reason: 'method_disabled' }),
      ]);
      expect((await request('/session', { cookie: a })).status).toBe(200);
    } finally {
      security.passwordSignIn = true;
    }
  });

  it('refuses a password change while password sign-in is off, and signs nobody out', async () => {
    const a = await session();
    const b = await session();
    const epochBefore = (await fx.di.security.settings.get()).securityEpoch;
    const security = fx.di.security as { passwordSignIn: boolean };
    security.passwordSignIn = false;
    try {
      const res = await request('/change-password', {
        method: 'POST',
        cookie: a,
        body: { oldPassword: PASSWORD, newPassword: 'a-different-long-password' },
      });
      expect(res.status).toBe(404);
      expect((await request('/session', { cookie: b })).status).toBe(200);
      expect((await fx.di.security.settings.get()).securityEpoch).toBe(epochBefore);
    } finally {
      security.passwordSignIn = true;
    }
    expect((await signIn()).status).toBe(200);
  });

  it('signs out everywhere, including this session, and raises the epoch', async () => {
    const a = await session();
    const b = await session();
    const epochBefore = (await fx.di.security.settings.get()).securityEpoch;
    const res = await request('/sign-out-everywhere', {
      method: 'POST',
      cookie: a,
      body: { reauthentication: { method: 'password', password: PASSWORD } },
    });
    expect(res.status).toBe(204);
    expect((await request('/session', { cookie: a })).status).toBe(401);
    expect((await request('/session', { cookie: b })).status).toBe(401);
    expect((await fx.di.security.settings.get()).securityEpoch).toBe(epochBefore + 1);
    expect(await events('signed-out-everywhere')).toHaveLength(1);
  });

  it('ends a session past its absolute lifetime, and one idle past the idle timeout, recording why', async () => {
    const old = await session();
    await fx.di.pool.query(
      `update session set "createdAt" = now() - interval '25 hours' where id = $1`,
      [await sessionId(old)],
    );
    expect((await request('/session', { cookie: old })).status).toBe(401);
    expect(await events('session-expired-absolute')).toHaveLength(1);

    const idle = await session();
    await fx.di.pool.query(
      `update session set "updatedAt" = now() - interval '9 hours' where id = $1`,
      [await sessionId(idle)],
    );
    expect((await request('/session', { cookie: idle })).status).toBe(401);
    expect(await events('session-expired-idle')).toHaveLength(1);
  });

  it('refreshes last activity on use once it is 15 minutes old, so an active session is not ended as idle', async () => {
    const active = await session();
    const id = await sessionId(active);
    await fx.di.pool.query(
      `update session set "updatedAt" = now() - interval '7 hours' where id = $1`,
      [id],
    );
    expect((await request('/session', { cookie: active })).status).toBe(200);
    const row = await fx.di.pool.query<{ age: number }>(
      `select extract(epoch from now() - "updatedAt")::int as age from session where id = $1`,
      [id],
    );
    expect(row.rows[0]?.age).toBeLessThan(60);
  });

  it('reads the security settings, refuses a change without re-authentication or outside the allowed range, and records an accepted one with what changed', async () => {
    const a = await session();
    const current = (await (await request('/security-settings', { cookie: a })).json()) as Record<
      string,
      unknown
    >;
    expect(current['sessionIdleTimeoutHours']).toBe(8);
    const tighter = { ...current, sessionIdleTimeoutHours: 4 };

    expect(
      (
        await request('/security-settings', {
          method: 'PATCH',
          cookie: a,
          body: { settings: tighter },
        })
      ).status,
    ).toBe(422);
    const outOfRange = { ...current, sessionIdleTimeoutHours: 1000 };
    expect(
      (
        await request('/security-settings', {
          method: 'PATCH',
          cookie: a,
          body: {
            settings: outOfRange,
            reauthentication: { method: 'password', password: PASSWORD },
          },
        })
      ).status,
    ).toBe(422);

    const ok = await request('/security-settings', {
      method: 'PATCH',
      cookie: a,
      body: { settings: tighter, reauthentication: { method: 'password', password: PASSWORD } },
    });
    expect(ok.status).toBe(200);
    expect((await fx.di.security.settings.get()).settings.sessionIdleTimeoutHours).toBe(4);
    const changed = await events('security-settings-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.['detail']).toEqual({ sessionIdleTimeoutHours: '8 -> 4' });
    // Restore the default for the cases after this one.
    await request('/security-settings', {
      method: 'PATCH',
      cookie: a,
      body: { settings: current, reauthentication: { method: 'password', password: PASSWORD } },
    });
  });

  it('refuses a partial or misspelled settings document and leaves every stored value as it was', async () => {
    const a = await session();
    const proof = { method: 'password', password: PASSWORD };
    const current = (await (await request('/security-settings', { cookie: a })).json()) as Record<
      string,
      unknown
    >;
    // Raise retention first, so a write that silently fell back to the default would visibly shorten it.
    const longer = { ...current, securityEventRetentionDays: 1825 };
    expect(
      (
        await request('/security-settings', {
          method: 'PATCH',
          cookie: a,
          body: { settings: longer, reauthentication: proof },
        })
      ).status,
    ).toBe(200);
    const before = await events('security-settings-changed');

    const partial = await request('/security-settings', {
      method: 'PATCH',
      cookie: a,
      body: { settings: { sessionIdleTimeoutHours: 4 }, reauthentication: proof },
    });
    expect(partial.status).toBe(422);
    const { securityEventRetentionDays: _dropped, ...rest } = longer;
    const misspelled = await request('/security-settings', {
      method: 'PATCH',
      cookie: a,
      body: { settings: { ...rest, securityEventRetentionDay: 1825 }, reauthentication: proof },
    });
    expect(misspelled.status).toBe(422);

    fx.di.security.settings.invalidate();
    const stored = (await fx.di.security.settings.get()).settings;
    expect(stored.securityEventRetentionDays).toBe(1825);
    expect(stored.sessionIdleTimeoutHours).toBe(current['sessionIdleTimeoutHours']);
    expect(await events('security-settings-changed')).toHaveLength(before.length);
    await request('/security-settings', {
      method: 'PATCH',
      cookie: a,
      body: { settings: current, reauthentication: proof },
    });
  });

  it('pages the security activity newest first', async () => {
    const a = await session();
    await signIn('wrong-password-one');
    const first = (await (await request('/security-events?limit=1', { cookie: a })).json()) as {
      events: { event: string }[];
      nextBefore: string | null;
    };
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.event).toBe('sign-in-failed');
    expect(first.nextBefore).not.toBeNull();
    const second = (await (
      await request(
        `/security-events?limit=1&before=${encodeURIComponent(first.nextBefore ?? '')}`,
        { cookie: a },
      )
    ).json()) as { events: { event: string }[] };
    expect(second.events[0]?.event).toBe('sign-in-succeeded');
  });

  it('will not set a second password over an existing one, and will not unlink single sign-on that is not linked', async () => {
    const a = await session();
    const set = await request('/password', {
      method: 'POST',
      cookie: a,
      body: {
        newPassword: 'another-password-123',
        reauthentication: { method: 'password', password: PASSWORD },
      },
    });
    expect(set.status).toBe(409);
    const unlink = await request('/single-sign-on/unlink', {
      method: 'POST',
      cookie: a,
      body: { reauthentication: { method: 'password', password: PASSWORD } },
    });
    expect(unlink.status).toBe(404);
  });

  it('answers 404 for single sign-on start and link when it is not configured', async () => {
    const a = await session();
    expect((await request('/single-sign-on/start', { method: 'POST', body: {} })).status).toBe(404);
    expect(
      (
        await request('/single-sign-on/link', {
          method: 'POST',
          cookie: a,
          body: { reauthentication: { method: 'password', password: PASSWORD } },
        })
      ).status,
    ).toBe(404);
  });

  it('closes sign-up once the operator exists', async () => {
    const res = await request('/sign-up', {
      method: 'POST',
      body: { email: 'second@example.test', password: 'second-password-123' },
    });
    expect(res.status).toBe(403);
    expect((await fx.di.pool.query(`select 1 from "user"`)).rowCount).toBe(1);
  });

  it('reports which sign-in methods are offered', async () => {
    const res = await request('/onboarding-status');
    expect(await res.json()).toEqual({
      masterExists: true,
      demoMode: false,
      passwordSignIn: true,
      singleSignOn: null,
      passwordSignInForced: false,
    });
  });

  it('signs out, ending the session and recording it', async () => {
    const a = await session();
    const res = await request('/sign-out', { method: 'POST', cookie: a, body: {} });
    expect(res.status).toBe(200);
    expect((await request('/session', { cookie: a })).status).toBe(401);
    expect(await events('sign-out')).toHaveLength(1);
  });

  it('revokes agent access by stamping a cutoff that already-issued agent tokens cannot pass, and records it', async () => {
    const a = await session();
    const before = Date.now();
    const res = await request('/agent-access/revoke', { method: 'POST', cookie: a, body: {} });
    expect(res.status).toBe(204);
    // Read from the row, which is what /api/mcp reads on every verified call.
    const { agentAccessNotBefore } = await repo.authSecuritySettings.get(fx.di.db);
    expect(agentAccessNotBefore?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await events('agent-access-revoked')).toHaveLength(1);
    expect((await request('/agent-access/revoke', { method: 'POST', body: {} })).status).toBe(401);
  });

  it('answers 404 for password sign-in while it is switched off, and counts nothing against the operator', async () => {
    const security = fx.di.security as { passwordSignIn: boolean };
    security.passwordSignIn = false;
    try {
      const res = await signIn('wrong-password-here');
      expect(res.status).toBe(404);
      expect(await events('sign-in-failed')).toHaveLength(0);
    } finally {
      security.passwordSignIn = true;
    }
  });

  it('changes the password, keeps this browser signed in on a raised epoch, and retires every older session and known-device mark', async () => {
    const signedIn = await signIn();
    const cookie = cookieOf(signedIn);
    const mark = signedIn.headers
      .getSetCookie()
      .find((c) => c.startsWith('app.known_device='))
      ?.split(';')[0]
      ?.slice('app.known_device='.length);
    const other = await session();
    const userId =
      (await fx.di.pool.query<{ id: string }>(`select id from "user"`)).rows[0]?.id ?? '';
    const epochBefore = (await fx.di.security.settings.get()).securityEpoch;
    expect(isKnownDevice(fx.di.env.AUTH_SECRET, mark, userId, epochBefore)).toBe(true);
    const revokeStartedAt = Date.now();
    const newPassword = 'changed-password-456';
    const res = await request('/change-password', {
      method: 'POST',
      cookie,
      body: { oldPassword: PASSWORD, newPassword },
    });
    expect(res.status).toBe(204);
    const replacement = cookieOf(res);
    try {
      const epochAfter = (await fx.di.security.settings.get()).securityEpoch;
      expect(epochAfter).toBe(epochBefore + 1);
      // The mark issued before the change no longer counts, so an intruder's browser is back under the unknown-device limits.
      expect(isKnownDevice(fx.di.env.AUTH_SECRET, mark, userId, epochAfter)).toBe(false);
      // A password change alone leaves agent tokens working, so their cutoff moves too. Compared with no slack because an earlier case may have left a cutoff moments ago; the route stamps it from this process's clock.
      expect(
        (await repo.authSecuritySettings.get(fx.di.db)).agentAccessNotBefore?.getTime(),
      ).toBeGreaterThanOrEqual(revokeStartedAt);
      const rows = await fx.di.pool.query<{ securityEpoch: number }>(
        `select "securityEpoch" from session where "userId" = $1`,
        [userId],
      );
      expect(rows.rows.map((r) => r.securityEpoch)).toEqual([epochAfter]);
      expect((await request('/session', { cookie: replacement })).status).toBe(200);
      expect((await request('/session', { cookie: other })).status).toBe(401);
      expect(await events('change-password')).toHaveLength(1);
    } finally {
      // Later cases sign in with the original password.
      const restored = await request('/change-password', {
        method: 'POST',
        cookie: replacement,
        body: { oldPassword: newPassword, newPassword: PASSWORD },
      });
      expect(restored.status).toBe(204);
    }
  });

  it('still hands back the replacement cookie and says what is left to do when revocation fails after the password changed', async () => {
    const cookie = await session();
    const newPassword = 'changed-password-789';
    // Better Auth has committed the new password by the time this runs, so the old one can no longer retry the change.
    const bump = vi
      .spyOn(repo.authSecuritySettings, 'bumpSecurityEpoch')
      .mockRejectedValueOnce(new Error('statement timeout'));
    let replacement = '';
    try {
      const res = await request('/change-password', {
        method: 'POST',
        cookie,
        body: { oldPassword: PASSWORD, newPassword },
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /Sign out everywhere/,
      );
      replacement = cookieOf(res);
      expect((await request('/session', { cookie: replacement })).status).toBe(200);
      expect(await events('change-password')).toContainEqual(
        expect.objectContaining({ detail: { revocation: 'failed' } }),
      );
    } finally {
      bump.mockRestore();
      const restored = await request('/change-password', {
        method: 'POST',
        cookie: replacement,
        body: { oldPassword: newPassword, newPassword: PASSWORD },
      });
      expect(restored.status).toBe(204);
    }
  });

  it('counts only a wrong password against the lockout during re-authentication, and passes any other failure through', async () => {
    const attempt = { ipAddress: '203.0.113.9', userAgent: 'test', knownDevice: false };
    const proof = { method: 'password' as const, password: 'whatever-password' };
    const failingWith = (err: unknown): Auth =>
      ({
        api: {
          verifyPassword: async () => {
            throw err;
          },
        },
      }) as unknown as Auth;
    // Spied rather than read back from the audit table: this event is folded into one row per Redis window, so a row count depends on which earlier case claimed the window.
    const failures = vi.spyOn(fx.di.security.protection, 'recordPasswordFailure');
    const recorded = vi.spyOn(fx.di.security.events, 'record');
    const outage = new Error('database unreachable');
    await expect(
      requireReauthentication(
        fx.di.db,
        failingWith(outage),
        fx.di.security,
        new Headers(),
        proof,
        attempt,
      ),
    ).rejects.toBe(outage);
    expect(failures).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    // A Better Auth refusal that is not about the password (here, the session is gone) is not a wrong guess either.
    const sessionGone = APIError.from('UNAUTHORIZED', {
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
    });
    await expect(
      requireReauthentication(
        fx.di.db,
        failingWith(sessionGone),
        fx.di.security,
        new Headers(),
        proof,
        attempt,
      ),
    ).rejects.toBe(sessionGone);
    expect(failures).not.toHaveBeenCalled();
    await expect(
      requireReauthentication(
        fx.di.db,
        failingWith(
          APIError.from('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'Invalid password' }),
        ),
        fx.di.security,
        new Headers(),
        proof,
        attempt,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    expect(failures).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reauthentication-failed', reason: 'invalid_credentials' }),
    );
    failures.mockRestore();
    recorded.mockRestore();
  });

  it('refuses a security activity cursor it did not issue as a validation error, not a database failure', async () => {
    const a = await session();
    for (const before of [
      'garbage|x',
      'not-a-time|00000000-0000-4000-8000-000000000000',
      '2026-01-01T00:00:00.000000Z',
    ]) {
      const res = await request(`/security-events?before=${encodeURIComponent(before)}`, {
        cookie: a,
      });
      expect(res.status).toBe(422);
    }
  });

  it('records the re-authentication method the operator actually used when unlinking single sign-on', async () => {
    const a = await session();
    const userId =
      (await fx.di.pool.query<{ id: string }>(`select id from "user"`)).rows[0]?.id ?? '';
    await fx.di.pool.query(
      `insert into account (id, "userId", "providerId", "accountId", "createdAt", "updatedAt") values (gen_random_uuid()::text, $1, 'oidc', 'subject-1', now(), now())`,
      [userId],
    );
    // Stands in for a fresh interactive single sign-on login, the only session a single sign-on re-authentication accepts.
    await fx.di.pool.query(
      `update session set "signInMethod" = 'singleSignOn', "interactiveAuthenticatedAt" = now() where id = $1`,
      [await sessionId(a)],
    );
    const res = await request('/single-sign-on/unlink', {
      method: 'POST',
      cookie: a,
      body: { reauthentication: { method: 'singleSignOn' } },
    });
    expect(res.status).toBe(204);
    const unlinked = await events('single-sign-on-unlinked');
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({ method: 'singleSignOn' });
  });
});
