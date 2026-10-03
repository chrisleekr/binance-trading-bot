// Tests for the reset-password CLI helpers. The database-touching recovery and the command wrapper, which opens its own connections, live in reset-password-integration.test.ts; here we lock the command-line contract (argument parsing, password generator) so a typo in the CLI surface is caught in the unit suite.

import { Redis } from 'ioredis';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { _testing } from '../scripts/reset-password.js';

const { generatePassword, parseArgs, createRecoveryLimiter } = _testing;

describe('parseArgs', () => {
  it('returns the normalised email when --email <value> is present and looks like an address', () => {
    expect(parseArgs(['--email', ' A@B.com'])).toEqual({
      email: 'a@b.com',
      unlinkSingleSignOn: false,
      clearLockoutOnly: false,
    });
  });

  it('reads the recovery flags', () => {
    expect(parseArgs(['--email', 'a@b.com', '--unlink-single-sign-on'])?.unlinkSingleSignOn).toBe(
      true,
    );
    expect(parseArgs(['--email', 'a@b.com', '--clear-lockout'])?.clearLockoutOnly).toBe(true);
  });

  it('refuses contradictory flags: --clear-lockout leaves the password alone, so it cannot also unlink the only other way in', () => {
    expect(
      parseArgs(['--email', 'a@b.com', '--clear-lockout', '--unlink-single-sign-on']),
    ).toBeNull();
  });

  it('returns null when --email is absent', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--other', 'x'])).toBeNull();
  });

  it('returns null when --email value is missing', () => {
    expect(parseArgs(['--email'])).toBeNull();
  });

  it('returns null when the value lacks an @', () => {
    expect(parseArgs(['--email', 'not-an-email'])).toBeNull();
  });
});

describe('generatePassword', () => {
  it('returns a base64url string of the expected length', () => {
    const pw = generatePassword();
    // 24 random bytes → ceil(24 * 4 / 3) = 32 base64url chars (no padding).
    expect(pw).toHaveLength(32);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces distinct values across calls', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
  });
});

describe('the recovery limiter', () => {
  it('fails both deletions loudly while Redis is unreachable, instead of clearing a process-local copy and reporting success', async () => {
    // The server's limiter falls back to process memory; this process exits straight after, so a fallback would delete nothing and the command would still say the lockout was lifted.
    const unreachable = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on('error', () => undefined);
    const limiter = createRecoveryLimiter(unreachable, pino({ level: 'silent' }));
    try {
      await expect(limiter.clear(['auth:lock:email:x'])).rejects.toThrow();
      await expect(limiter.clearPrefix('auth:block:ip:')).rejects.toThrow();
    } finally {
      unreachable.disconnect();
    }
  });
});
