// Pure retention selection for the periodic DB-backup sweep. Given a
// directory listing and a keep count, decide which dump files to DELETE.
// Pure and separately tested so an off-by-one can never silently delete the
// newest backup an operator would restore from.

/** `backup-<epochMillis>.dump` — the embedded number is the sort key. */
const BACKUP_NAME = /^backup-(\d+)\.dump$/;

/**
 * Names to delete = all well-formed backups beyond the newest `keep`. The
 * newest `keep` are retained (never returned); non-matching names are never
 * returned. `keep <= 0` returns every matching backup.
 */
export function selectBackupsToPrune(filenames: string[], keep: number): string[] {
  const matched = filenames
    .map((name) => {
      const m = BACKUP_NAME.exec(name);
      return m ? { name, ts: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; ts: number } => x !== null)
    .sort((a, b) => b.ts - a.ts);

  const start = keep <= 0 ? 0 : keep;
  return matched.slice(start).map((x) => x.name);
}
