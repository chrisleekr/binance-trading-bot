// USD-denomination of the discovery universe.
//
// Turns the whole-exchange 24h ticker payload into the pure-chain ticker shape:
// prices the profile's quote asset in USD (both listing directions), then maps
// and quote-filters the universe, resolving the two USD volume floors out of the
// same payload so a cycle costs no extra Binance calls.

import { Decimal } from '@app/money';
import type { Ticker24hrDto } from '@app/binance';
import { isSymbolPermittedForAccount } from '@app/contracts';
import type { DiscoveryTicker } from '@app/discovery';
import type { Logger } from 'pino';
import type { AssetPolicy } from './asset-policy.js';
import type { SymbolAdmission } from './symbol-admission.js';

/**
 * The stablecoin market we treat as "US dollars" for denominating every volume
 * floor. USDT is not the dollar, but it is the deepest dollar-proxy market on
 * Binance and the one every discoverable coin quotes against.
 */
export const USD_REFERENCE_QUOTE = 'USDT';

/**
 * Price of one unit of `quoteAsset` in USD, read from the same whole-exchange
 * ticker payload the cycle already fetched. `null` when the quote asset has no
 * USD reference market either way round, or that market's price is non-positive —
 * the caller must fail the cycle rather than proceed, since every volume floor
 * would otherwise evaluate against an unknown scale.
 *
 * Both listing directions must be tried. Binance quotes crypto against USDT
 * (`BTCUSDT`), but lists most fiat the other way, with USDT as the base
 * (`USDTTRY`, `USDTBRL`, `USDTUSD` — there is no `TRYUSDT`). Roughly half of the
 * exchange's quote assets are inverted, so a direct-only lookup would throw every
 * cycle for every fiat quote.
 */
export const resolveQuoteUsdPrice = (
  raw: readonly Ticker24hrDto[],
  quoteAsset: string,
): Decimal | null => {
  if (quoteAsset === USD_REFERENCE_QUOTE) return new Decimal(1);
  const direct = raw.find((t) => t.symbol === `${quoteAsset}${USD_REFERENCE_QUOTE}`);
  if (direct !== undefined) {
    const price = new Decimal(direct.lastPrice);
    if (price.gt(0)) return price;
  }
  const inverted = raw.find((t) => t.symbol === `${USD_REFERENCE_QUOTE}${quoteAsset}`);
  if (inverted !== undefined) {
    const price = new Decimal(inverted.lastPrice);
    if (price.gt(0)) return new Decimal(1).div(price);
  }
  return null;
};

/**
 * Map raw 24h tickers to the pure-chain ticker shape, keeping only the symbols this profile may actually trade in its configured quote asset.
 *
 * Base and quote come from `admissionBySymbol` — the exchangeInfo facts the refresh cron cached — never from slicing the quote off the symbol. Suffix matching is not merely inelegant, it is wrong: quote `USD` also suffix-matches the `FDUSD` and `RLUSD` markets, so `BTCFDUSD` reads as base `BTCFD`, a base that has no USDT market and therefore no `assetVolumeUsd` and no asset classification. Those rows used to survive into the ranked universe and die later at the activity filter, which is the wrong rung and the wrong reason.
 *
 * Resolves the two USD volumes the filter chain reads, both out of this same payload so the cycle costs no extra Binance calls:
 *
 * - `pairVolumeUsd` scales the pair's own quote volume by `quoteUsdPrice`.
 * - `assetVolumeUsd` is looked up on the coin's `<base>USDT` market — a different row of this payload, and the row itself when the profile already quotes in USDT. `null` when the coin has no USDT market at all.
 *
 * Three cuts run here rather than as funnel stages, because all three are exchange or account facts while every funnel stage is a filter the operator can tune:
 *
 * - `status` keeps only `TRADING` markets: Binance still returns a 24h-ticker row for a delisted/halted pair, and a delisting removes the symbol's exchangeInfo key entirely, so a symbol absent from the map is excluded too.
 * - `quoteAsset` keeps only markets settling in the profile's quote, matched against exchangeInfo rather than the symbol text.
 * - `permissionSets` keeps only symbols this account may actually trade. A symbol is tradable only when the account holds at least one tag from EVERY published set, so an account without `SPOT` cannot trade a tokenised-equity pair no matter its status. Binding one anyway makes every tick re-derive an order Binance refuses with -2010 forever, and the retry burns the account's whole request-weight budget.
 *
 * The asset classification is stamped onto each ticker rather than cut here, because it IS a funnel stage: the operator needs to see how many candidates it removed. It is still not a lever — see the pure chain's `passesAssetPolicy`.
 *
 * `admissionBySymbol` and `assetPolicy` are both REQUIRED. An earlier version defaulted an empty admission map to "keep the quote-matched universe unfiltered", which reads as fail-safe and is not: it admits delisted pairs, pairs the account cannot trade, and — now that the base/quote split and the classification both hang off it — every stablecoin on the exchange. An unreadable signal is a reason to stop, not a reason to proceed with the filters switched off. An empty `accountPermissions` still disables only the permission cut, which is a genuine unknown rather than a missing input.
 */
