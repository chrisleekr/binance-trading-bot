// `fees_quote_complete` is one boolean carrying two different claims: "the writer valued every commission at execution time" and "somebody later reconstructed a plausible number". The second is an estimate, and a boolean has nowhere to say so, which is why rows valued from a rate table fetched long after the fill are indistinguishable from rows valued at the fill itself.
//
// The replacement is a three-tier `fee_basis`. What this file has to prove is the BACKFILL, and that is only visible on rows written under the OLD schema — so the migrations are STAGED: everything up to the predecessor is applied, rows are seeded through the pre-migration column set, and only then is the target migration copied in and applied. A test that migrates a fresh database sees zero rows and passes under every possible derivation rule, including one that certifies everything `exact`.
//
// The derivation is a SELF-CONSISTENCY rule, not "every fee key is native", because two things a stored row cannot show make the naive reading unsound. `fees` accumulates only for MATCHED orders, so a row that silently dropped whole fills still looks native. And rows carry `fees_quote` from two retired algorithms, one that dropped the base and third-asset legs to zero and one that valued a third-asset leg at a current ticker. A row may therefore only be certified `exact` when its stored total is reproducible from its own quote-asset fee leg.
//
// Two distinctions inside that rule are worth stating, because both were got wrong first and neither is visible without real rows:
//
// - The base asset is not a third asset. Binance charges a commission in the asset the account RECEIVES, so a base-asset commission is definitionally BUY-side, and the writer returns zero for it deliberately: the cost basis already absorbed it. Subtracting only the quote key leaves the base key behind and reads every ordinary buy as if it carried an unaccounted foreign charge.
// - A third-asset leg that was never valued is not an estimate, it is a hole. When the stored total does not exceed the quote leg, the BNB charge contributed nothing at all: the row records zero fee drag on a cycle that paid some. Calling that `estimated` and letting a profit factor render off it publishes exactly the flattering bias the tier exists to stop.
//
// A base-leg row cannot reach `exact` either, and not for want of a rule: `orders[].baseCommissionNetted` is the only evidence that the cost basis really absorbed the charge, it shipped with a later migration, and it was never backfilled. The proof does not exist on these rows, so `estimated` is the strongest honest reading.

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');
const TARGET_PREFIX = 93;
const prefixOf = (name: string): number => Number.parseInt(name.slice(0, 4), 10);

interface BasisRow {
  fee_basis: string;
}

