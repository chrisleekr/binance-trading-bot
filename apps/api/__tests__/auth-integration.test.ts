import { OpenAPIHono } from '@hono/zod-openapi';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { audit } from '../src/middleware/audit.js';
import { sessionResolver } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error.js';
import { authRouter } from '../src/routes/auth.js';
import { pino as createPino } from 'pino';
import type { Env } from '../src/types.js';
import { HAS_INFRA, setupApp, type ApiFixture } from './_helpers.js';

/**
 * Integration suite for the change-password flow. Unlike the existing
 * handler-level test that mocks Better Auth, this suite drives Better Auth
 * end-to-end: sign-up creates a real credential row, sign-in exchanges it
 * for a session cookie, change-password rotates the credential via Better
 * Auth's `changePassword` API, and a final sign-in confirms the new
 * password authenticates while the old one no longer does. The fixture
 * builds a fresh app with the real {@link sessionResolver} (not the test
 * header shortcut) so the credential round-trip is the actual cookie path
 * that production uses.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

// zod v4 `z.email()` requires a dotted TLD, so `@local` alone 422s at sign-up.
const EMAIL = 'integration@local.test';
const PW_OLD = 'old-password-1234';
const PW_NEW = 'new-password-5678';
const NAME = 'Integration User';
const ACCOUNT_IDENTITY_UPGRADE = readFileSync(
  new URL('../../../packages/db/migrations/0087_better_auth_account_issuer.sql', import.meta.url),
  'utf8',
);
// 0087 is no longer the last word on account identity. Better Auth 1.7.0 through 1.7.2 required the `issuer` column 0087 adds; 1.7.3 removed the requirement and went back to the 1.6 pair, so on the version this repo now runs a NOT NULL `issuer` rejects every sign-up. Replaying 0087 alone leaves the database in exactly that broken state, which is why the path under test is both migrations in order.
const ACCOUNT_IDENTITY_RELAX = readFileSync(
  new URL(
    '../../../packages/db/migrations/0096_better_auth_account_issuer_optional.sql',
    import.meta.url,
  ),
  'utf8',
);

/**
 * Extract the Better Auth session cookie from a `Set-Cookie` header. Better
 * Auth emits one cookie per session; tests need the raw `name=value`
 * fragment to re-send on subsequent requests via the `cookie` header.
 */
const extractCookie = (setCookie: string | null): string => {
  if (!setCookie) return '';
  // Hono concatenates multiple cookies with ", " — split on that boundary
  // and take only the name=value chunk (no attributes).
  return setCookie
    .split(/,\s*(?=[a-zA-Z0-9_.-]+=)/)
    .map((c) => c.split(';', 1)[0]?.trim() ?? '')
    .filter((c) => c.length > 0)
    .join('; ');
};

