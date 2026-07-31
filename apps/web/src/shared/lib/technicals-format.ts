// Shared presentation for a Technicals recommendation tier. The rating is
// computed locally from Binance klines (an earlier TradingView scanner was
// retired — see docs/architecture/technicals.md); these maps turn the
// upstream SCREAMING_SNAKE enum into the operator-facing label, badge
// variant, and text tone. Centralised here so the symbol panel, the profile
// coin grid, and the audit log cannot drift to three different spellings or
// colour conventions for the same verdict.

import type { TechnicalsRecommendation } from '@app/contracts';

/** Human-readable verdict label — the upstream enum is SCREAMING_SNAKE. */
export const RECOMMENDATION_LABEL: Record<TechnicalsRecommendation, string> = {
  STRONG_BUY: 'Strong buy',
  BUY: 'Buy',
  NEUTRAL: 'Neutral',
  SELL: 'Sell',
  STRONG_SELL: 'Strong sell',
};

/** Badge variant per tier; tinted semantic fill (up = buy/green, down = sell/red). */
export const RECOMMENDATION_VARIANT: Record<TechnicalsRecommendation, 'up' | 'down' | 'outline'> = {
  STRONG_BUY: 'up',
  BUY: 'up',
  NEUTRAL: 'outline',
  SELL: 'down',
  STRONG_SELL: 'down',
};

/**
 * Text-colour class per tier, mirroring {@link RECOMMENDATION_VARIANT} but as a
 * plain colour so a single verdict reads at a glance wherever a full badge is
 * too heavy (the technicals tab strip, the audit row spectrum).
 */
export const RECOMMENDATION_TONE: Record<TechnicalsRecommendation, string> = {
  STRONG_BUY: 'text-up',
  BUY: 'text-up',
  NEUTRAL: 'text-muted-fg',
  SELL: 'text-down',
  STRONG_SELL: 'text-down',
};

/**
 * Lenient label lookup for untyped payloads (e.g. pino-preserved audit log
 * tokens). Falls back to the raw token so a future upstream tier still renders
 * rather than vanishing; non-string input reads as "unknown".
 */
export const recommendationLabel = (raw: unknown): string =>
  typeof raw === 'string'
    ? ((RECOMMENDATION_LABEL as Record<string, string>)[raw] ?? raw)
    : 'unknown';

/** Lenient tone lookup; unknown or non-string tokens stay muted. */
export const recommendationTone = (raw: unknown): string =>
  typeof raw === 'string'
    ? ((RECOMMENDATION_TONE as Record<string, string>)[raw] ?? 'text-muted-fg')
    : 'text-muted-fg';
