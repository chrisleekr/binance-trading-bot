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

  it('sets a 24h session window with a 1h sliding refresh', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.session?.expiresIn).toBe(60 * 60 * 24);
    expect(auth.options.session?.updateAge).toBe(60 * 60);
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

  it('limits the loginRateLimit window to 60s/5 attempts', () => {
    const auth = createAuth(baseOpts);
    expect(auth.options.rateLimit?.window).toBe(60);
    expect(auth.options.rateLimit?.max).toBe(5);
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
