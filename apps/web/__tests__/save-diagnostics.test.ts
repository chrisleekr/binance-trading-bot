// notifySaveDiagnostics is the one place the web turns the advisories a
// successful mutation carried back into operator-visible feedback. sonner is
// mocked so the assertions are about what is announced, not about rendering.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notifySaveDiagnostics } from '@/shared/lib/save-diagnostics';

const warning = vi.fn();
vi.mock('sonner', () => ({ toast: { warning: (m: string) => warning(m) } }));

describe('notifySaveDiagnostics', () => {
  beforeEach(() => {
    warning.mockClear();
  });

  it('announces nothing when the field is absent', () => {
    // The absent field is the common path: every clean save takes it, so a
    // spurious toast here would fire on almost every operator action.
    notifySaveDiagnostics(undefined);
    expect(warning).not.toHaveBeenCalled();
  });

  it('announces one warning per distinct cause, in order', () => {
    notifySaveDiagnostics([
      { level: 'warn', code: 'filters-unavailable', message: 'BTCUSDT: rules not loaded.' },
      { level: 'warn', code: 'config-unverified', message: 'Settings could not be read.' },
    ]);
    expect(warning.mock.calls).toEqual([
      ['BTCUSDT: rules not loaded.'],
      ['Settings could not be read.'],
    ]);
  });

  it('collapses one cause across many symbols into a single counted toast', () => {
    // Findings arrive per symbol and a profile may bind up to 50. Sonner shows 3
    // at a time and queues the rest at roughly four seconds each, so the honest
    // version of "all of them" is a count, not a minute of stacked toasts on a
    // 375px screen.
    notifySaveDiagnostics(
      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol) => ({
        level: 'warn' as const,
        code: 'filters-unavailable',
        message: `${symbol}: rules not loaded.`,
      })),
    );
    expect(warning.mock.calls).toEqual([['BTCUSDT: rules not loaded. 3 symbols affected.']]);
  });

  it('shows the server message verbatim', () => {
    // The API owns the operator-facing copy so it can name the exact symbol and
    // the account's Binance environment; restating it here would drift.
    notifySaveDiagnostics([
      {
        level: 'warn',
        code: 'filters-unavailable',
        message: 'ETHUSDT: Binance Testnet trading rules have not loaded yet.',
      },
    ]);
    expect(warning).toHaveBeenCalledWith(
      'ETHUSDT: Binance Testnet trading rules have not loaded yet.',
    );
  });
});
