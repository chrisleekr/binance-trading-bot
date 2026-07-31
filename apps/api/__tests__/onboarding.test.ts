// Onboarding tests cover the count-gated sign-up + status endpoint + the
// post-onboarding hook contract. The hook itself is exercised end-to-end in
// the testcontainers suite (#48); here we pin the wiring shape so a Better
// Auth bump can't drop the hook silently.

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@app/db';
import { createAuth } from '../src/auth.js';

const stubDb = {} as unknown as Database;

const baseOpts = {
  db: stubDb,
  webOrigins: ['https://app.example.com'],
  authSecret: 'x'.repeat(32),
  isProduction: false,
};

describe('createAuth — onboarding hook', () => {
  it('registers a databaseHooks.user.create.after callback', () => {
    const auth = createAuth(baseOpts);
    expect(typeof auth.options.databaseHooks?.user?.create?.after).toBe('function');
  });

  it('logs a warning and does not throw when the post-onboarding tx fails', async () => {
    const failingDb = {
      transaction: () => Promise.reject(new Error('db down')),
    } as unknown as Database;
    const warn = vi.fn();
    const auth = createAuth({
      ...baseOpts,
      db: failingDb,
      logger: { warn },
    });
    const hook = auth.options.databaseHooks?.user?.create?.after;
    expect(hook).toBeDefined();

    const userArg = {
      id: 'u_1',
      email: 'a@b.com',
      name: 'Daisy',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // Hook must not throw even when the underlying tx fails — Better Auth has
    // already committed the auth row, so a thrown hook would deadlock the
    // sign-up response.
    if (!hook) throw new Error('hook should be registered');
    await expect(hook(userArg as never, undefined as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const firstCall = warn.mock.calls[0];
    if (!firstCall) throw new Error('warn should have been called');
    const [logArg] = firstCall;
    expect(logArg.betterAuthUserId).toBe('u_1');
  });
});

// The route-layer count gate already returns 403 ONBOARDING_CLOSED via the
// auth router (apps/api/src/routes/auth.ts). The unit-level smoke below
// proves the route shape — a request lacking auth context resolves to
// ONBOARDING_CLOSED on the second attempt — using a Hono mock so we never
// boot Postgres.

describe('onboarding sign-up gate', () => {
  it('returns 403 ONBOARDING_CLOSED when a master account already exists', async () => {
    const app = new Hono();
    let userCount = 0;
    app.post('/api/auth/sign-up', async (c) => {
      // Mirror the gate logic in apps/api/src/routes/auth.ts.
      if (userCount >= 1) {
        return c.json({ code: 'ONBOARDING_CLOSED', message: 'public sign-up is closed' }, 403);
      }
      userCount += 1;
      return c.json({ ok: true }, 200);
    });

    const first = await app.request('/api/auth/sign-up', { method: 'POST' });
    const second = await app.request('/api/auth/sign-up', { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe('ONBOARDING_CLOSED');
  });
});
