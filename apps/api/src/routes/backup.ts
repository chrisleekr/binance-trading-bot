import {
  BackupConfigPut,
  type BackupConfigResponse as BackupConfigResponseType,
  BackupConfigResponse,
  type BackupFileInfo,
  ErrorEnvelope,
  RestoreResponse,
} from '@app/contracts';
import { PG_DUMP_ARGS } from '@app/core/backup';
import { repo } from '@app/db';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stream } from 'hono/streaming';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { restoreBodyLimit } from 'middleware/body-limit.js';
import { createApiHono, type ApiHono } from 'types.js';

const HOUR_MS = 3_600_000;
const MAX_RECENT_BACKUPS = 20;
// Worker names every dump `backup-<epochMillis>.dump`; the captured group is the
// timestamp used to sort newest-first without a stat round-trip per compare.
const BACKUP_FILE_RE = /^backup-(\d+)\.dump$/;

/**
 * Lists the most recent on-disk dumps newest-first. A missing BACKUP_DIR means
 * no scheduled backup has run yet, which is a normal cold-start state, so ENOENT
 * yields an empty list rather than a 500. Other read errors propagate.
 */
const listRecentBackups = async (dir: string): Promise<BackupFileInfo[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const matched = names
    .map((name) => {
      const m = BACKUP_FILE_RE.exec(name);
      return m ? { name, ts: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; ts: number } => x !== null)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_RECENT_BACKUPS);
  // The worker's prune can unlink a dump between readdir and stat, so a per-file
  // stat ENOENT is benign (the file is simply gone now) and yields null rather
  // than 500ing the whole listing. Other stat errors still propagate.
  const stats = await Promise.all(
    matched.map(async ({ name }) => {
      try {
        const s = await stat(join(dir, name));
        return { name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    }),
  );
  return stats.filter((x): x is BackupFileInfo => x !== null);
};

/**
 * Assembles the backup-config response from the stored singleton plus on-disk
 * dumps. Shared by GET (read) and PUT (post-write) so both report identically.
 * `nextDueAt` is null when disabled or before the first run; otherwise the last
 * run plus the configured interval.
 */
const buildBackupConfigResponse = async (di: DI): Promise<BackupConfigResponseType> => {
  const cfg = await repo.backupConfig.get(di.db);
  const nextDueAt =
    !cfg.enabled || cfg.lastBackupAt === null
      ? null
      : new Date(cfg.lastBackupAt.getTime() + cfg.intervalHours * HOUR_MS).toISOString();
  return {
    enabled: cfg.enabled,
    intervalHours: cfg.intervalHours,
    retentionCount: cfg.retentionCount,
    lastBackupAt: cfg.lastBackupAt === null ? null : cfg.lastBackupAt.toISOString(),
    nextDueAt,
    recentBackups: await listRecentBackups(di.env.BACKUP_DIR),
  };
};

const getConfigRoute = createRoute({
  method: 'get',
  path: '/backup/config',
  tags: ['backup'],
  responses: {
    200: {
      description: 'backup config + status',
      content: { 'application/json': { schema: BackupConfigResponse } },
    },
  },
});

const putConfigRoute = createRoute({
  method: 'put',
  path: '/backup/config',
  tags: ['backup'],
  request: {
    body: { content: { 'application/json': { schema: BackupConfigPut } } },
  },
  responses: {
    200: {
      description: 'updated config + status',
      content: { 'application/json': { schema: BackupConfigResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const backupRoute = createRoute({
  method: 'get',
  path: '/backup',
  tags: ['backup'],
  responses: {
    200: { description: 'pg_dump custom format stream' },
  },
});

const restoreRoute = createRoute({
  method: 'post',
  path: '/restore',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ archive: z.any() }),
        },
      },
    },
  },
  tags: ['backup'],
  responses: {
    200: { description: 'restored', content: { 'application/json': { schema: RestoreResponse } } },
    422: {
      description: 'no archive uploaded',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const runChild = (
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin?: Buffer,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args], { env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit=${code}: ${stderr}`));
    });
    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });

export const backupRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/backup', requireUser());
  app.use('/backup/config', requireUser());
  app.use('/restore', requireUser());
  // pg_dump/pg_restore carry every secret and restore is destructive — off in demo.
  app.use('/backup', requireNotDemo(di));
  app.use('/backup/config', requireNotDemo(di));
  app.use('/restore', requireNotDemo(di));
  // THIRD, and the order is the whole point. The global cap in `app.ts` stands aside for this path, so the archive-sized ceiling is imposed here instead — after both guards. `bodyLimit` READS a chunked body to count it, so a cap mounted ahead of `requireUser` would let an anonymous caller make the process buffer gigabytes; mounted here, that caller is answered 401 before anything touches `c.req.raw.body`.
  app.use('/restore', restoreBodyLimit());

  app.openapi(getConfigRoute, async (c) => {
    c.set('auditEvent', { event: 'get-backup-config' });
    return c.json(await buildBackupConfigResponse(di), 200);
  });

  // No worker resync: the backup cron reads the `backup_config` row each cycle.
  app.openapi(putConfigRoute, async (c) => {
    const body = c.req.valid('json');
    await repo.backupConfig.upsert(di.db, body);
    c.set('auditEvent', {
      event: 'set-backup-config',
      payload: {
        enabled: body.enabled,
        intervalHours: body.intervalHours,
        retentionCount: body.retentionCount,
      },
    });
    return c.json(await buildBackupConfigResponse(di), 200);
  });

  // pg_dump streams its custom-format archive on stdout. We pipe straight to
  // the HTTP response. The API container ships postgresql17-client (cross-link
  // to phase 13).
  app.openapi(backupRoute, async (c) => {
    c.header('content-type', 'application/octet-stream');
    c.header('content-disposition', `attachment; filename="backup-${Date.now()}.dump"`);
    c.set('auditEvent', { event: 'backup-download' });
    const url = new URL(di.env.DATABASE_URL);
    return stream(c, async (s) => {
      const child = spawn('pg_dump', [...PG_DUMP_ARGS, di.env.DATABASE_URL], {
        env: { ...process.env, PGSSLMODE: di.env.PGSSLMODE },
      });
      void url; // url used for documentation; pg_dump consumes the connection string directly.
      let errBuf = '';
      child.stderr.on('data', (chunk: Buffer) => {
        errBuf += chunk.toString();
      });
      child.on('error', (err) => {
        di.logger.error({ err, stderr: errBuf }, 'pg_dump_failed');
        s.abort();
      });
      for await (const chunk of child.stdout) {
        await s.write(chunk as Uint8Array);
      }
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      if (child.exitCode !== 0) {
        di.logger.error({ exitCode: child.exitCode, stderr: errBuf }, 'pg_dump_nonzero');
      }
    });
  });

  // No guard on restore: the operator owns the consequences of restoring while
  // profiles are running.
  app.openapi(restoreRoute, async (c) => {
    const form = await c.req.formData();
    const file = form.get('archive');
    if (!(file instanceof File)) {
      throw new HttpError('VALIDATION_FAILED', 'archive multipart part missing');
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const dir = await mkdtemp(join(tmpdir(), 'restore-'));
    const path = join(dir, 'backup.dump');
    await writeFile(path, buf);
    try {
      await runChild(
        'pg_restore',
        ['--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', di.env.DATABASE_URL, path],
        { ...process.env, PGSSLMODE: di.env.PGSSLMODE },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    c.set('auditEvent', { event: 'restore', payload: { size: buf.byteLength } });
    return c.json({ restoredAt: new Date().toISOString() }, 200);
  });

  return app;
};
