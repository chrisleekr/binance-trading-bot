// CLI to reset a Better Auth user's password from the host. The whole point is
// recovery without an in-app form: a v1.0 deployment has no second factor that
// could authorise a "forgot password" flow, so the operator runs this from the
// container shell and reads the cleartext from stdout once.
//
// Usage:
//   bun run reset-password --email <email>
//
// Exit codes:
//   0 — success; cleartext printed
//   1 — uncaught error (config / db connection / Better Auth failure)
//   2 — missing or malformed --email
//   3 — no Better Auth user with that email

import { randomBytes } from 'node:crypto';

import { type UserId } from '@app/contracts';
import { createDb, createPool, repo, type Database } from '@app/db';
import { sql } from 'drizzle-orm';

import { createAuth, type Auth } from '../src/auth.js';
import { loadEnv } from '../src/env.js';
import { errorMessage } from '@app/core/error';

const PASSWORD_BYTES = 24;

const generatePassword = (): string => randomBytes(PASSWORD_BYTES).toString('base64url');

const parseEmail = (argv: readonly string[]): string | null => {
  const i = argv.indexOf('--email');
  if (i === -1 || i + 1 >= argv.length) return null;
  const value = argv[i + 1];
  if (!value || !value.includes('@')) return null;
  return value.toLowerCase();
};

export type ResetPasswordFailure = 'no-user' | 'no-credential-row';

// Typed error so callers (CLI today, future HTTP endpoint, integration tests)
// can branch on the recoverable cases without parsing stderr. Anything not
// matching these reasons propagates as a generic Error.
export class ResetPasswordError extends Error {
  readonly reason: ResetPasswordFailure;

  constructor(reason: ResetPasswordFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'ResetPasswordError';
  }
}

// Inputs to runReset: a db handle and a Better Auth instance. The CLI builds
// these from env at boot; integration tests reuse their own fixture so the
// rotation happens in-process against the same connection the test verifies
// against — no child-process spawn + stdout parsing.
export interface ResetDeps {
  readonly db: Database;
  readonly auth: Auth;
}

export interface ResetResult {
  readonly email: string;
  readonly newPassword: string;
  readonly userId: UserId;
}

// Core reset routine. Generates a fresh cleartext, hashes through Better Auth
// so the column matches what sign-up would have written, updates the account
// row via raw SQL (Better Auth owns that schema), and appends an audit row.
export const runReset = async (deps: ResetDeps, email: string): Promise<ResetResult> => {
  const domainUser = await repo.users.findByEmail(deps.db, email);
  if (!domainUser) {
    throw new ResetPasswordError('no-user', `no user with email ${email}`);
  }

  const ctx = await deps.auth.$context;
  const newPassword = generatePassword();
  const hash = await ctx.password.hash(newPassword);

  // Single transaction so a failed audit write rolls back the password
  // rotation. Otherwise the operator sees an error after the password
  // has already moved, retries, and ends up with two valid cleartexts
  // floating around (the first one was already printed-or-discarded
  // on the failed path, and the retry generates a fresh one).
  await deps.db.transaction(async (tx) => {
    // Better Auth owns the account schema; raw SQL avoids a duplicate
    // drizzle declaration inside @app/db.
    const updated = await tx.execute(sql`
      update "account"
      set password = ${hash}, "updatedAt" = now()
      where "userId" = ${domainUser.id} and "providerId" = 'credential'
    `);
    if (updated.rowCount === 0) {
      throw new ResetPasswordError(
        'no-credential-row',
        `user ${email} has no credential account row (oauth-only?)`,
      );
    }

    // tx is structurally a Database at runtime; drizzle's PgTransaction
    // generic is invariant against NodePgDatabase so an explicit cast is
    // needed to feed it to repo helpers typed on Database.
    await repo.auditLogs.append(tx as unknown as Database, domainUser.id, {
      actor: 'cli',
      event: 'reset-password-cli',
      ip: null,
      userAgent: null,
      payload: null,
    });
  });

  return { email, newPassword, userId: domainUser.id };
};

interface RunDeps {
  readonly env: ReturnType<typeof loadEnv>;
  readonly out: { write(s: string): void };
  readonly err: { write(s: string): void };
}

// CLI orchestrator. Owns the pool lifecycle and the exit-code contract;
// delegates the actual rotation to runReset.
export const runResetPassword = async (email: string, deps: RunDeps): Promise<number> => {
  const pool = createPool({ kind: 'admin', connectionString: deps.env.DATABASE_URL });
  const db = createDb(pool);
  try {
    const auth = createAuth({
      db,
      webOrigins: deps.env.WEB_ORIGIN,
      authSecret: deps.env.AUTH_SECRET,
      isProduction: deps.env.NODE_ENV === 'production',
    });
    const result = await runReset({ db, auth }, email);
    deps.out.write(`${result.newPassword}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ResetPasswordError) {
      deps.err.write(`reset-password: ${err.message}\n`);
      return 3;
    }
    throw err;
  } finally {
    await pool.end();
  }
};

export const _testing = { generatePassword, parseEmail };

const main = async (): Promise<void> => {
  const email = parseEmail(process.argv.slice(2));
  if (!email) {
    process.stderr.write('reset-password: usage: bun run reset-password --email <email>\n');
    process.exit(2);
  }
  const env = loadEnv(process.env);
  const code = await runResetPassword(email, { env, out: process.stdout, err: process.stderr });
  process.exit(code);
};

const invokedDirectly =
  typeof process !== 'undefined' && process.argv[1]?.endsWith('reset-password.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`reset-password: ${errorMessage(err)}\n`);
    process.exit(1);
  });
}
