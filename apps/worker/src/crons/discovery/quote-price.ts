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
 * Map raw 24h tickers to the pure-chain ticker shape, keeping only symbols
 * quoted in the configured asset. Quote-asset is matched by symbol suffix —
 * dependency-free and correct for the USDT/BTC/etc universe; the pure
 * quote-match filter then trivially re-affirms it.
 *
 * Resolves the two USD volumes the filter chain reads, both out of this same
 * payload so the cycle costs no extra Binance calls:
 *
 * - `pairVolumeUsd` scales the pair's own quote volume by `quoteUsdPrice`.
 * - `assetVolumeUsd` is looked up on the coin's `<base>USDT` market — a
 *   different row of this payload, and the row itself when the profile already
 *   quotes in USDT. `null` when the coin has no USDT market at all.
 *
 * Suffix matching assumes no configured quote is a proper suffix of another
 * listed quote. Binance breaks that once: quote `USD` also suffix-matches the
 * `FDUSD` and `RLUSD` markets, whose base would then be mis-read (`BTCFDUSD` ->
 * `BTCFD`). Those rows survive here but die at the activity filter, because the
 * mis-read base has no `<base>USDT` market and `assetVolumeUsd` is null, which
 * `isActive` fails closed. They still inflate the ranked universe, so resolving
 * base/quote from exchangeInfo would be the complete fix.
 *
 * `admissionBySymbol` (exchangeInfo facts per symbol, mode-scoped) drives two
 * cuts:
 *
 * - `status` keeps only `TRADING` markets: Binance still returns a 24h-ticker
 *   row for a delisted/halted pair, and a delisting removes the symbol's
 *   exchangeInfo key entirely, so a symbol absent from the map is excluded too.
 * - `permissionSets` keeps only symbols this account may actually trade. A
 *   symbol is tradable only when the account holds at least one tag from EVERY
 *   published set, so an account without `SPOT` cannot trade a tokenised-equity
 *   pair no matter its status. Binding one anyway makes every tick re-derive an
 *   order Binance refuses with -2010 forever, and the retry burns the account's
 *   whole request-weight budget.
 *
 * Fail-safe throughout: an absent or empty map (exchangeInfo not primed / Redis
 * miss) skips both filters and warns, and an empty `accountPermissions` skips
 * the permission filter, keeping the quote-matched universe rather than
 * emptying it. A signal that cannot be read is never a refusal.
 */
export interface DiscoveryTickerOptions {
  readonly admissionBySymbol?: ReadonlyMap<string, SymbolAdmission>;
  /**
   * Permission tags the account holds. Empty means unknown, which disables the
   * permission cut rather than rejecting everything.
   */
  readonly accountPermissions?: readonly string[];
  /**
   * Required, not optional: both cuts below are silent by construction (a symbol
   * simply stops appearing), so the warn is the operator's only explanation. An
   * optional logger let every production caller omit it and the warn never fired.
   */
  readonly logger: Pick<Logger, 'warn'>;
}

export const toDiscoveryTickers = (
  raw: readonly Ticker24hrDto[],
  quoteAsset: string,
  quoteUsdPrice: Decimal,
  opts: DiscoveryTickerOptions,
): DiscoveryTicker[] => {
  const { admissionBySymbol, accountPermissions, logger } = opts;
  const applyStatus = admissionBySymbol !== undefined && admissionBySymbol.size > 0;
  if (admissionBySymbol !== undefined && admissionBySymbol.size === 0) {
    logger.warn(
      {},
      'discovery: empty symbol-admission map; keeping the quote-matched universe unfiltered (fail-safe)',
    );
  }
  const applyPermissions = applyStatus && (accountPermissions?.length ?? 0) > 0;
  const usdVolumeBySymbol = new Map(raw.map((t) => [t.symbol, t.quoteVolume]));
  let notPermitted = 0;
  const kept = raw
    .filter((t) => {
      if (!t.symbol.endsWith(quoteAsset) || t.symbol.length <= quoteAsset.length) return false;
      if (!applyStatus) return true;
      const admission = admissionBySymbol?.get(t.symbol);
      if (admission?.status !== 'TRADING') return false;
      if (!applyPermissions) return true;
      const permitted = isSymbolPermittedForAccount({
        permissionSets: admission.permissionSets,
        accountPermissions,
      });
      if (!permitted) notPermitted += 1;
      return permitted;
    })
    .map((t) => {
      const base = t.symbol.slice(0, t.symbol.length - quoteAsset.length);
      return {
        symbol: t.symbol,
        quoteAsset,
        priceChangePercent: t.priceChangePercent,
        quoteVolume: t.quoteVolume,
        pairVolumeUsd: new Decimal(t.quoteVolume).times(quoteUsdPrice).toString(),
        assetVolumeUsd: usdVolumeBySymbol.get(`${base}${USD_REFERENCE_QUOTE}`) ?? null,
        lastPrice: t.lastPrice,
        bidPrice: t.bidPrice,
        askPrice: t.askPrice,
      };
    });
  // Cut here rather than as a funnel stage, for the same reason `status` is:
  // both are exchange admission facts, while every funnel stage is a filter the
  // operator can tune. A stage would also be the only one no config change can
  // relax. That leaves the funnel's universe count silently smaller, so log the
  // real count — otherwise a symbol the operator expects vanishes unexplained.
  if (notPermitted > 0) {
    logger.warn(
      { quoteAsset, notPermitted, kept: kept.length },
      'discovery: symbols excluded, account lacks a required Binance permission',
    );
  }
  return kept;
};
