// Boot primitives: the connections every other builder reads.
//
// These have no cross-subsystem dependency, so they are constructed first and
// threaded down into every subsequent builder. `buildLogger` lives here because
// it is the first primitive and the pino redaction policy belongs next to the
// connections it logs; boot-context re-exports it for callers/tests. The BullMQ
// queue set is NOT built here: it opens per-queue producer connections, so the
// composer mints it AFTER the live-demo guard to keep the abort path connectionless.

import pino, { type DestinationStream, type Logger } from 'pino';
import { type ConnectionOptions } from 'bullmq';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

import { scrubDrizzleParams } from '@app/core/logger';
import { createBullMQConnection, createDb, createPool, createRedis, type Database } from '@app/db';

import type { BootEnv } from '../boot-env.js';

/**
 * The `err` serializer this logger installs: pino's own, followed by a pass that strips drizzle's bound query parameters out of the result.
 *
 * The identity check is what keeps the passthrough intact. pino's serializer returns the SAME reference when handed something that is not error-like — a plain `{ code: -1013 }` from the Binance client, say — and that value belongs to the caller, so scrubbing it would mutate a live object the job is still using. Only a value the serializer actually built is ours to edit.
 *
 * @param e - Whatever was logged under the `err` key, error-like or not.
 * @returns The serialized record with any bind values redacted, or the original value untouched when pino declined to serialize it.
 */
const errSerializer = (e: unknown): unknown => {
  const serialized: unknown = pino.stdSerializers.err(e as Error);
  return serialized === e ? serialized : scrubDrizzleParams(serialized);
};

export const buildLogger = (level: string | undefined, destination?: DestinationStream): Logger =>
  pino(
    {
      level: level ?? 'info',
      serializers: { err: errSerializer },
      redact: {
        paths: [
          'key',
          'secret',
          'apiKey',
          'apiSecret',
          'password',
          'token',
          'oauthToken',
          'Authorization',
          'authorization',
          '*.password',
          '*.oldPassword',
          '*.newPassword',
          '*.secret',
          '*.key',
          '*.apiKey',
          '*.apiSecret',
          '*.token',
          '*.oauthToken',
          '*.authorization',
          'req.headers.cookie',
          'req.headers.authorization',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );

export interface Primitives {
  readonly logger: Logger;
  readonly bullConn: ConnectionOptions;
  readonly redis: Redis;
  readonly pool: Pool;
  readonly db: Database;
  readonly liveDemo: boolean;
}

/**
 * Logger, the BullMQ connection options, ioredis client, pg pool, db, and the
 * live-demo flag. The live-demo guard that reads `db` stays in the composer,
 * before any subsystem builder, so a live-key box refuses to boot before it
 * wires anything. The queue set is minted in the composer after that guard.
 */
export const buildPrimitives = (env: BootEnv): Primitives => {
  const logger = buildLogger(env.logLevel);
  const bullConn: ConnectionOptions = createBullMQConnection({ url: env.redisUrl });
  const redis = createRedis(env.redisUrl).raw();
  const pool = createPool({ kind: 'worker', connectionString: env.pgUrl });
  const db = createDb(pool);
  const liveDemo = env.liveDemo ?? false;
  return { logger, bullConn, redis, pool, db, liveDemo };
};
