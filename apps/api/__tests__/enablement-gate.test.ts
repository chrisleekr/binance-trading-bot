import { describe, expect, it, vi } from 'vitest';

import { assertLiveEnablementAllowed, type EnablementGateArgs } from '../src/enablement-gate.js';

// The gate no longer consults backtests — backtest quality never blocks enabling.
// The only thing it still refuses is a structurally unrunnable profile (unknown
// strategy) going live; every other path is a pass-through.
const gateArgs = (over: Partial<EnablementGateArgs>): EnablementGateArgs => ({
  strategies: {
    describeForProfile: vi.fn().mockReturnValue({
      status: 'ok',
      strategy: { configSchema: { parse: (c: unknown) => c } },
    }),
  } as never,
  binanceMode: 'live',
  enablementPolicy: {},
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  ...over,
});

describe('assertLiveEnablementAllowed', () => {
  it('passes a test-mode profile without checking the strategy', () => {
    const describeForProfile = vi.fn();
    expect(() =>
      assertLiveEnablementAllowed(
        gateArgs({ binanceMode: 'test', strategies: { describeForProfile } as never }),
      ),
    ).not.toThrow();
    expect(describeForProfile).not.toHaveBeenCalled();
  });

  it('passes when the policy is turned off', () => {
    const describeForProfile = vi.fn();
    expect(() =>
      assertLiveEnablementAllowed(
        gateArgs({
          enablementPolicy: { enabled: false },
          strategies: { describeForProfile } as never,
        }),
      ),
    ).not.toThrow();
    expect(describeForProfile).not.toHaveBeenCalled();
  });

  it('allows enabling a known strategy live (backtest quality never blocks)', () => {
    expect(() => assertLiveEnablementAllowed(gateArgs({}))).not.toThrow();
  });

  it('allows enabling under the default policy (a null column parses to defaults)', () => {
    expect(() => assertLiveEnablementAllowed(gateArgs({ enablementPolicy: null }))).not.toThrow();
  });

  it('rejects an unknown strategy (structurally unrunnable, would go dark at tick time)', () => {
    let thrown: unknown;
    try {
      assertLiveEnablementAllowed(
        gateArgs({
          strategies: {
            describeForProfile: vi.fn().mockReturnValue({ status: 'unknown' }),
          } as never,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
