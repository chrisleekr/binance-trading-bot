import { describe, it, expect } from 'vitest';
import { evaluateRiskCaps } from '../src/branches/risk-caps.js';
import type { TTConfig, TTState } from '../src/schema.js';

/**
 * Minimal config/state builders. `evaluateRiskCaps` reads only
 * `buy.{maxSymbolExposureQuote,maxPositionLossQuote}`, `sell.stopLossPercentage`
 * and `state.{avgEntryPrice,heldQuantity}`, so the casts keep the fixtures
 * focused on the fields under test.
 */
const cfg = (over: {
  maxSymbolExposureQuote?: string;
  maxPositionLossQuote?: string;
  maxAccountExposureQuote?: string; // amount-mode account cap shorthand
  accountCapPercent?: string; // percent-mode account cap shorthand
  stopLossPercentage?: string;
  sellEnabled?: boolean;
}): TTConfig => {
  const amt = over.maxAccountExposureQuote ?? '';
  const accountCap = over.accountCapPercent
    ? { mode: 'percent' as const, percent: over.accountCapPercent }
    : amt === '' || amt === '0'
      ? { mode: 'off' as const }
      : { mode: 'amount' as const, amount: amt };
  return {
    buy: {
      maxSymbolExposureQuote: over.maxSymbolExposureQuote ?? '',
      maxPositionLossQuote: over.maxPositionLossQuote ?? '',
      accountCap,
    },
    // A configured stop only bounds the loss when the sell side is enabled.
    sell: { enabled: over.sellEnabled ?? true, stopLossPercentage: over.stopLossPercentage ?? '' },
  } as unknown as TTConfig;
};

const flat: TTState = {
  avgEntryPrice: null,
  heldQuantity: null,
} as unknown as TTState;

const held = (avgEntryPrice: string, heldQuantity: string): TTState =>
  ({ avgEntryPrice, heldQuantity }) as unknown as TTState;

