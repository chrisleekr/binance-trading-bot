import { describe, expect, it } from 'vitest';

import { PER_PACKAGE_THRESHOLDS } from '../vitest/index.js';
import strategyCore from '../../strategy/core/vitest.config.ts';
import strategyTrailingTrade from '../../strategy/trailing-trade/vitest.config.ts';
import strategyMomentum from '../../strategy/momentum/vitest.config.ts';
import strategyRebalance from '../../strategy/rebalance/vitest.config.ts';
import strategyBacktest from '../../strategy/backtest/vitest.config.ts';
import indicators from '../../indicators/vitest.config.ts';
import discovery from '../../discovery/vitest.config.ts';
import binance from '../../binance/vitest.config.ts';
import llm from '../../llm/vitest.config.ts';
import web from '../../../apps/web/vitest.config.ts';

// Every package listed in PER_PACKAGE_THRESHOLDS must ACTUALLY inject those
// thresholds through its own vitest.config — by passing `packageName` to
// defineProject, or (for a custom config like web's) by sourcing
// `coverageThresholdsFor`. A package listed in the map but whose config does
// not wire the thresholds is a DEAD entry: the gate silently never fires (#488
// — db/api/worker/web/contracts were all inert this way). Importing each
// resolved config and asserting its `coverage.thresholds` match is the only way
// to prove the entry is live. Adding a package to the map forces a new import
// here, which forces wiring its config.
interface ConfigShape {
  test?: { coverage?: { thresholds?: unknown } };
}
const CONFIGS: Record<string, ConfigShape> = {
  '@app/strategy-core': strategyCore,
  '@app/strategy-trailing-trade': strategyTrailingTrade,
  '@app/strategy-momentum': strategyMomentum,
  '@app/strategy-rebalance': strategyRebalance,
  '@app/strategy-backtest': strategyBacktest,
  '@app/indicators': indicators,
  '@app/discovery': discovery,
  '@app/binance': binance,
  '@app/llm': llm,
  '@app/web': web,
};

describe('PER_PACKAGE_THRESHOLDS entries are all live (#488)', () => {
  for (const [pkg, expected] of Object.entries(PER_PACKAGE_THRESHOLDS)) {
    it(`${pkg} actually wires its configured coverage thresholds`, () => {
      const config = CONFIGS[pkg];
      expect(config, `no config imported for ${pkg} — add it to CONFIGS`).toBeDefined();
      expect(config?.test?.coverage?.thresholds).toEqual(expected);
    });
  }

  it('CONFIGS holds no orphan — every imported config is a registered threshold package', () => {
    for (const pkg of Object.keys(CONFIGS)) {
      expect(
        PER_PACKAGE_THRESHOLDS,
        `${pkg} is in CONFIGS but not PER_PACKAGE_THRESHOLDS`,
      ).toHaveProperty(pkg);
    }
  });
});
