import { djb2Hex } from './client-order-id.js';
import { mergeConfig } from './merge-config.js';

/**
 * Recursively sort object keys so two configs that differ only in key order
 * serialise identically. Arrays keep their order (it is significant); scalars
 * pass through. Pure — no Date/crypto, so it is safe in a strategy package.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

/**
 * A stable fingerprint of a strategy config, used by the live-enablement gate to
 * decide whether a stored backtest was run on the profile's CURRENT config.
 * Canonical JSON (sorted keys) hashed with two salted djb2 passes for a 16-hex
 * (≈64-bit) digest — enough to make an accidental collision between two distinct
 * configs negligible, and `crypto`-free so it runs inside the strategy packages.
 * The worker stamps a backtest run with `configFingerprint(merged)`; the API
 * gate compares it to `configFingerprint(currentProfileConfig)`. Pass configs
 * already parsed through the strategy schema so defaults are filled identically
 * on both sides.
 */
export const configFingerprint = (config: unknown): string => {
  const json = JSON.stringify(canonical(config));
  return djb2Hex(json) + djb2Hex(`${json}fingerprint`);
};

// The normalised market dims the caller hands in. strategy-core does not depend
// on contracts, so the caller (which owns the enumeration) passes the flat
// object and this hashes it as-is. Typed as a flat bag of primitives plus a
// string basket rather than `object`: wide enough to accept any strategy's
// projection, narrow enough that a nested shape (raw run params, whose fees is
// an object) fails to typecheck here, so an un-normalised market cannot be
// hashed by mistake. Normalisation (symbol sort, absent-vs-null collapse)
// happens upstream where the dims are defined.
type MarketDims = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface BacktestSignatureInput {
  readonly strategyId: string;
  readonly config: unknown; // EFFECTIVE merged config (profile base + run override, parsed)
  readonly market: MarketDims;
}

/**
 * A stable fingerprint of a WHOLE backtest (strategy + effective config +
 * market), used by the results ledger to recognise "we have already run exactly
 * this". Distinct salt from {@link configFingerprint} so the two key spaces
 * never alias. The `market` object is hashed directly (its keys are sorted by
 * `canonical`), so the hash VALUE is tied to that flat market shape: change the
 * shape upstream and every signature moves with it. Pass `config` already parsed
 * through the strategy schema so defaults are filled identically wherever it is
 * computed.
 */
export const backtestSignature = (input: BacktestSignatureInput): string => {
  const json = JSON.stringify(
    canonical({
      strategyId: input.strategyId,
      config: input.config,
      market: input.market,
    }),
  );
  return djb2Hex(json) + djb2Hex(`${json}backtest-signature`);
};

/**
 * Single anti-drift seam for the signature: merge the run override onto the
 * profile base and parse, exactly as the backtest runner does, then derive both
 * fingerprints. Every consumer that must recognise an already-run backtest (the
 * worker completion write-through, the manual re-run dedup short-circuit) goes
 * through this so they cannot compute subtly different signatures for the same
 * run. `parseConfig` is the strategy's `configSchema.parse`.
 */
export const signatureForBacktest = (input: {
  readonly strategyId: string;
  readonly parseConfig: (config: unknown) => unknown;
  readonly profileConfig: unknown;
  readonly override: Record<string, unknown> | null | undefined;
  readonly market: MarketDims;
}): { signature: string; configFingerprint: string; config: unknown } => {
  const base = input.parseConfig(input.profileConfig);
  const config = input.parseConfig(mergeConfig(base, input.override ?? {}));
  return {
    config,
    configFingerprint: configFingerprint(config),
    signature: backtestSignature({ strategyId: input.strategyId, config, market: input.market }),
  };
};