describeIfInfra('auth integration — sign-up → change-password → re-sign-in', () => {
  let fx: ApiFixture;
  let app: OpenAPIHono<Env>;

  beforeAll(async () => {
    // `seed: false` keeps the onboarding sign-up path open — the existing
    // seed plants Alice + Bob which would trip the ONBOARDING_CLOSED gate.
    fx = await setupApp({ seed: false });
    // Compose an app variant that uses the production session resolver
    // (cookie-driven), not the test header shortcut. Better Auth needs a
    // real cookie round-trip to authenticate change-password.
    // Bare pino, as `_helpers.ts` does: `createLogger` types its level as `pino.Level`, which has no `silent`, and nothing here asserts on log output, only that the error handler stays quiet.
    const logger = createPino({ level: 'silent' });
    app = new OpenAPIHono<Env>();
    // onError, not the legacy `errorEnvelope` middleware: that form's
    // `instanceof HttpError` check fails under Vitest's dual module identities,
    // so a thrown 401 surfaced as a bare 500. Production wires onError too.
    app.onError(errorHandler(logger));
    app.use('*', sessionResolver(fx.di.auth));
    app.use('*', audit(fx.di));
    app.route('/api/auth', authRouter(fx.di));
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  const signUp = async (): Promise<Response> =>
    app.request('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PW_OLD, name: NAME }),
    });

  const signIn = async (password: string): Promise<Response> =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password }),
    });

  const getSession = async (cookie: string): Promise<Response> =>
    app.request('/api/auth/session', { headers: { cookie } });

  const securityEvents = async (event: string): Promise<number> =>
    (
      await fx.di.pool.query(
        `select 1 from audit_logs where category = 'security' and event = $1`,
        [event],
      )
    ).rowCount ?? 0;

  const changePassword = async (
    cookie: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<Response> =>
    app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ oldPassword, newPassword }),
    });

  it('keeps an existing credential usable after the Better Auth 1.7 identity migration', async () => {
    const res = await signUp();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeTruthy();

    // Recreate the 1.6 account identity shape around the real password hash, then replay the production migrations verbatim, in order.
    await fx.di.pool.query(`
      alter table "account" alter column issuer drop not null;
      drop index if exists "account_issuer_accountId_uidx";
      create unique index if not exists "account_provider_uniq" on "account" ("providerId", "accountId");
      update "account" set issuer = null;
    `);
    await fx.di.pool.query(ACCOUNT_IDENTITY_UPGRADE);
    await fx.di.pool.query(ACCOUNT_IDENTITY_RELAX);

    const migratedSignIn = await signIn(PW_OLD);
    expect(migratedSignIn.status).toBe(200);
  });

  it('still accepts a NEW account insert after the identity migrations have run', async () => {
    // The half the sign-in assertion above cannot reach. An existing credential authenticates fine against a `NOT NULL issuer` column, because nothing inserts into `account` on sign-in. It is the INSERT that fails. The `/sign-up` route cannot reach it here: the operator already exists, so the one-operator guard answers 403 before Better Auth runs. So this makes the exact call Better Auth's sign-up makes, `internalAdapter.linkAccount` with no issuer, for the existing user. A distinct providerId keeps the operator's real credential untouched, and the row is removed afterwards so later sign-ins see only that credential.
    const user = await fx.di.pool.query<{ id: string }>(`select id from "user" where email = $1`, [
      EMAIL,
    ]);
    const userId = user.rows[0]?.id;
    expect(userId).toBeDefined();
    const ctx = await fx.di.auth.$context;
    const linked = await ctx.internalAdapter.linkAccount({
      userId: userId as string,
      providerId: 'migration-probe',
      accountId: userId as string,
      password: 'unused',
    });
    try {
      expect(linked.id).toBeTruthy();
      const row = await fx.di.pool.query<{ issuer: string | null }>(
        `select issuer from "account" where id = $1`,
        [linked.id],
      );
      expect(row.rows).toEqual([{ issuer: null }]);
    } finally {
      await fx.di.pool.query(`delete from "account" where id = $1`, [linked.id]);
    }
  });

  it('rejects change-password with a wrong oldPassword and skips the audit row', async () => {
    const session = await signIn(PW_OLD);
    expect(session.status).toBe(200);
    const cookie = extractCookie(session.headers.get('set-cookie'));
    expect(cookie).not.toBe('');

    const res = await changePassword(cookie, 'this-is-not-the-old-password', PW_NEW);
    // Not 401: the session is fine, and the web client would treat a 401 as signed out.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_PASSWORD');

    // The old password must still authenticate — the rejected call cannot
    // have rotated the credential as a side effect.
    const stillOk = await signIn(PW_OLD);
    expect(stillOk.status).toBe(200);
    // A wrong current password is a failed re-authentication, and no change is recorded.
    expect(await securityEvents('reauthentication-failed')).toBe(1);
    expect(await securityEvents('change-password')).toBe(0);
  });

  it('rotates the credential on a valid oldPassword and the new password authenticates', async () => {
    const session = await signIn(PW_OLD);
    expect(session.status).toBe(200);
    const cookie = extractCookie(session.headers.get('set-cookie'));

    const other = await signIn(PW_OLD);
    const otherCookie = extractCookie(other.headers.get('set-cookie'));

    const res = await changePassword(cookie, PW_OLD, PW_NEW);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    // Better Auth replaces this browser's session; the new cookie must reach it or the operator is signed out by their own password change.
    const renewed = extractCookie(res.headers.get('set-cookie'));
    expect(renewed).toMatch(/session_token=/);
    expect((await getSession(renewed)).status).toBe(200);
    // Every other session is signed out.
    expect((await getSession(otherCookie)).status).toBe(401);
    expect(await securityEvents('change-password')).toBe(1);

    const withNew = await signIn(PW_NEW);
    expect(withNew.status).toBe(200);
  });

  it('rejects sign-in with the old password after the rotation', async () => {
    const res = await signIn(PW_OLD);
    // Better Auth returns 401 (wrong credentials). Constrain to the 4xx
    // band so a 5xx regression (e.g. a credential-rotation bug that
    // leaves the account row corrupt) does not silently pass this test.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('change-password requires a session: bare request returns 401 UNAUTHENTICATED', async () => {
    const res = await changePassword('', PW_NEW, 'whatever-1234');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});
