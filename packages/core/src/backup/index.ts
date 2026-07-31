import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { errorMessage } from '../error/index.js';

/**
 * pg_dump flags shared by the on-demand API download and the worker's
 * scheduled backup cron, so both produce byte-compatible custom-format
 * archives restorable by the same `pg_restore` path. Custom format is
 * compressed and selectively restorable; --no-owner / --no-acl drop role and
 * grant statements that would not replay on a fresh target.
 */
export const PG_DUMP_ARGS = ['--format=custom', '--no-owner', '--no-acl'] as const;

export interface PgDumpToFileOptions {
  databaseUrl: string;
  pgSslMode: string;
  outPath: string;
}

/**
 * Dumps the whole database to `outPath` as a custom-format archive. Resolves
 * once the file is fully flushed and pg_dump exited 0. Rejects with: the raw
 * filesystem error if the `.partial` temp file cannot be opened, in which case
 * pg_dump is never spawned; the collected stderr on a nonzero exit or a spawn
 * error; a composite message carrying both reasons, and the dump error as
 * `cause`, when that failure's own cleanup also fails; or the raw filesystem
 * error if the final rename fails, which leaves the temp file behind for the
 * cron's stale sweep because the bytes are already complete by then.
 *
 * Atomic write: the dump streams to a `.partial` sibling and is renamed onto
 * `outPath` only after pg_dump exits 0 and the stream flushes. So `outPath`
 * never exists as a half-written archive that retention would miscount as a
 * real backup.
 *
 * The temp file is opened and awaited before pg_dump is spawned, which is what
 * makes the failure path honest: a dump with nowhere to write never reaches the
 * database, and past that point the temp file provably exists, so cleanup
 * either removes it or reports why it could not.
 */
export async function pgDumpToFile(opts: PgDumpToFileOptions): Promise<void> {
  const tmpPath = `${opts.outPath}.partial`;
  // Outside the try on purpose: a temp file that cannot be created is not a
  // failed dump, there is nothing to clean up and nothing was spawned.
  const handle = await open(tmpPath, 'w');
  const out = handle.createWriteStream();

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const proc = spawn('pg_dump', [...PG_DUMP_ARGS, opts.databaseUrl], {
      env: { ...process.env, PGSSLMODE: opts.pgSslMode },
    });
    // Published to the outer scope so the catch can stop a child that a later
    // line failed to wire up.
    child = proc;

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exited = new Promise<void>((resolve, reject) => {
      proc.on('error', (err) => reject(err));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_dump exit=${code}: ${stderr}`));
      });
    });

    // `pipeline` awaits the write stream's `finish`, so the file is fully
    // flushed before this resolves. Run it alongside the exit watcher: a
    // nonzero exit closes stdout, ending the pipeline, and the exit rejection
    // surfaces the stderr reason. Nothing above may await, or `exited` would
    // sit unobserved long enough for its rejection to crash the process.
    await Promise.all([pipeline(proc.stdout, out), exited]);
  } catch (err) {
    // Deterministic cleanup: stop the child and tear down the write stream so a
    // spawn error or a hung dump leaks no fd or stream, then drop the temp file.
    child?.kill();
    out.destroy();
    try {
      await unlink(tmpPath);
    } catch (cleanupErr) {
      // The temp file exists by construction here, so a failed removal is a
      // real fault worth surfacing. Both reasons ride the message because the
      // cron-status recorder reads only `err.message`; `cause` additionally
      // keeps the dump error itself, and so its `code`, reachable to a
      // programmatic caller.
      throw new Error(
        `${errorMessage(err)} (temp file cleanup failed: ${errorMessage(cleanupErr)})`,
        { cause: err },
      );
    }
    throw err;
  }

  await rename(tmpPath, opts.outPath);
}
