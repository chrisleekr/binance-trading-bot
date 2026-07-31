// Tests for the reset-password CLI helpers. The full DB-touching flow lives
// in the testcontainers suite (#48); here we lock the boundary contract
// (argv parsing, password generator) so a typo in the CLI surface is caught
// in the unit suite.

import { describe, expect, it } from 'vitest';

import { _testing } from '../scripts/reset-password.js';

const { generatePassword, parseEmail } = _testing;

describe('parseEmail', () => {
  it('returns the email when --email <value> is present and looks like an address', () => {
    expect(parseEmail(['--email', 'A@B.com'])).toBe('a@b.com');
  });

  it('returns null when --email is absent', () => {
    expect(parseEmail([])).toBeNull();
    expect(parseEmail(['--other', 'x'])).toBeNull();
  });

  it('returns null when --email value is missing', () => {
    expect(parseEmail(['--email'])).toBeNull();
  });

  it('returns null when the value lacks an @', () => {
    expect(parseEmail(['--email', 'not-an-email'])).toBeNull();
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
