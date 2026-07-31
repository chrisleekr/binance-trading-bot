// Pure selection logic for the periodic DB backup retention sweep.
// Given the backup directory listing and a `keep` count,
// `selectBackupsToPrune` decides which dump files to DELETE. Keeping
// this pure and tested separately from the cron means the "which files
// to delete" decision never rides on real filesystem state, so an
// off-by-one here can't silently nuke the newest backup an operator
// would actually restore from.

import { describe, expect, it } from 'vitest';

import { selectBackupsToPrune } from '../../src/crons/retention-select.js';

// `backup-<epochMillis>.dump` — the timestamp embedded in the name is
// the sort key. Larger number = newer.
const f = (ms: number): string => `backup-${ms}.dump`;

describe('selectBackupsToPrune', () => {
  it('keeps the N newest and returns the rest to delete', () => {
    const files = [f(100), f(500), f(300), f(200), f(400)];
    // keep the 2 newest (500, 400); delete the 3 oldest.
    const toDelete = selectBackupsToPrune(files, 2);
    expect([...toDelete].sort()).toEqual([f(100), f(200), f(300)].sort());
  });

  it('returns [] when file count is <= keep', () => {
    const files = [f(100), f(200)];
    expect(selectBackupsToPrune(files, 2)).toEqual([]);
    expect(selectBackupsToPrune(files, 5)).toEqual([]);
  });

  it('ignores files that do not match the backup pattern', () => {
    const files = [
      f(300),
      f(100),
      f(200),
      'README.md',
      'backup-.dump',
      'backup-123.dump.tmp',
      'snapshot-400.dump',
    ];
    // Only the 3 well-formed backups count; keep 1 newest (300),
    // delete the other two. Non-matching files are never returned.
    const toDelete = selectBackupsToPrune(files, 1);
    expect([...toDelete].sort()).toEqual([f(100), f(200)].sort());
  });

  it('returns all matching files when keep is 0', () => {
    const files = [f(100), f(200), 'unrelated.txt'];
    const toDelete = selectBackupsToPrune(files, 0);
    expect([...toDelete].sort()).toEqual([f(100), f(200)].sort());
  });
});
