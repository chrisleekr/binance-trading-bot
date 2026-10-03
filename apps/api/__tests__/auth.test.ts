// Better Auth wiring smoke tests. The full sign-up / sign-in path is an
// integration concern covered by the testcontainers suite; what we pin
// here are the construction-time invariants — each is a config field
// that can silently regress on a Better Auth major bump, and there's no
// other harness gating those values.

import { describe, expect, it } from 'vitest';

import type { Database } from '@app/db';
import { createAuth } from '../src/auth.js';

const stubDb = {} as unknown as Database;

const baseOpts = {
  db: stubDb,
  webOrigins: ['https://app.example.com'],
  authSecret: 'x'.repeat(32),
  isProduction: true,
};

describe('createAuth — config invariants', () => {
  it('builds an auth instance with the email-and-password adapter and no twoFactor plugin', () => {
    const auth = createAuth(baseOpts);
    expect(auth).toBeDefined();
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false);
    expect(auth.options.plugins ?? []).toHaveLength(0);
  });

  it("sets Better Auth's session lifetime to the 7-day ceiling with a 15-minute refresh", () => {
    // The operator's idle and absolute limits (at most 24 h and 168 h) are enforced by the session resolver; Better Auth's own expiry is only the outer bound, and the refresh interval is the precision of the idle timeout.
    const auth = createAuth(baseOpts);
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 168);
    expect(auth.options.session?.updateAge).toBe(15 * 60);
  });

  it('requires the same 12 to 256 character password the sign-up contract does', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12);
    expect(auth.options.emailAndPassword?.maxPasswordLength).toBe(256);
  });

  it('never links a new sign-in identity to the operator by matching email', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.account?.accountLinking?.disableImplicitLinking).toBe(true);
    expect(auth.options.account?.updateAccountOnSignIn).toBe(false);
  });

  it('relaxes only the single sign-on state cookie to SameSite=Lax, so the identity provider redirect can carry it back', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.advanced?.cookies?.['state']?.attributes?.sameSite).toBe('lax');
    expect(auth.options.advanced?.cookies?.['session_token']).toBeUndefined();
  });

  it('emits Secure HttpOnly SameSite=Strict cookies in production', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.advanced?.useSecureCookies).toBe(true);
    expect(auth.options.advanced?.defaultCookieAttributes?.sameSite).toBe('strict');
    expect(auth.options.advanced?.defaultCookieAttributes?.httpOnly).toBe(true);
    expect(auth.options.advanced?.defaultCookieAttributes?.path).toBe('/');
  });

  it('disables Secure cookies outside production so local http://localhost can sign in', () => {
    const auth = createAuth({ ...baseOpts, isProduction: false });
    expect(auth.options.advanced?.useSecureCookies).toBe(false);
  });

  it("turns Better Auth's own in-memory limiter off, because the Redis limits in front of it replace it", () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.rateLimit?.enabled).toBe(false);
  });

  it('turns password sign-in off when asked', () => {
    const auth = createAuth({ ...baseOpts, passwordSignIn: false });
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
  });

  it('trusts the configured web origin', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.trustedOrigins).toContain('https://app.example.com');
  });

  it('trusts every origin in a multi-origin allowlist', () => {
    const auth = createAuth({
      ...baseOpts,
      webOrigins: ['https://app.example.com', 'http://192.168.1.50:5173'],
    });
    expect(auth.options.trustedOrigins).toEqual(
      expect.arrayContaining(['https://app.example.com', 'http://192.168.1.50:5173']),
    );
  });
});
