import { z } from 'zod';
import { Decimal } from '@app/money';
import { decimalString } from '@app/contracts';

/** Candle intervals this strategy reads; the operator-pickable subset. */
export const REBALANCE_CANDLE_INTERVALS = ['5m', '15m', '30m', '1h', '4h', '1d'] as const;
const REBALANCE_DEFAULT_INTERVAL = '1h' as const;

/** One target slice: a symbol and the fraction of the basket it should hold. */
const RebalanceTargetSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .describe('Trading pair, e.g. BTCUSDT. Must also be in the profile’s symbol list.'),
  weight: decimalString('weight must be in (0, 1]', { gt: 0, lte: 1 }).describe(
    '@ui:percent-of Share of the basket this symbol should hold. The weights across all targets must sum to at most 1.',
  ),
});

/** Decimal sum of a target list's weights — the basket's total allocated share. */
const weightSum = (targets: readonly RebalanceTarget[]): Decimal =>
  targets.reduce((acc, t) => acc.add(new Decimal(t.weight)), new Decimal(0));
export type RebalanceTarget = z.infer<typeof RebalanceTargetSchema>;

/**
 * Cross-sectional momentum tuning, used only when `weightMode` is `momentum`.
 * Each symbol's trailing return over `lookbackCandles` ranks the universe; the
 * top `topK` are held at equal weight and the rest rotate to cash as ranks shift.
 */
const RebalanceMomentumSchema = z.object({
  lookbackCandles: z
    .number()
    .int()
    .min(2)
    .max(500)
    .default(30)
    .describe('How many candles back to measure each symbol’s return for ranking.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(3)
    .describe('Hold this many top-ranked symbols at equal weight; the rest rotate to cash.'),
});

/**
 * Operator-owned basket config. Two weight modes share one order engine:
 * `fixed` holds a fixed-weight basket and trades back toward the weights when one
 * drifts (volatility harvesting); `momentum` ignores the per-target weights and
 * instead equal-weights the top-K symbols by trailing return, rotating as the
 * cross-sectional ranking changes (the strong form of momentum the single-symbol
 * EMA cross lacks; the listed targets are the ranked universe, their weights
 * ignored). Both are cross-symbol, so they ride the #267 KV seam. `enabled`
 * defaults FALSE — inert until the operator has backtested it on.
 */
export const RebalanceConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe('Master switch. Off by default; turn on only after backtesting a target basket.'),
  weightMode: z
    .enum(['fixed', 'momentum'])
    .default('fixed')
    .describe(
      'How target weights are set: fixed = your configured per-symbol shares; momentum = equal-weight the top-K symbols by trailing return. In momentum mode the symbols you list in targets are the universe that gets ranked; their weights are ignored.',
    ),
  momentum: RebalanceMomentumSchema.default(() => RebalanceMomentumSchema.parse({})).describe(
    'Cross-sectional momentum tuning (used only when weightMode is momentum).',
  ),
  candleInterval: z
    .enum(REBALANCE_CANDLE_INTERVALS)
    .default(REBALANCE_DEFAULT_INTERVAL)
    .describe('Candle interval the strategy evaluates on.'),
  targets: z
    .array(RebalanceTargetSchema)
    // Weights must sum to at most 1 — the deployment budget bounds total spend
    // only if the basket never targets more than 100% of it, so an over-1 basket
    // is rejected rather than silently over-allocating the budget.
    .refine((ts) => weightSum(ts).lte(1), { message: 'target weights must sum to at most 1' })
    .default([])
    .describe('The basket: each symbol and its target share. Shares must sum to at most 1.'),
  driftThreshold: decimalString('driftThreshold must be in (0, 1)', { gt: 0, lt: 1 })
    .default('0.05')
    .describe(
      '@ui:percent-of How far a symbol’s share may drift from its target before a rebalance fires. 5 means rebalance once a holding is 5 percentage points off target.',
    ),
  minTradeQuote: decimalString('minTradeQuote must be a positive decimal', { gt: 0 })
    .default('10')
    .describe(
      '@ui:price Skip rebalances smaller than this many quote units, so fees and dust don’t churn the basket.',
    ),
  basketBudgetQuote: decimalString('basketBudgetQuote must be a non-negative decimal', { gte: 0 })
    .default('0')
    .describe(
      '@ui:price Total quote (e.g. USDT) to put into this basket. The strategy deploys free cash up to this amount across the targets, then holds the weights. 0 means maintain an existing basket only and never spend cash — set this to buy in from cash.',
    ),
});
export type RebalanceConfig = z.infer<typeof RebalanceConfigSchema>;

/**
 * Per-symbol override: only the weight may differ per symbol (the rest are
 * profile-wide). Strict so an unknown key is rejected.
 */
export const RebalanceOverrideConfigSchema = z
  .object({ targets: RebalanceConfigSchema.shape.targets.unwrap() })
  .partial()
  .strict();
export type RebalanceOverrideConfig = z.infer<typeof RebalanceOverrideConfigSchema>;

export const REBALANCE_STATE_SCHEMA_VERSION = '1.0.0';

/** Persisted per-(profile, symbol) state: just the held position. */
export const RebalanceStateSchema = z.object({
  schemaVersion: z.literal(REBALANCE_STATE_SCHEMA_VERSION),
  avgEntryPrice: z.string().nullable(),
  heldQuantity: z.string().nullable(),
});
export type RebalanceState = z.infer<typeof RebalanceStateSchema>;

/** Rebalance reads no per-tick bundle. */
export const RebalanceBundleSchema = z.object({});
export type RebalanceBundle = z.infer<typeof RebalanceBundleSchema>;

export const initialRebalanceState = (): RebalanceState => ({
  schemaVersion: REBALANCE_STATE_SCHEMA_VERSION,
  avgEntryPrice: null,
  heldQuantity: null,
});

/** Schema-valid seed config the create-profile wizard pre-fills (inert: enabled off, no targets). */
export const defaultRebalanceConfig = (): RebalanceConfig => RebalanceConfigSchema.parse({});
