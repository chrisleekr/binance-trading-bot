import { describe, expect, it } from 'vitest';
import { projectFunnel } from '../src/funnel.js';
import { shortlistByTicker, TICKER_STAGE_CHAIN, tickerStageCounts } from '../src/run.js';
import type { DiscoveryTicker } from '../src/types.js';
import { cfg, ticker } from './_helpers.js';

/**
 * A ticker that clears every OTHER ticker stage under the base config, so the only verdict a test here can move is the asset-policy one. `baseAsset` and `isStablecoinOrFiat` are resolved upstream (exchangeInfo for the base, fresh Binance product metadata for the classification); the pure stage reads the flag and nothing else.
 */
const t = (over: Partial<DiscoveryTicker> = {}): DiscoveryTicker => ({
  ...ticker(),
  baseAsset: 'AAA',
  isStablecoinOrFiat: false,
  ...over,
});

describe('assetPolicy ticker stage', () => {
  it('rejects a base classified stablecoin or fiat, and reads only the flag — no symbol registry', () => {
    const out = shortlistByTicker(
      [
        t({ symbol: 'RLUSDUSDT', baseAsset: 'RLUSD', isStablecoinOrFiat: true }),
        // Identically shaped name, unflagged. If the stage owned a symbol/name list this would be rejected too; it must survive, because the classification is data, not code.
        t({ symbol: 'FDUSDUSDT', baseAsset: 'FDUSD', isStablecoinOrFiat: false }),
      ],
      cfg(),
    );
    expect(out).toEqual(['FDUSDUSDT']);
  });

  it('vetoes the base across every quote pairing it trades on', () => {
    for (const [quoteAsset, symbol] of [
      ['USDT', 'USDCUSDT'],
      ['TRY', 'USDCTRY'],
    ] as const) {
      const out = shortlistByTicker(
        [t({ symbol, quoteAsset, baseAsset: 'USDC', isStablecoinOrFiat: true })],
        cfg({ quoteAsset }),
      );
      expect(out).toEqual([]);
    }
  });

  it('leaves an ordinary crypto base eligible and moves no other stage verdict', () => {
    const tickers = [
      t({ symbol: 'BTCUSDT', baseAsset: 'BTC' }),
      t({ symbol: 'RLUSDUSDT', baseAsset: 'RLUSD', isStablecoinOrFiat: true }),
    ];
    expect(shortlistByTicker(tickers, cfg())).toEqual(['BTCUSDT']);
    // Only the assetPolicy rung and its successors drop; `quote` is untouched, so the stablecoin is cut by the new stage rather than by a widened older one.
    expect(tickerStageCounts(tickers, cfg())).toEqual({
      universe: 2,
      quote: 2,
      assetPolicy: 1,
      blacklist: 1,
      liquidity: 1,
      activity: 1,
      spread: 1,
      changeBand: 1,
    });
  });

  it('sits between quote and blacklist in the one stage chain every consumer walks', () => {
    expect(TICKER_STAGE_CHAIN.map(([name]) => name)).toEqual([
      'quote',
      'assetPolicy',
      'blacklist',
      'liquidity',
      'activity',
      'spread',
      'changeBand',
    ]);
  });

  it('rejects earlier than the operator blacklist, which still rejects independently', () => {
    // Both symbols are blacklisted, so the stage each dies at is the only thing that can distinguish them.
    const config = cfg({ blacklist: ['BTCUSDT', 'RLUSDUSDT'] });

    const stablecoin = tickerStageCounts(
      [t({ symbol: 'RLUSDUSDT', baseAsset: 'RLUSD', isStablecoinOrFiat: true })],
      config,
    );
    expect(stablecoin.quote).toBe(1);
    expect(stablecoin.assetPolicy).toBe(0);

    const blacklisted = tickerStageCounts([t({ symbol: 'BTCUSDT', baseAsset: 'BTC' })], config);
    expect(blacklisted.assetPolicy).toBe(1);
    expect(blacklisted.blacklist).toBe(0);
  });

  it('carries its own funnel rung', () => {
    const counts = {
      universe: 9,
      quote: 7,
      assetPolicy: 5,
      blacklist: 4,
      liquidity: 3,
      activity: 3,
      spread: 2,
      changeBand: 1,
    };
    const funnel = projectFunnel([], { add: [], remove: [], desired: [] }, true, counts, 0);
    expect(funnel.assetPolicy).toBe(5);
    // The neighbouring rungs still carry their own counts, so the new rung is inserted rather than shifting the segment.
    expect(funnel.quote).toBe(7);
    expect(funnel.blacklist).toBe(4);
  });
});
