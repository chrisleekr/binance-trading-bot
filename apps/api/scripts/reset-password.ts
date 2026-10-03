// CLI to recover the operator account from the host. There is no email and no in-app second factor that could authorise a "forgot password" flow, so the operator runs this from the container shell and reads the new password from stdout once.
//
// Usage:
//   bun run reset-password --email <email> [--unlink-single-sign-on]
//   bun run reset-password --email <email> --clear-lockout
//
// Default: sets a new random password (creating the password sign-in if the operator only had single sign-on), signs out every session and AI agent everywhere, and lifts any sign-in lockout.
// --unlink-single-sign-on: also removes the linked single sign-on identity, for when that identity itself is compromised or lost.
// --clear-lockout: only lifts the lockout, the site-wide backoff and every address block; the password is unchanged.
//
// Exit codes:
//   0: success; also when the password changed but a step after the commit (lockout clear, live-connection notice, alert) failed, because the old password is already gone and the printed one is the only way in, so a non-zero exit must not tempt a wrapper into discarding stdout. Those failures are printed to stderr as warnings.
//   1: uncaught error (config / db connection)
//   2: missing or malformed arguments
//   3: no operator with that email
//   4: --clear-lockout could not delete the lockout keys (Redis unreachable)

import { randomBytes } from 'node:crypto';

import { asUserId, type UserId } from '@app/contracts';
import { createBullMQConnection, createDb, createPool, repo, type Database } from '@app/db';
import { createMetricsRegistry } from '@app/observability';
import { errorMessage } from '@app/core/error';
import { Queue } from 'bullmq';
import { hashPassword } from 'better-auth/crypto';
import { Redis } from 'ioredis';
import { pino, type Logger } from 'pino';

import {
  createRedisRateLimiter,
  deleteKeysWithPrefix,
  type RateLimiter,
} from '../src/auth/rate-limit.js';
import { publishSessionRevocationOn } from '../src/auth/session-revocation.js';
import { createSecurityServices, type SecurityServices } from '../src/auth/security.js';
import { WEBSOCKET_REVALIDATE_MS } from '../src/ws/session-watch.js';
import { normalizeEmail } from '../src/auth/sign-in-protection.js';
import { loadEnv } from '../src/env.js';

const PASSWORD_BYTES = 24;
// Bounds each step after the commit. BullMQ waits for a ready connection before it sends anything, so with Redis unreachable the alert's enqueue never settles, and the command must still finish and print the password.
const AFTER_COMMIT_STEP_TIMEOUT_MS = 5_000;

const generatePassword = (): string => randomBytes(PASSWORD_BYTES).toString('base64url');

/** What the operator asked for. */
export interface ResetOptions {
  readonly email: string;
  readonly unlinkSingleSignOn: boolean;
  readonly clearLockoutOnly: boolean;
}

/**
 * Reads the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The options, or null when `--email` is missing or malformed or the flags contradict each other.
 */
const parseArgs = (argv: readonly string[]): ResetOptions | null => {
  const i = argv.indexOf('--email');
  if (i === -1 || i + 1 >= argv.length) return null;
  const value = argv[i + 1];
  if (!value || !value.includes('@')) return null;
  const unlinkSingleSignOn = argv.includes('--unlink-single-sign-on');
  const clearLockoutOnly = argv.includes('--clear-lockout');
  if (unlinkSingleSignOn && clearLockoutOnly) return null;
  return { email: normalizeEmail(value), unlinkSingleSignOn, clearLockoutOnly };
};

export type ResetPasswordFailure = 'no-user' | 'lockout-not-cleared';

/** Typed so callers can branch on the recoverable case without parsing stderr. */
export class ResetPasswordError extends Error {
  readonly reason: ResetPasswordFailure;

  constructor(reason: ResetPasswordFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'ResetPasswordError';
  }
}

/** What the recovery needs. The CLI builds these from the environment; tests pass their fixture's. */
export interface ResetDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly security: SecurityServices;
}

export interface ResetResult {
  readonly email: string;
  /** Null for `--clear-lockout`, which leaves the password alone. */
  readonly newPassword: string | null;
  readonly userId: UserId;
  readonly singleSignOnUnlinked: boolean;
  /** Steps that failed without undoing the recovery, for stderr. Empty when everything succeeded. */
  readonly warnings: readonly string[];
}

