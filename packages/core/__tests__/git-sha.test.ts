import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGitSha } from '../src/git-sha/git-sha.js';

describe('resolveGitSha', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns the provided env value when non-empty', () => {
    expect(resolveGitSha('abc1234')).toBe('abc1234');
  });

  it('trims whitespace around a provided env value', () => {
    expect(resolveGitSha('  abc1234  ')).toBe('abc1234');
  });

  // The git fallback must be exercised with a mocked execSync, not the real
  // binary: CI's unit-test container has no `.git`/git, so a real call returns
  // 'unknown' and a "real SHA" assertion would be non-deterministic.
  it('falls back to git rev-parse when env is an empty string', async () => {
    vi.doMock('node:child_process', () => ({ execSync: () => 'deadbee\n' }));
    const { resolveGitSha: mocked } = await import('../src/git-sha/git-sha.js');
    expect(mocked('')).toBe('deadbee');
  });

  it('falls back to git rev-parse when env is undefined', async () => {
    vi.doMock('node:child_process', () => ({ execSync: () => '  deadbee  ' }));
    const { resolveGitSha: mocked } = await import('../src/git-sha/git-sha.js');
    expect(mocked(undefined)).toBe('deadbee');
  });

  it("degrades to 'unknown' when git is unavailable", async () => {
    // Mock execSync to throw, simulating the production alpine runtime that
    // ships no git binary. Re-imported under the mock so the throw path runs.
    vi.doMock('node:child_process', () => ({
      execSync: () => {
        throw new Error('git: not found');
      },
    }));
    const { resolveGitSha: mocked } = await import('../src/git-sha/git-sha.js');
    expect(mocked(undefined)).toBe('unknown');
    expect(mocked('')).toBe('unknown');
  });
});
