import { asProfileId } from '@app/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountRepo, profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * The two rolling-window aggregates the loss-streak and drawdown entry breakers
 * read: `countLosingCyclesInRange` and `maxRealisedDrawdownInRange`.
 *
 * Own fixture rather than the shared `trade-archive.test.ts` one, because both
 * functions are sums over EVERY row in a window: a sibling test seeding one more
 * archive row would move the answer, and the replay below asserts exact figures.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const at = (iso: string): Date => new Date(iso);

/** One archived closed cycle. Only `profit`, `quoteAsset` and `archivedAt` matter to either aggregate; the rest satisfies the not-null columns. */
const cycle = (tag: string, archivedAt: string, profit: string, quoteAsset = 'USDT') => ({
  symbol: `${tag}${quoteAsset}`,
  baseAsset: tag,
  quoteAsset,
  totalBuyQuote: '100',
  totalSellQuote: '100',
  breakdown: {},
  profit,
  orders: [{ tag, side: 'BUY' as const }],
  archivedAt: at(archivedAt),
});

describeIfDb('trade-archive loss-guard window aggregates', () => {
  let fx: IsolationFixture;
  let alice: ProfileRepo;
  let bob: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    alice = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bob = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  describe('window bounds, quote scoping, and ownership', () => {
    const FROM = '2026-03-01T00:00:00.000Z';
    const TO = '2026-03-02T00:00:00.000Z';

    beforeAll(async () => {
      // Exactly on the lower bound (inclusive) and exactly on the upper bound
      // (exclusive). A half-open window is what stops one archive row being
      // counted twice by two consecutive cron cycles.
      await alice.tradeArchive.insert(cycle('BND', FROM, '-1'));
      await alice.tradeArchive.insert(cycle('BNDT', TO, '-100'));
      await alice.tradeArchive.insert(cycle('MID', '2026-03-01T12:00:00.000Z', '-2'));
      // A loss in a DIFFERENT quote. A count that swept both currencies would be
      // a count of nothing: 1 BTC and 1 USDT are not two of the same thing.
      await alice.tradeArchive.insert(cycle('OTH', '2026-03-01T13:00:00.000Z', '-5', 'BTC'));
      // Another operator's profile, same window, same quote.
      await bob.tradeArchive.insert(cycle('BOB', '2026-03-01T14:00:00.000Z', '-50'));
    });

    it('counts the row ON the lower bound and excludes the row ON the upper bound', async () => {
      expect(await alice.tradeArchive.countLosingCyclesInRange('USDT', at(FROM), at(TO))).toBe(2);
    });

    it('excludes rows in another quote asset', async () => {
      // The BTC row is a loss inside the window; only the quote filter keeps it out.
      const btc = await alice.tradeArchive.countLosingCyclesInRange('BTC', at(FROM), at(TO));
      expect(btc).toBe(1);
    });

    it('folds the quote asset case, as the archive stores it upper', async () => {
      // `profiles.quote_asset` may be stored lower or mixed by design, and the
      // cron passes it straight through. An unfolded compare would match nothing
      // and the guard would silently never trip.
      expect(await alice.tradeArchive.countLosingCyclesInRange('usdt', at(FROM), at(TO))).toBe(2);
    });

    it('cannot see another profile’s rows', async () => {
      expect(await bob.tradeArchive.countLosingCyclesInRange('USDT', at(FROM), at(TO))).toBe(1);
    });

    // A COUNT over the window, not the length of the trailing run of losses. Pinned because the breaker's name reads as consecutive and the two answers differ here: a grid or a pyramid closes many small cycles, so one scratch win between two losses would reset a run-counter and leave the guard unarmable on exactly the strategy shapes it is for. Its own June window, so the March figures above cannot move.
    it('counts every loss in the window, not only the trailing consecutive run', async () => {
      const ALT_FROM = '2026-06-01T00:00:00.000Z';
      const ALT_TO = '2026-06-02T00:00:00.000Z';
      for (const [tag, hour, profit] of [
        ['ALTA', '01', '-1'],
        ['ALTB', '02', '2'],
        ['ALTC', '03', '-1'],
        ['ALTD', '04', '2'],
        ['ALTE', '05', '-1'],
      ] as const) {
        await bob.tradeArchive.insert(cycle(tag, `2026-06-01T${hour}:00:00.000Z`, profit));
      }

      expect(
        await bob.tradeArchive.countLosingCyclesInRange('USDT', at(ALT_FROM), at(ALT_TO)),
      ).toBe(3);
    });

    it('returns the drawdown as a decimal STRING, never a JS number', async () => {
      const dd = await alice.tradeArchive.maxRealisedDrawdownInRange('USDT', at(FROM), at(TO));
      // Money crosses this boundary as text: a numeric(38,18) that became a JS
      // number would already have lost precision by the time anyone compared it.
      expect(typeof dd).toBe('string');
      // -1 then -2 from a flat start: the peak is floored at 0, so the window's
      // own opening losses are reported rather than hidden behind nothing.
      expect(Number(dd)).toBe(3);
    });

    it('reports no drawdown for an empty window, and none for a window that only rose', async () => {
      expect(
        Number(
          await alice.tradeArchive.maxRealisedDrawdownInRange(
            'USDT',
            at('2026-04-01T00:00:00.000Z'),
            at('2026-04-02T00:00:00.000Z'),
          ),
        ),
      ).toBe(0);
      await alice.tradeArchive.insert(cycle('UP', '2026-04-10T00:00:00.000Z', '5'));
      expect(
        Number(
          await alice.tradeArchive.maxRealisedDrawdownInRange(
            'USDT',
            at('2026-04-10T00:00:00.000Z'),
            at('2026-04-11T00:00:00.000Z'),
          ),
        ),
      ).toBe(0);
    });
  });

  describe('replay of the live Momentum sequence that motivated the guards', () => {
    // Hand-written from two tables of observed evidence (the five losing cycles
    // with their prior-loss counts, and the cumulative/peak/drawdown table), NOT
    // copied out of the live archive. The five losses and their timestamps are
    // verbatim; the two gain rows are the figures the cumulative table implies:
    // +34.406 then +7.847 reaches the recorded 42.253 peak before the first loss,
    // and +8.893 between XLM and 0G reaches the recorded 25.403 final cum. The
    // 2026-08-19 gain also sits inside the 72 h window of the FLOKI row, which is
    // what makes that row's window-local drawdown 15.388 rather than 7.847.
    //
    // Expected trips: loss-streak on the 2026-08-23 00:08:41 REUSDT row (its third
    // loss inside 24 h), drawdown on the 2026-08-22 05:11:32 FLOKIUSDT row.
    const SEQUENCE = [
      ['SEED', '2026-08-01T00:00:00.000Z', '34.406'],
      ['GAIN', '2026-08-19T06:00:00.000Z', '7.847'],
      ['ETC', '2026-08-22T05:11:23.000Z', '-7.541'],
      ['FLOKI', '2026-08-22T05:11:32.000Z', '-7.847'],
      ['RE', '2026-08-23T00:08:41.000Z', '-4.526'],
      ['XLM', '2026-08-25T21:08:11.000Z', '-2.840'],
      ['RECOV', '2026-08-28T12:00:00.000Z', '8.893'],
      ['ZEROG', '2026-09-01T14:51:51.000Z', '-2.989'],
    ] as const;

    const MAX_LOSING_EXITS = 3;
    const STREAK_LOOKBACK_MS = 24 * 3_600_000;
    const MAX_DRAWDOWN = 15;
    const DRAWDOWN_LOOKBACK_MS = 72 * 3_600_000;
    const PAUSE_MS = 24 * 3_600_000;

    let replay: ProfileRepo;

    beforeAll(async () => {
      // A third profile under Alice's account, so this replay's exact figures
      // cannot be moved by the rows the bounds suite above seeds.
      const account = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
      const row = await account.profiles.insert({
        name: 'replay',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
        config: {},
        state: {},
      });
      replay = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, asProfileId(row.id));
      for (const [tag, iso, profit] of SEQUENCE) {
        await replay.tradeArchive.insert(cycle(tag, iso, profit));
      }
    });

    it('opens each guard exactly once, on the row the live evidence names', async () => {
      const pausedUntil: Record<'loss-streak' | 'drawdown', number> = {
        'loss-streak': 0,
        drawdown: 0,
      };
      const opened: Array<{ kind: 'loss-streak' | 'drawdown'; at: string }> = [];

      for (const [, iso] of SEQUENCE) {
        // One millisecond past the row: the windows are half-open at the top, and
        // the real cron runs up to 30 s after an archive row lands, so the row it
        // is reacting to is inside the window it measures.
        const nowMs = at(iso).getTime() + 1;

        const losingExits = await replay.tradeArchive.countLosingCyclesInRange(
          'USDT',
          new Date(nowMs - STREAK_LOOKBACK_MS),
          new Date(nowMs),
        );
        const drawdown = Number(
          await replay.tradeArchive.maxRealisedDrawdownInRange(
            'USDT',
            new Date(nowMs - DRAWDOWN_LOOKBACK_MS),
            new Date(nowMs),
          ),
        );

        // SET NX with a pauseHours TTL: a guard whose window still holds the
        // losses stays tripped on every later cycle, but only the call that
        // CREATES the key is a new pause. Modelled here, or the replay would
        // report the 2026-08-23 row as a second drawdown trip.
        if (losingExits >= MAX_LOSING_EXITS && nowMs >= pausedUntil['loss-streak']) {
          opened.push({ kind: 'loss-streak', at: iso });
          pausedUntil['loss-streak'] = nowMs + PAUSE_MS;
        }
        if (drawdown >= MAX_DRAWDOWN && nowMs >= pausedUntil.drawdown) {
          opened.push({ kind: 'drawdown', at: iso });
          pausedUntil.drawdown = nowMs + PAUSE_MS;
        }
      }

      expect(opened).toEqual([
        { kind: 'drawdown', at: '2026-08-22T05:11:32.000Z' },
        { kind: 'loss-streak', at: '2026-08-23T00:08:41.000Z' },
      ]);
    });

    it('measures the two figures the live evidence table records', async () => {
      // The exact numbers, not just "tripped": a query that reached the threshold
      // for the wrong reason would pass the trip assertion above unchanged.
      const flokiMs = at('2026-08-22T05:11:32.000Z').getTime() + 1;
      expect(
        Number(
          await replay.tradeArchive.maxRealisedDrawdownInRange(
            'USDT',
            new Date(flokiMs - DRAWDOWN_LOOKBACK_MS),
            new Date(flokiMs),
          ),
        ),
      ).toBeCloseTo(15.388, 3);

      const reMs = at('2026-08-23T00:08:41.000Z').getTime() + 1;
      expect(
        await replay.tradeArchive.countLosingCyclesInRange(
          'USDT',
          new Date(reMs - STREAK_LOOKBACK_MS),
          new Date(reMs),
        ),
      ).toBe(3);
      // Peak floored at 0: the 72 h window here opens AFTER the 2026-08-19 gain,
      // so all three losses count from flat and the fall is their sum.
      expect(
        Number(
          await replay.tradeArchive.maxRealisedDrawdownInRange(
            'USDT',
            new Date(reMs - DRAWDOWN_LOOKBACK_MS),
            new Date(reMs),
          ),
        ),
      ).toBeCloseTo(19.914, 3);
    });
  });
});
