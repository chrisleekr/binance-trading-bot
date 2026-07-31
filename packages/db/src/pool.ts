import { Pool, type PoolConfig } from 'pg';

// v1.0 connects directly to Postgres via the `pg` driver.
// Production deferral: PgBouncer / PgCat (transaction pooling) becomes worthwhile
// only beyond ~5 worker replicas; v1.0 ships single-replica so direct pooling is
// sufficient. When that day comes, point `connectionString` at the pooler URL;
// no other code changes needed.
export type PoolKind = 'api' | 'worker' | 'admin';

export interface CreatePoolOptions {
  kind: PoolKind;
  connectionString: string;
}

const DEFAULT_MAX: Record<PoolKind, number> = {
  api: 10,
  worker: 25,
  admin: 2,
};

const envMaxFor = (kind: PoolKind): number | null => {
  const raw =
    kind === 'api'
      ? process.env['API_DB_POOL_MAX']
      : kind === 'worker'
        ? process.env['WORKER_DB_POOL_MAX']
        : process.env['ADMIN_DB_POOL_MAX'];
  if (raw === undefined || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid pool size for ${kind} pool (env value "${raw}"): expected a positive integer`,
    );
  }
  return parsed;
};

export const createPool = ({ kind, connectionString }: CreatePoolOptions): Pool => {
  const max = envMaxFor(kind) ?? DEFAULT_MAX[kind];
  const config: PoolConfig = {
    connectionString,
    max,
    application_name: `binance-${kind}`,
    idleTimeoutMillis: 30_000,
  };
  return new Pool(config);
};
