import { signatureForBacktest } from '@app/strategy-core';
import { marketOf } from '@app/contracts';
import type { BacktestParams } from '@app/contracts';
import type { ApiStrategyRegistry } from './strategies/registry.js';

/**
 * Full backtest signature for a (profile config + override + market), or null if
 * the strategy is unknown or its schema rejects the config. Mirrors the worker's
 * parse-then-fingerprint exactly via {@link signatureForBacktest}. Used to dedup
 * an identical backtest submit against the durable result ledger.
 */
export const signatureForRun = (
  strategies: ApiStrategyRegistry,
  strategyName: string,
  profileConfig: unknown,
  override: Record<string, unknown> | null | undefined,
  params: BacktestParams,
): { signature: string; configFingerprint: string; config: unknown } | null => {
  const strategy = strategies.get(strategyName);
  if (!strategy) return null;
  try {
    return signatureForBacktest({
      strategyId: strategyName,
      parseConfig: (c) => strategy.configSchema.parse(c),
      profileConfig,
      override,
      market: marketOf(params),
    });
  } catch {
    // A stale/invalid config cannot be signed; treat as "no signature" so the
    // caller falls back to a normal run rather than failing.
    return null;
  }
};