/**
 * Recovers the operator account.
 *
 * Deliberately never constructs Better Auth: with single sign-on configured that would start provider discovery, and a hung identity provider must not be able to block the one recovery path that does not depend on it. The hash comes from Better Auth's own `hashPassword`, the same function its sign-up uses by default, so sign-in verifies it unchanged.
 *
 * The credential write, the security epoch bump and the removal of every session and agent grant commit together: a password reset that left an intruder's session or agent token alive would not be a recovery. Lockout keys, the revocation message and the alert follow the commit and cannot undo it, so their failures become warnings instead of errors: throwing after the commit would hide the new password while the old one is already gone.
 *
 * @param deps - Database, Redis and the sign-in services.
 * @param options - Which operator and which recovery.
 * @returns The new password (printed once by the CLI), what changed, and the warnings for steps that failed after the commit.
 * @throws ResetPasswordError `no-user` for an unknown email, or `lockout-not-cleared` when a lockout-only run could not reach Redis.
 */
export const runReset = async (deps: ResetDeps, options: ResetOptions): Promise<ResetResult> => {
  const operator = await repo.authIdentity.findSoleUser(deps.db);
  if (operator === null || normalizeEmail(operator.email) !== options.email) {
    throw new ResetPasswordError('no-user', `no operator with email ${options.email}`);
  }
  const userId = asUserId(operator.id);

  const warnings: string[] = [];
  // A new password is useless while the old one's lockout still runs, so every recovery lifts it. The reset raises its own alert; only a lockout-only run needs one of its own.
  try {
    await deps.security.protection.clearLockout(options.email);
  } catch (err) {
    // A lockout-only run changed nothing else, so failing it outright is safe and honest. A full reset still rotates the password: the operator needs it, and the lockout can be cleared again once Redis is back.
    if (options.clearLockoutOnly)
      throw new ResetPasswordError(
        'lockout-not-cleared',
        `could not clear the sign-in lockout: ${errorMessage(err)}`,
      );
    warnings.push(
      `the sign-in lockout could not be cleared (${errorMessage(err)}); run again with --clear-lockout once Redis is reachable`,
    );
  }
  if (options.clearLockoutOnly) {
    await deps.security.events.record({
      event: 'account-lockout-cleared',
      actor: 'cli',
      method: 'cli',
    });
    return {
      email: options.email,
      newPassword: null,
      userId,
      singleSignOnUnlinked: false,
      warnings,
    };
  }

  const newPassword = generatePassword();
  const hash = await hashPassword(newPassword);
  let singleSignOnUnlinked = false;
  await deps.db.transaction(async (raw) => {
    // drizzle's transaction type is invariant against the pool type the repo functions accept; at runtime it is the same interface.
    const tx = raw as unknown as Database;
    // A failed onboarding hook can leave the sign-in user without its domain row, which every account-scoped route needs. Recovery is where that gets repaired.
    if ((await repo.users.findById(tx, userId)) === null) {
      await repo.users.insert(tx, userId, {
        email: operator.email,
        displayName: operator.name,
        emailVerifiedAt: null,
        disabledAt: null,
      });
      await repo.accounts.create(tx, userId, { name: 'Main', binanceMode: 'test' });
    }
    await repo.authIdentity.upsertPasswordCredential(tx, operator.id, hash);
    if (options.unlinkSingleSignOn)
      singleSignOnUnlinked =
        (await repo.authIdentity.deleteSingleSignOnIdentities(tx, operator.id)) > 0;
    await repo.authSecuritySettings.bumpSecurityEpoch(tx);
    await repo.authIdentity.deleteAllSessions(tx, operator.id);
    await repo.authIdentity.revokeAgentAccess(tx, operator.id, new Date());
  });
  deps.security.settings.invalidate();

  // Everything below runs after the commit, so a failure or a hang is reported and never thrown.
  const afterCommit = async (failure: string, step: () => Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${AFTER_COMMIT_STEP_TIMEOUT_MS / 1000} seconds`)),
        AFTER_COMMIT_STEP_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([step(), deadline]);
    } catch (err) {
      warnings.push(`${failure} (${errorMessage(err)})`);
    } finally {
      clearTimeout(timer);
    }
  };
  await afterCommit(
    `running api replicas could not be told to close live connections; their WebSocket revalidation closes them within ${WEBSOCKET_REVALIDATE_MS / 1000} seconds regardless`,
    () => publishSessionRevocationOn(deps.redis, { userId: operator.id, exceptSessionIds: [] }),
  );
  await afterCommit(
    'the security event for the reset could not be confirmed as recorded and notified',
    () => deps.security.events.record({ event: 'reset-password-cli', actor: 'cli', method: 'cli' }),
  );
  if (singleSignOnUnlinked)
    await afterCommit(
      'the security event for the single sign-on unlink could not be confirmed as recorded and notified',
      () =>
        deps.security.events.record({
          event: 'single-sign-on-unlinked-by-cli',
          actor: 'cli',
          method: 'cli',
        }),
    );
  return { email: options.email, newPassword, userId, singleSignOnUnlinked, warnings };
};

/**
 * The sign-in limiter for the recovery command. The server's limiter falls back to process memory when Redis fails, which is right for a request but wrong here: the CLI process exits straight after, so a fallback would delete nothing and still report the lockout as cleared. Deletion therefore goes to Redis directly and throws on failure; the other operations are the server's, unused by the command.
 *
 * @param redis - The command's connection.
 * @param logger - Where the unused operations would log a fallback.
 * @returns A limiter whose `clear` and `clearPrefix` fail loudly.
 */
const createRecoveryLimiter = (redis: Redis, logger: Logger): RateLimiter => ({
  ...createRedisRateLimiter(redis, () => undefined, logger),
  async clear(keys) {
    if (keys.length > 0) await redis.del(...keys);
  },
  clearPrefix: (prefix) => deleteKeysWithPrefix(redis, prefix),
});

export interface RunDeps {
  readonly env: ReturnType<typeof loadEnv>;
  readonly out: { write(s: string): void };
  readonly err: { write(s: string): void };
}

/**
 * CLI orchestrator. Owns the connections and the exit-code contract; the recovery itself is {@link runReset}.
 *
 * @param options - Parsed arguments.
 * @param deps - Environment and output streams.
 * @returns The process exit code.
 */
export const runResetPassword = async (options: ResetOptions, deps: RunDeps): Promise<number> => {
  const pool = createPool({ kind: 'admin', connectionString: deps.env.DATABASE_URL });
  const db = createDb(pool);
  const redis = new Redis(deps.env.REDIS_URL, { maxRetriesPerRequest: 1 });
  // A failing command rejects and is reported as a warning; without a listener ioredis would also print every reconnect error.
  redis.on('error', () => undefined);
  // One retry, not the BullMQ default of unlimited: the alert is best-effort here, and an unreachable Redis must not hang the command after the password has changed.
  const queue = new Queue('pipeline', {
    connection: { ...createBullMQConnection({ url: deps.env.REDIS_URL }), maxRetriesPerRequest: 1 },
  });
  queue.on('error', () => undefined);
  // Warnings only, to stderr, so stdout carries nothing but the password.
  const logger = pino({ level: 'warn' }, process.stderr);
  try {
    const security = createSecurityServices({
      db,
      redis,
      queue,
      logger,
      registry: createMetricsRegistry({ service: 'reset-password' }).registry,
      secret: deps.env.AUTH_SECRET,
      singleSignOn: null,
      passwordSignIn: deps.env.PASSWORD_SIGN_IN_ENABLED,
      limiter: createRecoveryLimiter(redis, logger),
    });
    const result = await runReset({ db, redis, security }, options);
    if (result.newPassword !== null) deps.out.write(`${result.newPassword}\n`);
    else deps.err.write('reset-password: sign-in lockout cleared; the password is unchanged\n');
    for (const warning of result.warnings) deps.err.write(`reset-password: warning: ${warning}\n`);
    if (result.newPassword !== null && !deps.env.PASSWORD_SIGN_IN_ENABLED) {
      deps.err.write(
        'reset-password: password sign-in is turned off; set PASSWORD_SIGN_IN_ENABLED=1 and restart before this password can be used\n',
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof ResetPasswordError) {
      deps.err.write(`reset-password: ${err.message}\n`);
      return err.reason === 'no-user' ? 3 : 4;
    }
    throw err;
  } finally {
    await queue.close();
    await redis.quit();
    await pool.end();
  }
};

export const _testing = { generatePassword, parseArgs, createRecoveryLimiter };

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      'reset-password: usage: reset-password --email <email> [--unlink-single-sign-on | --clear-lockout]\n',
    );
    process.exit(2);
  }
  const env = loadEnv(process.env);
  const code = await runResetPassword(options, { env, out: process.stdout, err: process.stderr });
  process.exit(code);
};

// Matches the source in development and the bundle the production image ships at /app/dist/reset-password.js; tests import this module and must not run main.
const invokedDirectly =
  typeof process !== 'undefined' && /reset-password\.(ts|js)$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`reset-password: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
