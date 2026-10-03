import { describe, expect, it } from 'vitest';

import {
  AuthSecuritySettings,
  DEFAULT_AUTH_SECURITY_SETTINGS,
  UpdateAuthSecuritySettingsRequest,
} from '../src/auth-security-settings.js';

const proof = { method: 'password', password: 'operator-password-123' } as const;

/**
 * Parses a write and reports the issue paths, so each case states which field was refused rather than only that something was.
 *
 * @param settings - The document the caller sends.
 * @returns Null when the write is accepted, otherwise the dotted path of every issue.
 */
const refusedPaths = (settings: unknown): string[] | null => {
  const parsed = UpdateAuthSecuritySettingsRequest.safeParse({ settings, reauthentication: proof });
  return parsed.success ? null : parsed.error.issues.map((i) => i.path.join('.'));
};

describe('AuthSecuritySettings on read', () => {
  it('fills every missing field with its default, so a row written before a field existed still reads', () => {
    expect(AuthSecuritySettings.parse({ sessionIdleTimeoutHours: 4 })).toEqual({
      ...DEFAULT_AUTH_SECURITY_SETTINGS,
      sessionIdleTimeoutHours: 4,
    });
  });
});

describe('UpdateAuthSecuritySettingsRequest', () => {
  it('accepts the complete document', () => {
    expect(refusedPaths(DEFAULT_AUTH_SECURITY_SETTINGS)).toBeNull();
  });

  it('refuses a partial document instead of resetting the missing fields to their defaults', () => {
    expect(refusedPaths({ sessionIdleTimeoutHours: 4 })).toContain(
      'settings.securityEventRetentionDays',
    );
  });

  it('refuses a group with a missing field', () => {
    expect(
      refusedPaths({
        ...DEFAULT_AUTH_SECURITY_SETTINGS,
        ipAddressBlock: { initialBlockSeconds: 900 },
      }),
    ).toEqual(['settings.ipAddressBlock.maximumBlockSeconds']);
  });

  it('refuses a misspelled field rather than dropping it and applying the default', () => {
    const { securityEventRetentionDays: _dropped, ...rest } = DEFAULT_AUTH_SECURITY_SETTINGS;
    expect(refusedPaths({ ...rest, securityEventRetentionDay: 1825 })).toEqual([
      'settings.securityEventRetentionDays',
      'settings',
    ]);
  });

  it('refuses an unknown field inside a group', () => {
    expect(
      refusedPaths({
        ...DEFAULT_AUTH_SECURITY_SETTINGS,
        ipAddressBlock: { ...DEFAULT_AUTH_SECURITY_SETTINGS.ipAddressBlock, disabled: true },
      }),
    ).toEqual(['settings.ipAddressBlock']);
  });

  it('still enforces each range and both rules that span two fields', () => {
    expect(
      refusedPaths({ ...DEFAULT_AUTH_SECURITY_SETTINGS, securityEventRetentionDays: 1 }),
    ).toEqual(['settings.securityEventRetentionDays']);
    expect(
      refusedPaths({
        ...DEFAULT_AUTH_SECURITY_SETTINGS,
        ipAddressBlock: { initialBlockSeconds: 86_400, maximumBlockSeconds: 3600 },
      }),
    ).toEqual(['settings.ipAddressBlock']);
    expect(
      refusedPaths({
        ...DEFAULT_AUTH_SECURITY_SETTINGS,
        sessionIdleTimeoutHours: 20,
        sessionAbsoluteLifetimeHours: 12,
      }),
    ).toEqual(['settings.sessionIdleTimeoutHours']);
  });
});