export interface DiscoveryTickerOptions {
  /** exchangeInfo facts per symbol for the profile's mode: status, the base/quote split, and the permission sets. Throws when empty — see above. */
  readonly admissionBySymbol: ReadonlyMap<string, SymbolAdmission>;
  /** Binance's current stablecoin/fiat classification, already validated against live exchangeInfo by the caller. */
  readonly assetPolicy: AssetPolicy;
  /**
   * Permission tags the account holds. Empty means unknown, which disables the
   * permission cut rather than rejecting everything.
   */
  readonly accountPermissions?: readonly string[];
  /**
   * Required, not optional: the cuts below are silent by construction (a symbol
   * simply stops appearing), so the warn is the operator's only explanation. An
   * optional logger let every production caller omit it and the warn never fired.
   */
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * @param raw - The whole-exchange 24h ticker payload, one row per listed market.
 * @param quoteAsset - The profile's settlement asset; only markets whose exchangeInfo quote equals it survive.
 * @param quoteUsdPrice - Price of one unit of `quoteAsset` in USD, for denominating the volume floors.
 * @param opts - The admission map, the asset classification, the account's permission tags, and the logger the silent cuts report through.
 * @returns The pure-chain tickers for this profile's universe, each carrying its exchangeInfo base and its stablecoin/fiat verdict.
 */
export const toDiscoveryTickers = (
  raw: readonly Ticker24hrDto[],
  quoteAsset: string,
  quoteUsdPrice: Decimal,
  opts: DiscoveryTickerOptions,
): DiscoveryTicker[] => {
  const { admissionBySymbol, assetPolicy, accountPermissions, logger } = opts;
  if (admissionBySymbol.size === 0) {
    throw new Error(
      'discovery: empty symbol-admission map (exchangeInfo not primed?); refusing to score an unfiltered universe',
    );
  }
  const applyPermissions = (accountPermissions?.length ?? 0) > 0;
  const usdVolumeBySymbol = new Map(raw.map((t) => [t.symbol, t.quoteVolume]));
  let notPermitted = 0;
  const kept: DiscoveryTicker[] = [];
  for (const t of raw) {
    const admission = admissionBySymbol.get(t.symbol);
    if (admission === undefined || admission.status !== 'TRADING') continue;
    if (admission.quoteAsset !== quoteAsset) continue;
    if (
      applyPermissions &&
      !isSymbolPermittedForAccount({
        permissionSets: admission.permissionSets,
        accountPermissions,
      })
    ) {
      notPermitted += 1;
      continue;
    }
    const base = admission.baseAsset;
    kept.push({
      symbol: t.symbol,
      baseAsset: base,
      quoteAsset,
      isStablecoinOrFiat: assetPolicy.stablecoinOrFiatBases.has(base),
      priceChangePercent: t.priceChangePercent,
      quoteVolume: t.quoteVolume,
      pairVolumeUsd: new Decimal(t.quoteVolume).times(quoteUsdPrice).toString(),
      assetVolumeUsd: usdVolumeBySymbol.get(`${base}${USD_REFERENCE_QUOTE}`) ?? null,
      lastPrice: t.lastPrice,
      bidPrice: t.bidPrice,
      askPrice: t.askPrice,
    });
  }
  // The permission cut leaves the funnel's universe count silently smaller, so log the real count — otherwise a symbol the operator expects vanishes with no explanation anywhere.
  if (notPermitted > 0) {
    logger.warn(
      { quoteAsset, notPermitted, kept: kept.length },
      'discovery: symbols excluded, account lacks a required Binance permission',
    );
  }
  return kept;
};