describe.skipIf(!HAS_INFRA)('trade archive fee-basis migration', () => {
  const dbName = `fee_basis_${randomUUID().replaceAll('-', '')}_test`;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  // One trade_archive row per arm of the derivation, in rule order.
  const writerProvenId = randomUUID();
  const noOrdersId = randomUUID();
  const noFeesId = randomUUID();
  const allZeroId = randomUUID();
  const quoteOnlyReproducingId = randomUUID();
  const quoteOnlyExceededId = randomUUID();
  const thirdAssetValuedId = randomUUID();
  const baseLegOnlyId = randomUUID();
  const thirdAssetUnvaluedId = randomUUID();
  const thirdAssetDroppedId = randomUUID();
  const baseLegShortId = randomUUID();
  const allZeroContradictoryId = randomUUID();
  const postWriterQuoteOnlyId = randomUUID();
  const postWriterAllZeroId = randomUUID();
  // equity_snapshots rows.
  const snapshotCompleteId = randomUUID();
  const snapshotIncompleteId = randomUUID();
  let baseUrl: string;
  let adminUrl: URL;
  let stageDir: string;
  let pool: Pool;

  const withAdmin = async (sql: string): Promise<void> => {
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const migrationNames = (): string[] =>
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

  /** Copy every migration below the target into `dir`, so a `migrate()` against it lands on the PRE-target schema. */
  const stagePredecessors = (dir: string): void => {
    for (const name of migrationNames().filter((name) => prefixOf(name) < TARGET_PREFIX)) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
    }
  };

  /** Copy the target migration into `dir`, so the NEXT `migrate()` applies exactly it. */
  const stageTarget = (dir: string): void => {
    const target = migrationNames().find((name) => prefixOf(name) === TARGET_PREFIX);
    if (!target) throw new Error(`migration ${TARGET_PREFIX} not found`);
    copyFileSync(join(MIGRATIONS_DIR, target), join(dir, target));
  };

  /** Seed the operator → account → profile chain every archive row hangs off. */
  const seedOwnership = async (target: Pool, tag: string): Promise<void> => {
    await target.query('insert into users (id, email) values ($1, $2)', [
      userId,
      `fee-basis-${tag}-${userId}@test.local`,
    ]);
    await target.query(
      "insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'account', 'test')",
      [accountId, userId],
    );
    await target.query(
      "insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state) values ($1, $2, 'profile', 'trailing-trade', '2.0.0', '{}', '{}')",
      [profileId, accountId],
    );
  };

  /**
   * One pre-migration archive row. `base`/`quote` are separate because the rule reads BOTH as jsonb keys, and `fees`/`orders` stay raw text so a malformed body can be seeded verbatim.
   */
  const archiveRow = async (
    target: Pool,
    o: {
      id: string;
      base: string;
      quote: string;
      fees: string;
      feesQuote: string;
      complete?: boolean;
      orders?: string;
    },
  ): Promise<void> => {
    await target.query(
      'insert into trade_archive (id, profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, orders, fees, fees_quote, fees_quote_complete) values ($1, $2, $3, $4, $5, 100, 110, 10, $6::jsonb, $7::jsonb, $8, $9)',
      [
        o.id,
        profileId,
        `${o.base}${o.quote}`,
        o.base,
        o.quote,
        o.orders ?? '[{"side":"SELL"}]',
        o.fees,
        o.feesQuote,
        o.complete ?? false,
      ],
    );
  };

  const readBasis = async (id: string): Promise<string | undefined> => {
    const result = await pool.query<BasisRow>('select fee_basis from trade_archive where id = $1', [
      id,
    ]);
    return result.rows[0]?.fee_basis;
  };

  const readSnapshotBasis = async (id: string): Promise<string | undefined> => {
    const result = await pool.query<BasisRow>(
      'select fee_basis from equity_snapshots where id = $1',
      [id],
    );
    return result.rows[0]?.fee_basis;
  };

  beforeAll(async () => {
    stageDir = mkdtempSync(join(HERE, '.tmp-fee-basis-mig-'));
    baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    const targetUrl = target.toString();
    await withAdmin(`create database "${dbName}"`);

    stagePredecessors(stageDir);
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
    pool = new Pool({ connectionString: targetUrl });
    await seedOwnership(pool, 'main');

    // The writer valued every commission at execution time, so its claim stands whatever the fees body looks like afterwards — a base-asset SELL commission valued at its fill price leaves a body that looks native to nothing.
    await archiveRow(pool, {
      id: writerProvenId,
      base: 'BTC',
      quote: 'USDT',
      fees: JSON.stringify({ BTC: '0.01' }),
      feesQuote: '600',
      complete: true,
    });
    // No archived orders: nothing to have charged a commission against, so there is no body to check against anything.
    await archiveRow(pool, {
      id: noOrdersId,
      base: 'SOL',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.5' }),
      feesQuote: '0.5',
      orders: '[]',
    });
    // No fee evidence at all: trade history was unavailable when the row was written.
    await archiveRow(pool, {
      id: noFeesId,
      base: 'ADA',
      quote: 'USDT',
      fees: '{}',
      feesQuote: '0',
    });
    // The escape the two certifying arms have to be closed against. `baseCommissionNetted` on an order summary is the mark of a writer that shipped after 0090, and such a writer sets the marker false only when it FOUND a gap: an order `getMyTrades` never returned, totals that did not reconcile. Its `fees_quote` still accumulates from the legs that did match, so the stored body reproduces perfectly while a whole order's commission is missing from it. Shape must not certify what the writer already refused.
    await archiveRow(pool, {
      id: postWriterQuoteOnlyId,
      base: 'AVAX',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.1' }),
      feesQuote: '0.1',
      orders: '[{"side":"SELL","baseCommissionNetted":null}]',
    });
    // The same provenance against the OTHER certifying arm, so closing one and leaving the other cannot pass.
    await archiveRow(pool, {
      id: postWriterAllZeroId,
      base: 'NEAR',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0', NEAR: '0' }),
      feesQuote: '0',
      orders: '[{"side":"SELL","baseCommissionNetted":"0"}]',
    });
    // Every commission is literally zero — a fee-free cycle. There is nothing left unaccounted, so a zero total is the complete truth about it. Note the base key: without the all-zero arm this row falls through to the base-leg reading and is demoted for a charge of zero.
    await archiveRow(pool, {
      id: allZeroId,
      base: 'USDC',
      quote: 'USDT',
      fees: JSON.stringify({ USDC: '0', USDT: '0' }),
      feesQuote: '0',
    });
    // Quote-only fees whose stored total is exactly the quote leg: the row reproduces itself.
    await archiveRow(pool, {
      id: quoteOnlyReproducingId,
      base: 'ETH',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.5' }),
      feesQuote: '0.5',
    });
    // Quote-only fees whose stored total EXCEEDS the quote leg: value came from somewhere this row no longer records, which is what the retired algorithms did.
    await archiveRow(pool, {
      id: quoteOnlyExceededId,
      base: 'DOT',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.5' }),
      feesQuote: '1.25',
    });
    // A BNB leg that WAS valued: the total exceeds the quote leg (here there is none), so some rate was applied to it. Which rate, and from when, the row does not say.
    await archiveRow(pool, {
      id: thirdAssetValuedId,
      base: 'AXS',
      quote: 'USDT',
      fees: JSON.stringify({ BNB: '0.00005' }),
      feesQuote: '0.032',
    });
    // Quote leg plus a BASE leg and nothing else. The base charge is buy-side and the cost basis is supposed to have absorbed it, but the field that would prove it was never backfilled onto these rows.
    await archiveRow(pool, {
      id: baseLegOnlyId,
      base: 'FLOKI',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.04', FLOKI: '1643.16' }),
      feesQuote: '0.04',
    });
    // A base leg beside a REAL quote commission the stored total does not include. Two live rows look exactly like this (ETHBTC, LINKUSDT). Matching base-leg rows on shape alone certifies them `estimated`; only comparing the total against the row's own quote leg separates "the cost basis absorbed the base charge" from "a charge on this row was never counted at all".
    await archiveRow(pool, {
      id: baseLegShortId,
      base: 'LINK',
      quote: 'USDT',
      fees: JSON.stringify({ USDT: '0.0328536', LINK: '0.00313' }),
      feesQuote: '0',
    });
    // All commissions recorded zero, yet the stored total is not zero. The legs cannot produce that total, so the row is contradicting itself rather than reporting a fee-free cycle, and the all-zero shortcut must not certify it.
    await archiveRow(pool, {
      id: allZeroContradictoryId,
      base: 'USDC',
      quote: 'USDT',
      fees: JSON.stringify({ USDC: '0', USDT: '0' }),
      feesQuote: '0.25',
    });
    // A BNB leg that was NEVER valued: no quote leg at all and a stored total of zero, so this cycle records no fee drag whatsoever.
    await archiveRow(pool, {
      id: thirdAssetUnvaluedId,
      base: 'XPL',
      quote: 'USDT',
      fees: JSON.stringify({ BNB: '0.00007' }),
      feesQuote: '0',
    });
    // The same hole, harder to see: a real quote leg IS recorded and the stored total equals it exactly, which means the BNB leg beside it was dropped on the floor.
    await archiveRow(pool, {
      id: thirdAssetDroppedId,
      base: 'XLM',
      quote: 'USDT',
      fees: JSON.stringify({ BNB: '0.00003', USDT: '0.0257' }),
      feesQuote: '0.0257',
    });

    const snapshot = async (id: string, complete: boolean): Promise<void> => {
      await pool.query(
        "insert into equity_snapshots (id, profile_id, quote_asset, net_pnl_quote, realized_net_quote, position_value_quote, position_cost_quote, benchmark_asset, benchmark_price_quote, fees_quote_complete) values ($1, $2, 'USDT', 10, 5, 100, 95, 'BTC', 60000, $3)",
        [id, profileId, complete],
      );
    };
    await snapshot(snapshotCompleteId, true);
    await snapshot(snapshotIncompleteId, false);

    stageTarget(stageDir);
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  });

  it("certifies a row the writer already proved as 'exact'", async () => {
    expect(await readBasis(writerProvenId)).toBe('exact');
  });

  it("certifies a cycle whose every commission is zero as 'exact'", async () => {
    // A fee-free cycle records a zero total because zero is the answer, not because nobody looked. Without its own arm this row reads as a base-leg row and is demoted, which would mark the overwhelming majority of the archive as estimated over charges that never happened.
    expect(await readBasis(allZeroId)).toBe('exact');

    // Both certifying arms must decline a row a post-0090 writer marked incomplete, whatever its body looks like. Asserting `not.toBe('exact')` rather than a specific tier: what matters is that shape cannot overrule the writer, and pinning the exact landing tier here would couple this to the ordering of the arms below it.
    expect(await readBasis(postWriterQuoteOnlyId)).not.toBe('exact');
    expect(await readBasis(postWriterAllZeroId)).not.toBe('exact');
  });

  it("certifies a quote-only row whose stored total reproduces its own quote leg as 'exact'", async () => {
    expect(await readBasis(quoteOnlyReproducingId)).toBe('exact');
  });

  it("reads a total that exceeds the row's own quote leg as 'estimated'", async () => {
    // The excess came from a leg this row no longer describes, valued by an algorithm that is gone. It is a number with a real basis and no way left to check it.
    expect(await readBasis(quoteOnlyExceededId)).toBe('estimated');
  });

  it("reads a valued third-asset commission as 'estimated', never exact", async () => {
    expect(await readBasis(thirdAssetValuedId)).toBe('estimated');
  });

  it("reads a base-asset-only leg as 'estimated', because nothing on the row proves it was netted", async () => {
    // Two mutations die here and nowhere else. Dropping the base key from the third-asset test reads this ordinary buy as carrying an unaccounted foreign charge and demotes it to `unknown`, blanking the statistics on most of the live archive; certifying it `exact` claims a netting proof that no row in the table carries.
    expect(await readBasis(baseLegOnlyId)).toBe('estimated');
  });

  it("reads a base leg whose total falls short of its own quote leg as 'unknown'", async () => {
    // The quote commission is on the row and the stored total is zero, so a charge this row can see was never counted. That is a hole, not a netting, and the bias runs the flattering way. Without the reproducibility conjunct the base-leg arm swallows this by shape alone and renders a profit factor off a total known to be short.
    expect(await readBasis(baseLegShortId)).toBe('unknown');
  });

  it('refuses the all-zero shortcut when the stored total contradicts the zero legs', async () => {
    // Legs that are all zero imply a zero total. A row claiming otherwise cannot be reproduced from its own evidence, so the certifying shortcut must not fire; it falls through to the arm that reads an excess over the quote leg as reconstructed value.
    expect(await readBasis(allZeroContradictoryId)).not.toBe('exact');
    expect(await readBasis(allZeroContradictoryId)).toBe('estimated');
  });

  it("reads an unvalued third-asset commission as 'unknown', not as an estimate", async () => {
    // The stored total does not exceed the quote leg, so the BNB charge contributed nothing: this row reports zero fee drag on a cycle that paid some. `estimated` would let a profit factor render off a number biased in exactly the flattering direction, which is the failure the tier exists to prevent — and it is a single-token change away.
    expect(await readBasis(thirdAssetUnvaluedId)).toBe('unknown');
  });

  it("reads a dropped third-asset leg beside a real quote leg as 'unknown'", async () => {
    // The same hole wearing a plausible number. A stored total that matches the quote leg exactly is the signature of a third-asset leg discarded, not valued.
    expect(await readBasis(thirdAssetDroppedId)).toBe('unknown');
  });

  it("reads a row with no fee evidence as 'unknown', not as a zero-fee exact row", async () => {
    // An empty fees body and a zero total are numerically indistinguishable from the genuinely fee-free cycle above; only the presence of evidence separates them.
    expect(await readBasis(noFeesId)).toBe('unknown');
  });

  it("reads a row with no archived orders as 'unknown'", async () => {
    expect(await readBasis(noOrdersId)).toBe('unknown');
  });

  it('rejects a fourth tier through a named check constraint', async () => {
    // The tier is a closed set. Without the constraint a typo'd or invented value reaches every reader that switches on the three it knows and falls through whichever branch happens to be last.
    await expect(
      pool.query(
        "insert into trade_archive (profile_id, symbol, base_asset, quote_asset, total_buy_quote, total_sell_quote, profit, fees_quote, fee_basis) values ($1, 'LINKUSDT', 'LINK', 'USDT', 10, 11, 1, 0, 'partial')",
        [profileId],
      ),
    ).rejects.toThrow(/trade_archive_fee_basis_chk/);
  });

  it('stores the tier as a text column, not a native pg enum', async () => {
    // Repo convention, and it is load-bearing: a native enum needs its own migration to gain a value, and `alter type ... add value` cannot run in the same transaction as the rows that would use it.
    const result = await pool.query<{ typtype: string; typname: string }>(
      `select t.typtype, t.typname
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_type t on t.oid = a.atttypid
        where c.relname = 'trade_archive' and a.attname = 'fee_basis'`,
    );
    expect(result.rows[0]?.typname).toBe('text');
    expect(result.rows[0]?.typtype).not.toBe('e');
  });

  it('leaves no row without a tier', async () => {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from trade_archive where fee_basis is null',
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it("stamps a complete equity snapshot 'exact' and an incomplete one 'unknown'", async () => {
    // The snapshot column is a straight boolean, so it converts without a self-consistency rule: there is no third state a boolean could ever have meant.
    expect(await readSnapshotBasis(snapshotCompleteId)).toBe('exact');
    expect(await readSnapshotBasis(snapshotIncompleteId)).toBe('unknown');
  });

  it('retains the boolean marker on both tables, with the default that lets the new writer omit it', async () => {
    // Expand-only, and deliberately so. On the live cluster the migrate hook is an Argo CD Job at sync-wave 1 and the Deployment is at wave 2, so every migration commits a full wave BEFORE any pod is replaced, with the previous image still serving under SKIP_MIGRATIONS=1. Dropping the column here removes it out from under running code by construction, which is how 0091 dead-lettered 178 jobs. The contract half belongs in a later DEPLOY, not merely a later file.
    //
    // The default is the half that makes retention safe rather than merely inert: the new writer no longer names this column, so a NOT NULL without a default would reject every insert the moment this migration landed.
    const result = await pool.query<{ table_name: string; column_default: string | null }>(
      `select table_name, column_default from information_schema.columns
        where column_name = 'fees_quote_complete'
          and table_name in ('trade_archive', 'equity_snapshots')
        order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual(['equity_snapshots', 'trade_archive']);
    for (const row of result.rows) expect(row.column_default).toBe('false');
  });

  it('rejects a fourth tier on equity_snapshots through its own named check constraint', async () => {
    // The tier lives on both tables, so the closed set has to be closed on both. A single-table test leaves the second constraint free to be dropped from the migration with the suite still green.
    await expect(
      pool.query(
        "insert into equity_snapshots (profile_id, quote_asset, net_pnl_quote, realized_net_quote, position_value_quote, position_cost_quote, benchmark_asset, benchmark_price_quote, fee_basis) values ($1, 'USDT', 1, 1, 1, 1, 'BTC', 1, 'partial')",
        [profileId],
      ),
    ).rejects.toThrow(/equity_snapshots_fee_basis_chk/);
  });

  // Both halves of the refusal predicate, each on its own database. The guard names two ways a row can claim complete fee accounting while carrying no evidence, and arm 1 of the derivation certifies such a row `exact` regardless of which half it is. Seeding only one shape leaves the other free to be deleted from the predicate with the suite still green.
  const contradictions = [
    {
      what: 'an empty fees body',
      seed: { fees: '{}', feesQuote: '0', orders: '[{"side":"SELL"}]' },
    },
    {
      what: 'no archived orders',
      seed: { fees: JSON.stringify({ USDT: '0.5' }), feesQuote: '0.5', orders: '[]' },
    },
  ] as const;

  for (const { what, seed } of contradictions) {
    it(`refuses to run rather than certify a row that claims completeness with ${what}`, async () => {
      // The conversion is one-way — nothing reconstructs the old boolean's meaning once the tier is written — so the guard has to refuse before the update rather than report afterwards.
      //
      // Run against its own database: the assertion is that `migrate()` REJECTS, which leaves the schema mid-flight and would poison every other test in this file.
      //
      // That second database means this case replays the whole predecessor set inside the test body, so it carries its own budget. This is a testTimeout, not a leftover hook override: `hookTimeout` does not reach here.
      const poisonName = `fee_basis_poison_${randomUUID().replaceAll('-', '')}_test`;
      const poisonDir = mkdtempSync(join(HERE, '.tmp-fee-basis-poison-'));
      const url = new URL(baseUrl);
      url.pathname = `/${poisonName}`;
      const poisonUrl = url.toString();
      await withAdmin(`create database "${poisonName}"`);
      let poisonPool: Pool | undefined;
      try {
        stagePredecessors(poisonDir);
        await migrate({
          connectionString: poisonUrl,
          migrationsDir: poisonDir,
          log: () => undefined,
        });
        poisonPool = new Pool({ connectionString: poisonUrl });
        await seedOwnership(poisonPool, 'poison');
        await archiveRow(poisonPool, {
          id: randomUUID(),
          base: 'BTC',
          quote: 'USDT',
          complete: true,
          ...seed,
        });

        stageTarget(poisonDir);
        await expect(
          migrate({ connectionString: poisonUrl, migrationsDir: poisonDir, log: () => undefined }),
        ).rejects.toThrow();

        // The evidence the guard refused over must survive the refusal: the whole point of stopping here is that the old marker is still readable afterwards.
        const columns = await poisonPool.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_name = 'trade_archive' and column_name = 'fees_quote_complete'`,
        );
        expect(columns.rows).toHaveLength(1);
      } finally {
        await poisonPool?.end();
        await withAdmin(`drop database if exists "${poisonName}" with (force)`);
        rmSync(poisonDir, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
