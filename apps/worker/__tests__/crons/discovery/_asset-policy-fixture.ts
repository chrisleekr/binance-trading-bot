// Binance product-metadata fixture for the asset-policy resolver.
//
// The rows below are verbatim (short-key) captures from
// `GET https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true`
// taken 2026-08-18, trimmed to the seven keys the projector reads. The live payload carries 35 keys
// per row and every one of its 1361 rows is `st: 'TRADING'`; the extra keys are dropped here so a
// test asserting on a projected row cannot accidentally assert on a key the projector never promised.
//
// Two rows carry the traps this fixture exists for:
//
// - `EURUSDT` has EMPTY tags. EUR is a fiat asset reachable only through the `q` (quote) values of
//   the `pm`/`pn` = FIAT rows, never through its own row's tags.
// - `ADAEUR` is a FIAT/FIAT row whose BASE is ADA, an ordinary crypto. Deriving the fiat set from
//   `b` instead of `q` would wrongly veto ADA.

import type { SymbolAdmission } from '../../../src/crons/discovery/symbol-admission.js';

/** The short-key shape of one row of the product feed's `data` array, narrowed to the keys the projector reads. */
export interface ProductRowFixture {
  readonly s: string;
  readonly st: string;
  readonly b: string;
  readonly q: string;
  readonly pm: string;
  readonly pn: string;
  readonly tags: readonly string[];
}

/** Ten verbatim rows spanning both classification routes (tag and fiat-quote), both traps, and an ordinary crypto control pair. */
export const PRODUCT_ROWS: readonly ProductRowFixture[] = [
  {
    s: 'RLUSDUSDT',
    st: 'TRADING',
    b: 'RLUSD',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['stablecoin'],
  },
  {
    s: 'FDUSDUSDT',
    st: 'TRADING',
    b: 'FDUSD',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['stablecoin'],
  },
  {
    s: 'USDCUSDT',
    st: 'TRADING',
    b: 'USDC',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['stablecoin'],
  },
  {
    s: 'USDEUSDT',
    st: 'TRADING',
    b: 'USDE',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['stablecoin'],
  },
  {
    s: 'USDCTRY',
    st: 'TRADING',
    b: 'USDC',
    q: 'TRY',
    pm: 'FIAT',
    pn: 'FIAT',
    tags: ['stablecoin'],
  },
  { s: 'EURUSDT', st: 'TRADING', b: 'EUR', q: 'USDT', pm: 'USDT', pn: 'USDT', tags: [] },
  {
    s: 'BTCUSDT',
    st: 'TRADING',
    b: 'BTC',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['Payments', 'mining-zone'],
  },
  {
    s: 'ETHUSDT',
    st: 'TRADING',
    b: 'ETH',
    q: 'USDT',
    pm: 'USDT',
    pn: 'USDT',
    tags: ['Layer1_Layer2', 'pos', 'mining-zone'],
  },
  {
    s: 'ADAEUR',
    st: 'TRADING',
    b: 'ADA',
    q: 'EUR',
    pm: 'FIAT',
    pn: 'FIAT',
    tags: ['Layer1_Layer2', 'pos', 'mining-zone'],
  },
  {
    s: 'AVAXEUR',
    st: 'TRADING',
    b: 'AVAX',
    q: 'EUR',
    pm: 'FIAT',
    pn: 'FIAT',
    tags: ['Layer1_Layer2', 'pos', 'RWA'],
  },
];

/**
 * A base that appears in NO `src/` file, so admitting it can only come from the feed. Used to prove a newly tagged stablecoin is vetoed on the next refresh with zero code change.
 */
export const NEW_STABLECOIN_ROW: ProductRowFixture = {
  s: 'NEWSTABUSDT',
  st: 'TRADING',
  b: 'NEWSTAB',
  q: 'USDT',
  pm: 'USDT',
  pn: 'USDT',
  tags: ['stablecoin'],
};

/**
 * Wrap rows in the feed's response envelope.
 *
 * @param rows - Product rows to place in `data`; pass a deliberately malformed array to exercise the projector's skip path.
 * @returns The parsed-JSON body shape the projector receives, envelope included.
 */
export const productsPayload = (rows: readonly unknown[]): unknown => ({
  code: '000000',
  success: true,
  data: rows,
});

/**
 * The live-exchangeInfo admission map that matches a set of product rows exactly, so validation of a complete pair passes and every test that wants a mismatch has to introduce one deliberately.
 *
 * @param rows - Product rows to mirror; each becomes one `TRADING` admission entry keyed by symbol.
 * @returns Symbol to admission facts, with the exchangeInfo-backed base and quote every downstream stage resolves from.
 */
export const liveAdmission = (
  rows: readonly ProductRowFixture[] = PRODUCT_ROWS,
): Map<string, SymbolAdmission> =>
  new Map(rows.map((r) => [r.s, { status: 'TRADING', baseAsset: r.b, quoteAsset: r.q }]));