describe('evaluateRiskCaps', () => {
  it('returns null when both caps are disabled (empty / zero)', () => {
    expect(evaluateRiskCaps(cfg({}), held('50000', '1'), '1', '50000')).toBeNull();
    expect(
      evaluateRiskCaps(
        cfg({ maxSymbolExposureQuote: '0', maxPositionLossQuote: '0' }),
        held('50000', '1'),
        '1',
        '50000',
      ),
    ).toBeNull();
  });

  describe('exposure cap', () => {
    it('vetoes a fresh entry whose notional exceeds the cap', () => {
      // deployedSoFar = 0; addNotional = 0.01 * 50000 = 500 > cap 400.
      const veto = evaluateRiskCaps(cfg({ maxSymbolExposureQuote: '400' }), flat, '0.01', '50000');
      expect(veto?.cap).toBe('exposure-cap');
      expect(veto?.context.projectedDeployed).toBe('500');
    });

    it('allows a level when projected deployed stays at or below the cap', () => {
      // projected exactly equal to the cap is allowed (gt, not gte).
      expect(
        evaluateRiskCaps(cfg({ maxSymbolExposureQuote: '500' }), flat, '0.01', '50000'),
      ).toBeNull();
    });

    it('adds the new level onto the already-deployed quote of the open position', () => {
      // deployedSoFar = 48000 * 0.02 = 960; add = 0.01 * 50000 = 500 → 1460 > 1000.
      const veto = evaluateRiskCaps(
        cfg({ maxSymbolExposureQuote: '1000' }),
        held('48000', '0.02'),
        '0.01',
        '50000',
      );
      expect(veto?.cap).toBe('exposure-cap');
      expect(veto?.context.projectedDeployed).toBe('1460');
    });
  });

  describe('loss budget', () => {
    it('vetoes when worst-case loss at the stop exceeds the budget', () => {
      // projectedDeployed = 500; stop 0.97 → lossFraction 0.03 → worst-case 15 > 10.
      const veto = evaluateRiskCaps(
        cfg({ maxPositionLossQuote: '10', stopLossPercentage: '0.97' }),
        flat,
        '0.01',
        '50000',
      );
      expect(veto?.cap).toBe('loss-budget');
      expect(veto?.context.projectedWorstCaseLoss).toBe('15');
    });

    it('allows when worst-case loss stays within the budget', () => {
      // worst-case 15 <= budget 15.
      expect(
        evaluateRiskCaps(
          cfg({ maxPositionLossQuote: '15', stopLossPercentage: '0.97' }),
          flat,
          '0.01',
          '50000',
        ),
      ).toBeNull();
    });

    it('treats a disabled stop-loss as a full-loss (price→0) worst case', () => {
      // No stop: worst-case loss = full deployed 500 > budget 100.
      const veto = evaluateRiskCaps(
        cfg({ maxPositionLossQuote: '100', stopLossPercentage: '' }),
        flat,
        '0.01',
        '50000',
      );
      expect(veto?.cap).toBe('loss-budget');
      expect(veto?.context.projectedWorstCaseLoss).toBe('500');
    });

    it('treats a configured-but-disabled sell side as full-loss (the stop will not fire)', () => {
      // stopLossPercentage 0.97 is set, but sell.enabled is false, so the stop
      // never executes → worst case is the full deployed 500, not 500 * 0.03.
      const veto = evaluateRiskCaps(
        cfg({ maxPositionLossQuote: '100', stopLossPercentage: '0.97', sellEnabled: false }),
        flat,
        '0.01',
        '50000',
      );
      expect(veto?.cap).toBe('loss-budget');
      expect(veto?.context.projectedWorstCaseLoss).toBe('500');
    });
  });

  describe('account exposure cap', () => {
    it('vetoes when the account-wide total plus the new level exceeds the cap', () => {
      // account total 900 (across other profiles) + add 0.01 * 50000 = 500 → 1400 > 1000.
      const veto = evaluateRiskCaps(
        cfg({ maxAccountExposureQuote: '1000' }),
        flat,
        '0.01',
        '50000',
        '900',
      );
      expect(veto?.cap).toBe('account-exposure-cap');
      expect(veto?.context.capQuote).toBe('1000');
      expect(veto?.context.projectedDeployed).toBe('1400');
    });

    it('allows when the account-wide total plus the new level stays at or below the cap', () => {
      // 900 + 100 = 1000, not > 1000 (gt, not gte).
      expect(
        evaluateRiskCaps(cfg({ maxAccountExposureQuote: '1000' }), flat, '0.002', '50000', '900'),
      ).toBeNull();
    });

    it('resolves a percent cap against equity (pct × equity)', () => {
      // cap 50% of equity 2000 = 1000; deployed 900 + add 500 = 1400 > 1000 → veto.
      const veto = evaluateRiskCaps(
        cfg({ accountCapPercent: '0.5' }),
        flat,
        '0.01',
        '50000',
        '900',
        '2000',
      );
      expect(veto?.cap).toBe('account-exposure-cap');
      expect(veto?.context.capQuote).toBe('1000');
    });

    it('treats a malformed equity as 0 for a percent cap (fails closed: any add breaches)', () => {
      // garbage equity → 0 → cap 0.5 × 0 = 0; add 500 > 0 → veto.
      const veto = evaluateRiskCaps(
        cfg({ accountCapPercent: '0.5' }),
        flat,
        '0.01',
        '50000',
        '0',
        'garbage',
      );
      expect(veto?.cap).toBe('account-exposure-cap');
      expect(veto?.context.capQuote).toBe('0');
    });

    it('defaults the account total to 0 when not supplied (only the new level counts)', () => {
      // No 5th arg → account total treated as 0; add 500 <= cap 600 → allowed.
      expect(
        evaluateRiskCaps(cfg({ maxAccountExposureQuote: '600' }), flat, '0.01', '50000'),
      ).toBeNull();
      // ...but the new level alone can still breach: add 500 > cap 400.
      const veto = evaluateRiskCaps(cfg({ maxAccountExposureQuote: '400' }), flat, '0.01', '50000');
      expect(veto?.cap).toBe('account-exposure-cap');
    });

    it('treats a malformed account total as 0 rather than throwing', () => {
      // garbage total → 0; add 500 <= cap 600 → allowed (no throw).
      expect(
        evaluateRiskCaps(
          cfg({ maxAccountExposureQuote: '600' }),
          flat,
          '0.01',
          '50000',
          'not-a-number',
        ),
      ).toBeNull();
    });

    it('fires after the per-symbol caps when several are breached', () => {
      // Symbol exposure cap breached first → exposure-cap wins over account cap.
      const veto = evaluateRiskCaps(
        cfg({ maxSymbolExposureQuote: '400', maxAccountExposureQuote: '100' }),
        flat,
        '0.01',
        '50000',
        '900',
      );
      expect(veto?.cap).toBe('exposure-cap');
    });
  });

  it('reports the exposure cap first when both caps are breached', () => {
    const veto = evaluateRiskCaps(
      cfg({ maxSymbolExposureQuote: '400', maxPositionLossQuote: '1', stopLossPercentage: '0.97' }),
      flat,
      '0.01',
      '50000',
    );
    expect(veto?.cap).toBe('exposure-cap');
  });

  it('returns null on a malformed price or quantity (defers to other guards)', () => {
    expect(
      evaluateRiskCaps(cfg({ maxSymbolExposureQuote: '400' }), flat, 'not-a-number', '50000'),
    ).toBeNull();
    expect(
      evaluateRiskCaps(cfg({ maxSymbolExposureQuote: '400' }), flat, '0.01', 'not-a-number'),
    ).toBeNull();
  });
});
