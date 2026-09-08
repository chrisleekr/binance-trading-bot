import { Decimal } from '@app/money';

import { coerceDec } from './config-coerce.js';
import type { MomentumConfig } from './schema.js';

/** Activation threshold as a fraction in (0, 1), else the schema default. Live config is unparsed. */
const activationPct = (raw: unknown): Decimal => coerceDec(raw, { fallback: '0.05' });

/** Pullback fraction in (0, 1), else the schema default. */
const trailPct = (raw: unknown): Decimal => coerceDec(raw, { fallback: '0.03' });

/**
 * Resolve the profit leg's fixed retrace distance only after its high-water mark clears activation. Shared by level resolution, native-trail sizing, and exit attribution so those three consumers cannot drift onto different thresholds.
 *
 * @param config - The possibly unparsed momentum config whose profit-trail defaults must be applied defensively.
 * @param profitHigh - The persisted profit-side high-water mark, or null while no mark exists.
 * @param entryPrice - The open position's cost basis, which anchors activation.
 * @returns The configured profit retrace fraction when armed, otherwise null.
 */
export const profitLegDistance = (
  config: MomentumConfig,
  profitHigh: Decimal | null,
  entryPrice: Decimal,
): Decimal | null => {
  const cfg = config.profitTrail;
  if (cfg?.enabled !== true || profitHigh === null) return null;
  const activation = entryPrice.mul(new Decimal(1).plus(activationPct(cfg.activationPct)));
  return profitHigh.gte(activation) ? trailPct(cfg.trailPct) : null;
};
