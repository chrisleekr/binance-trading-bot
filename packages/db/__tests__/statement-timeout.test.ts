// Unit cover for the pure half of the statement-timeout helper.
//
// The classifier decides whether a cancelled query is reported as a timeout or as an ordinary fault, and every outcome count built on it inherits that decision. It is a pure function over an error shape, so it does not need Postgres, and gating it behind a database URL would leave it unproven on every workstation and in every lane but one.

import { describe, expect, it } from 'vitest';
import { isStatementTimeout, withStatementTimeout } from '../src/statement-timeout.js';
import type { Database } from '../src/repo/_db.js';

/** The shape drizzle actually throws: a wrapper carrying the driver error on `cause`, which is why the classifier walks the chain instead of reading the top level. */
const wrapped = (code: string): Error =>
  new Error('Failed query', { cause: Object.assign(new Error('driver'), { code }) });

describe('isStatementTimeout', () => {
  it('finds SQLSTATE 57014 one level down in the cause chain', () => {
    expect(isStatementTimeout(wrapped('57014'))).toBe(true);
  });

  it('does not read a different SQLSTATE as a timeout', () => {
    // 42P01 is undefined_table. A classifier that answered true here would relabel every broken query a timeout and the outcome counts would be fiction.
    expect(isStatementTimeout(wrapped('42P01'))).toBe(false);
  });

  it('returns false for a value that is not an error object', () => {
    expect(isStatementTimeout('57014')).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
    expect(isStatementTimeout(undefined)).toBe(false);
  });

  it('stops walking past the depth bound', () => {
    // The companion to the cycle case below, and the one that regresses READABLY: removing the bound turns this false into true, which fails here as an assertion, whereas the cycle case would regress as a synchronous loop that never yields, so vitest's own timeout timer never fires and the run wedges until CI kills the job.
    let deep: Error = Object.assign(new Error('driver'), { code: '57014' });
    for (let i = 0; i < 12; i += 1) deep = new Error('wrapper', { cause: deep });

    expect(isStatementTimeout(deep)).toBe(false);
  });

  it('terminates on a self-referencing cause chain', () => {
    // A cycle is reachable from any code that sets `cause` to a shared error, and an unbounded walk would hang the sweep inside its own catch block rather than counting the profile.
    const loop = new Error('cycle');
    Object.defineProperty(loop, 'cause', { value: loop });

    expect(isStatementTimeout(loop)).toBe(false);
  });
});

describe('withStatementTimeout argument guards', () => {
  // A pool-backed handle is identified by `$client`, which the node-postgres driver assigns only on the handle it creates from a pool.
  const poolHandle = { $client: {}, transaction: async () => undefined } as unknown as Database;

  // Zero is the dangerous case: a caller deriving the budget from an unset config value would otherwise emit a valid statement, apply no bound at all, and report nothing, because Postgres reads `statement_timeout = 0` as no limit. The rest pin the other half of the guard — dropping `Number.isSafeInteger` leaves the zero case green on its own.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a budget of %s',
    async (ms) => {
      await expect(withStatementTimeout(poolHandle, ms, async () => undefined)).rejects.toThrow(
        /positive safe integer/,
      );
    },
  );

  it('refuses a handle that is not pool-backed', async () => {
    // Nested, drizzle opens a SAVEPOINT, and releasing a savepoint does not revert a transaction-local setting, so the budget would silently bind the rest of the caller's transaction.
    const txHandle = { transaction: async () => undefined } as unknown as Database;

    await expect(withStatementTimeout(txHandle, 1_000, async () => undefined)).rejects.toThrow(
      /pool-backed/,
    );
  });
});
