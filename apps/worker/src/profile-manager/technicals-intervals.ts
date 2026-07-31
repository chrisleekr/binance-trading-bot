// Strategy-agnostic extract of the operator's configured Technicals
// intervals from a stored profile config. Mirrors the `technicals` /
// `candleInterval` parses in tick-context.ts and apps/api/.../technicals.ts
// so all three sites agree on what "watch these Technicals intervals"
// means at the row level — the worker's technicals-compute cron uses the
// result to enumerate Redis writes per (symbol, interval) pair.

import { TechnicalsBundleConfigSchema } from '@app/contracts';

/**
 * Parse the operator's Technicals intervals out of a raw `profile.config`.
 *
 * Returns the ordered list of interval strings the operator wants the bot to
 * watch. Order is preserved so the web panel's tabs render in the same
 * sequence the operator entered them. An empty array means the operator
 * opted out of Technicals for this profile and the strategy gate falls
 * fully open.
 *
 * Strategy-agnostic: any strategy whose config schema carries a
 * `technicals` block parsable as {@link TechnicalsBundleConfigSchema}
 * works. A strategy without the field falls back to the schema's default
 * (one `1m` interval, buy on STRONG_BUY+BUY, no force-sell) so the worker
 * never produces an empty fetch set by accident.
 */
export const resolveTechnicalsIntervals = (profileConfig: unknown): readonly string[] => {
  const cfg = profileConfig as { technicals?: unknown } | null | undefined;
  const parsed = TechnicalsBundleConfigSchema.safeParse(cfg?.technicals ?? {});
  const block = parsed.success ? parsed.data : TechnicalsBundleConfigSchema.parse({});
  return block.intervals.map((row) => row.interval);
};
