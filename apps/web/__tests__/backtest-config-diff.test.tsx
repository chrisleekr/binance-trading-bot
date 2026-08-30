// Comparing two past backtests is only meaningful next to what was DIFFERENT about them. Two runs over the same window with the same return are either a confirmation or a coincidence depending on whether their settings matched, and nothing on the past-runs screen answers that today.
//
// The three answers this panel can give are not interchangeable and the two wrong pairings are both plausible: an empty diff rendered for two runs that really are identical reads as "the comparison failed", and an empty diff rendered for a run whose config was never recorded reads as "these settings match" — a claim about two configs, one of which nobody has.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BacktestConfigDiff } from '@/features/backtest/components/backtest-config-diff';

/** One side of the comparison, as the Sheet hands it over after fetching both runs by id. */
const side = (
  runId: string,
  configFingerprint: string | null,
  resolvedConfig: Record<string, unknown> | null,
) => ({ runId, label: runId, configFingerprint, resolvedConfig });

const BASE = {
  buy: { maxPurchaseAmount: '100', triggerPercent: '0.98' },
  sell: { stopLossPercent: '0.95' },
};

describe('<BacktestConfigDiff>', () => {
  it('lists each differing parameter with the value on both sides', () => {
    const { container } = render(
      <BacktestConfigDiff
        a={side('run-a', 'fp-a', BASE)}
        b={side('run-b', 'fp-b', {
          ...BASE,
          buy: { maxPurchaseAmount: '250', triggerPercent: '0.98' },
        })}
      />,
    );
    const body = container.textContent ?? '';
    expect(body).toContain('buy.maxPurchaseAmount');
    expect(body).toContain('100');
    expect(body).toContain('250');
    // Settings that agree are noise here: the panel exists to name the few that do not, and listing all of them buries the answer.
    expect(body).not.toContain('sell.stopLossPercent');
  });

  it('states the configs are identical rather than rendering an empty diff', () => {
    // A blank panel is indistinguishable from a broken one. The fingerprint is exactly the fact that separates them, so it is what this branch reads.
    const { container } = render(
      <BacktestConfigDiff a={side('run-a', 'fp-same', BASE)} b={side('run-b', 'fp-same', BASE)} />,
    );
    expect(container.textContent ?? '').toMatch(/identical/i);
  });

  it('states the config is unavailable when a run predates the stamped columns', () => {
    // `config_fingerprint` was added without a backfill, so runs older than it are permanently null. "No differences" would be a claim about a config that was never recorded — the one reading that turns a missing answer into a wrong one.
    const { container } = render(
      <BacktestConfigDiff a={side('run-a', 'fp-a', BASE)} b={side('run-b', null, null)} />,
    );
    const body = container.textContent ?? '';
    expect(body).toMatch(/unavailable/i);
    expect(body).not.toMatch(/identical/i);
    expect(body).not.toMatch(/no differences/i);
  });

  it('states the config is unavailable while a run is still in flight', () => {
    // The fingerprint is stamped at completion, from the config that actually ran, so a running run has no config to compare yet even though its row exists.
    const { container } = render(
      <BacktestConfigDiff a={side('run-a', null, null)} b={side('run-b', 'fp-b', BASE)} />,
    );
    const body = container.textContent ?? '';
    expect(body).toMatch(/unavailable/i);
    expect(body).not.toMatch(/identical/i);
  });

  it('reports a key present on one side and absent from the other', () => {
    // `diffConfig` walks the keys of ONE config, so a setting present in A and missing from B is invisible in that direction. Comparing two runs is symmetric and the union is what makes it so; without it, the panel silently drops exactly the settings a schema change added or removed between runs.
    const { container } = render(
      <BacktestConfigDiff
        a={side('run-a', 'fp-a', { buy: { trailing: { enabled: true } } })}
        b={side('run-b', 'fp-b', { buy: {} })}
      />,
    );
    const body = container.textContent ?? '';
    expect(body).toContain('buy.trailing.enabled');
    // The absent side must say so in words. Rendering nothing there is indistinguishable from a key whose value is empty, and the two mean opposite things to an operator reading which setting changed.
    expect(body).toContain('not set');
  });
});
