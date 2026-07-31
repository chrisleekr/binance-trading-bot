// Env fields more than one process reads, and the loader boilerplate around
// them.
//
// WHY: `apps/api` and `apps/worker` each declared DATABASE_URL, REDIS_URL,
// PGSSLMODE, BACKUP_DIR, and GIT_SHA independently, with a byte-identical
// six-literal sslmode enum and a byte-identical safeParse-and-throw block. The
// worker's own comments admitted it ("Mirrors the api's PGSSLMODE enum"). Since
// `apps/server` under ROLE=all runs both loaders in one process, a drifted
// default no longer means two processes disagree — it means two halves of one
// process disagree about the same `pg_dump`. One definition, one place.

import { z } from 'zod';

/**
 * libpq sslmode values, in libpq's own order. `prefer` matches libpq's default;
 * tighten to `require` or `verify-full` when Postgres is TLS-fronted.
 */
export const PG_SSL_MODES = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const;

export type PgSslMode = (typeof PG_SSL_MODES)[number];

/**
 * Shape of {@link sharedEnvFields}. Spelled out because `isolatedDeclarations`
 * cannot infer an exported zod shape, and the flag stays on for the rest of
 * `@app/core`.
 */
export interface SharedEnvFields {
  readonly DATABASE_URL: z.ZodString;
  readonly REDIS_URL: z.ZodString;
  readonly PGSSLMODE: z.ZodDefault<z.ZodEnum<{ [K in PgSslMode]: K }>>;
  readonly BACKUP_DIR: z.ZodDefault<z.ZodString>;
  readonly GIT_SHA: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}

/**
 * The fields every process reads. Spread into a process-specific `z.object`
 * rather than exported as a schema so each app keeps one flat schema it can
 * `.refine()` over.
 */
export const sharedEnvFields: SharedEnvFields = {
  /**
   * Postgres connection string. No default: a missing value must crash boot
   * rather than silently connect to `localhost`, the bug a `??` fallback hides.
   */
  DATABASE_URL: z.string().min(1),
  /** Redis connection string (BullMQ-grade, ioredis). No default, same reason. */
  REDIS_URL: z.string().min(1),
  /** libpq sslmode passed to `pg_dump` / `pg_restore`. */
  PGSSLMODE: z.enum(PG_SSL_MODES).default('prefer'),
  /**
   * Directory the `db-backup` cron writes `backup-<epochMillis>.dump` files to
   * and the api's backup-status route lists. Default matches the compose volume
   * mount; the cron `mkdir -p`s it.
   */
  BACKUP_DIR: z.string().default('/backups'),
  /**
   * Build SHA injected by the Docker build-arg. Empty in dev/no-arg builds,
   * where boot falls back to the local git SHA (or 'unknown'). Surfaced on
   * `/status` so the operator can spot api/worker code skew.
   */
  GIT_SHA: z.string().optional().default(''),
};

/**
 * Parse a boolean deployment flag from an env string. Only the literal `1` or
 * `true` (case-insensitive) reads as true; every other value, `false`, `0`, and
 * unset included, reads as false. Explicit rather than `z.coerce.boolean()`,
 * which treats every non-empty string (even the string `'false'`) as true.
 */
export const booleanEnvFlag = (): z.ZodType<boolean, string | undefined> =>
  z
    .string()
    .optional()
    .transform((v) => v === '1' || v?.toLowerCase() === 'true');

/**
 * Parse `raw` against `schema`, or throw with every zod issue flattened into one
 * operator-actionable line. `label` names the process so a ROLE=all boot, which
 * runs both loaders, says which one rejected.
 */
export const parseEnvOrThrow = <T>(
  schema: { safeParse(v: unknown): z.ZodSafeParseResult<T> },
  raw: unknown,
  label: string,
): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${label} environment: ${detail}`);
  }
  return parsed.data;
};
