// Criterion 1: LIVE_DEMO identity injection at the single ingress.
//
// sessionResolver is the ONE place c.var.userId is populated. Under LIVE_DEMO
// the boot-resolved sole-operator id must be injected when Better Auth resolves
// no session, so every requireUser() mount, userIdOf(), and ws.ts read it and
// the login screen never appears. With the flag off, no session must leave
// userId unset (today's behaviour).
//
// RED: the current sessionResolver(auth) takes no demo argument and injects
// nothing, so the "enabled" case sees a null userId.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { asUserId, type UserId } from '@app/contracts';
import { sessionResolver } from '../src/middleware/auth.js';
import type { Auth } from '../src/auth.js';
import type { Env } from '../src/types.js';

const DEMO_ID = asUserId('00000000-0000-4000-8000-00000000d001');
const SESSION_ID = asUserId('00000000-0000-4000-8000-00000000e001');

const authWith = (session: { user: { id: string } } | null): Auth =>
  ({ api: { getSession: async () => session } }) as unknown as Auth;

// Intended Phase-B signature: sessionResolver(auth, demo), where `demo` is the
// boot-resolved operator injected when LIVE_DEMO is on, else null. Casting keeps
// this test compiling against today's 1-arg signature while locking the runtime
// contract Phase B must satisfy.
type DemoResolver = (auth: Auth, demo: { userId: UserId } | null) => MiddlewareHandler<Env>;
const resolver = sessionResolver as unknown as DemoResolver;

const probe = async (auth: Auth, demo: { userId: UserId } | null): Promise<string | null> => {
  const app = new Hono<Env>();
  app.use('*', resolver(auth, demo));
  app.get('/probe', (c) => c.json({ userId: c.get('userId') ?? null }));
  const res = await app.request('/probe');
  return ((await res.json()) as { userId: string | null }).userId;
};

describe('sessionResolver under LIVE_DEMO', () => {
  it('injects the sole operator id when demo is on and no session exists', async () => {
    expect(await probe(authWith(null), { userId: DEMO_ID })).toBe(DEMO_ID);
  });

  it('leaves userId unset when demo is off and no session exists', async () => {
    expect(await probe(authWith(null), null)).toBeNull();
  });

  it('a real Better Auth session always wins over the demo injection', async () => {
    expect(await probe(authWith({ user: { id: SESSION_ID } }), { userId: DEMO_ID })).toBe(
      SESSION_ID,
    );
  });
});
