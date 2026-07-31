import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PG_DUMP_ARGS, pgDumpToFile } from '../src/backup/index.js';
import { errorMessage } from '../src/error/index.js';

// Spy wrapper around the real spawn, so "was pg_dump started?" is answered by a
// call record instead of by observing the child. A child observable is useless
// here: the failure path kills the child within a millisecond, long before
// /bin/sh gets to run any script body, so the child can never report itself.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Same wrapping for the filesystem calls that carry the fix. `open` is spied so
// the temp file's creation can be ordered against the spawn, and `unlink` so the
// cleanup fault can be forced without a permissions fixture: CI containers
// commonly run as root, where a chmod fixture silently succeeds and the branch
// under test is never entered.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});

describe('PG_DUMP_ARGS', () => {
  // Pins the single source of truth for the dump flags: the API download and
  // the worker cron both spread this constant, so a silent edit here would
  // drift the two archive paths apart.
  it('is the custom-format, no-owner, no-acl flag set', () => {
    expect([...PG_DUMP_ARGS]).toEqual(['--format=custom', '--no-owner', '--no-acl']);
  });
});

// pgDumpToFile spawns the real `pg_dump` binary, so we plant a controllable
// shell shim named `pg_dump` first on PATH. The shim ignores the connection
// string and instead emits scripted bytes / stderr / exit code, which lets us
// drive every branch deterministically without a database.
describe('pgDumpToFile', () => {
  let dir: string;
  let prevPath: string | undefined;

  const writeShim = (body: string): void => {
    const shim = join(dir, 'pg_dump');
    writeFileSync(shim, `#!/bin/sh\n${body}\n`);
    chmodSync(shim, 0o755);
  };

  const opts = (outPath: string): { databaseUrl: string; pgSslMode: string; outPath: string } => ({
    databaseUrl: 'postgres://ignored',
    pgSslMode: 'disable',
    outPath,
  });

  beforeEach(() => {
    // reset, not clear: these spies wrap the real implementations, so reset
    // restores them and also drops any leftover one-time stub that a test
    // queued but did not consume.
    vi.mocked(spawn).mockReset();
    vi.mocked(open).mockReset();
    vi.mocked(unlink).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'pgdump-test-'));
    prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the dump bytes to outPath and leaves no .partial on success', async () => {
    writeShim('printf "DUMP-BYTES"; exit 0');
    const outPath = join(dir, 'backup-1.dump');

    await pgDumpToFile(opts(outPath));

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('DUMP-BYTES');
    expect(existsSync(`${outPath}.partial`)).toBe(false);
  });

  it('opens the temp file before pg_dump is spawned', async () => {
    // The ordering is the whole fix: cleanup can only ever run against a file
    // that already exists, so a fast failure cannot leave an orphan .partial.
    const outPath = join(dir, 'backup-4.dump');
    writeShim(`[ -f "${outPath}.partial" ] && printf EXISTS || printf MISSING; exit 0`);

    await pgDumpToFile(opts(outPath));

    // Both spies must have fired, otherwise the ordering comparison below could
    // be satisfied by a call that never happened.
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    // invocationCallOrder is a counter shared across every spy, so this is an
    // exact happens-before rather than a timing observation.
    expect(vi.mocked(open).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawn).mock.invocationCallOrder[0],
    );
    // Same claim seen from outside the process: the shim reports the file it
    // found on disk when it ran.
    expect(readFileSync(outPath, 'utf8')).toBe('EXISTS');
  });

  it('truncates a stale .partial left by a previous crashed dump', async () => {
    // A crashed dump leaves this behind and the cron only sweeps after a
    // SUCCESSFUL run, so the next dump can land on top of it. Opening with 'w'
    // must truncate, never append, or the archive is silently corrupt and only
    // fails at restore time.
    writeShim('printf "NEW"; exit 0');
    const outPath = join(dir, 'backup-8.dump');
    writeFileSync(`${outPath}.partial`, 'STALE-BYTES-FROM-A-KILLED-DUMP');

    await pgDumpToFile(opts(outPath));

    expect(readFileSync(outPath, 'utf8')).toBe('NEW');
  });

  it('removes the temp file when spawn throws synchronously', async () => {
    // Covers why the catch reaches the child through an optional call: if spawn
    // throws before returning, the temp file already exists and must still go.
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('spawn blew up');
    });
    const outPath = join(dir, 'backup-7.dump');

    await expect(pgDumpToFile(opts(outPath))).rejects.toThrow(/spawn blew up/);
    expect(existsSync(`${outPath}.partial`)).toBe(false);
    expect(existsSync(outPath)).toBe(false);
  });

  it('rejects with stderr on a nonzero exit and leaves no outPath', async () => {
    writeShim('echo "permission denied" 1>&2; exit 1');
    const outPath = join(dir, 'backup-2.dump');

    await expect(pgDumpToFile(opts(outPath))).rejects.toThrow(/permission denied/);
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.partial`)).toBe(false);
  });

  it('leaves no orphan .partial across repeated spawn failures', async () => {
    // Empty PATH so the spawn can't resolve `pg_dump` at all.
    process.env.PATH = '';

    // 20 iterations because the orphan .partial only appears on a fraction of
    // runs, 17/20 under Node and 9/20 under Bun, so asserting once would itself
    // be flaky in the other direction. Collected rather than asserted in the
    // loop, so a regression names the offending iterations instead of failing
    // on an anonymous first one.
    const survivors: string[] = [];
    for (let i = 0; i < 20; i++) {
      const outPath = join(dir, `backup-3-${i}.dump`);

      await expect(pgDumpToFile(opts(outPath))).rejects.toThrow();
      if (existsSync(outPath)) survivors.push(`outPath#${i}`);
      if (existsSync(`${outPath}.partial`)) survivors.push(`partial#${i}`);
    }

    expect(survivors).toEqual([]);
  });

  it('rejects without spawning pg_dump when the temp file cannot be created', async () => {
    // A working shim stays planted so a spawn would succeed, keeping the only
    // failure in play the temp file the code cannot create.
    writeShim('printf "DUMP-BYTES"; exit 0');

    // Anchor the spy in THIS test before trusting a "did not happen" assertion:
    // a module mock that failed to intercept the subject's own import would
    // otherwise make the check below pass for the wrong reason.
    await pgDumpToFile(opts(join(dir, 'anchor.dump')));
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    vi.mocked(spawn).mockClear();

    // Parent directory deliberately absent, so opening the temp file is a
    // guaranteed ENOENT rather than a timing-dependent failure.
    const outPath = join(dir, 'no-such-dir', 'backup-5.dump');

    await expect(pgDumpToFile(opts(outPath))).rejects.toThrow(/ENOENT/);

    // The call record settles this with no timing window at all: a dump that
    // cannot be written must never reach the database in the first place.
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}.partial`)).toBe(false);
  });

  it('reports a failed temp file removal without losing the dump reason', async () => {
    writeShim('echo "permission denied" 1>&2; exit 1');
    const outPath = join(dir, 'backup-6.dump');
    vi.mocked(unlink).mockRejectedValueOnce(new Error('EPERM cleanup denied'));

    const err = await pgDumpToFile(opts(outPath)).catch((e: unknown) => e);

    // Both halves in one message: the cleanup fault is new information, and the
    // dump reason is what the operator-facing sanitiser expects to find.
    expect(errorMessage(err)).toMatch(
      /pg_dump exit=1[\s\S]*permission denied[\s\S]*cleanup failed: EPERM cleanup denied/,
    );
    // The chain is load-bearing, not decorative: dropping it would still leave
    // the message above intact, so assert it separately.
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({
      message: expect.stringContaining('pg_dump exit=1'),
    });

    // The surviving temp file is the whole reason the failure is worth
    // reporting rather than swallowing. Without this, the message could drift
    // to describing a file that was actually removed.
    expect(existsSync(`${outPath}.partial`)).toBe(true);
    expect(existsSync(outPath)).toBe(false);
  });
});
