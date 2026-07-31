// SymbolConfigForm — effective-config seeding, override summary, partial-diff
// submit, per-field revert.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  formatValue,
  humanisePath,
  SymbolConfigForm,
} from '../src/features/symbol/components/symbol-config-form.js';

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    buy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxPurchaseAmount: { type: 'string' },
        enabled: { type: 'boolean' },
      },
    },
  },
};

// The profile config carries profile-only keys the override schema omits;
// SymbolConfigForm must strip them so they never enter the form or the diff.
const profileConfig: Record<string, unknown> = {
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: { maxPurchaseAmount: '50', enabled: true },
};

// The form no longer renders its own Save button; the host (SymbolConfigPanel's
// sticky footer) submits it via the `form` attribute. The harness mirrors that
// wiring with an external submit button so these unit tests drive the same path.
function renderForm(props: Parameters<typeof SymbolConfigForm>[0]) {
  return render(
    <>
      <SymbolConfigForm {...props} />
      <button type="submit" form="symbol-config-form" data-testid="symbol-config-save">
        Save
      </button>
    </>,
  );
}

describe('SymbolConfigForm', () => {
  it('seeds the effective config and reports zero overrides when nothing differs', () => {
    renderForm({
      overrideConfigSchema: SCHEMA,
      profileConfig,
      overrideConfig: null,
      onSave: vi.fn(),
    });
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('50');
    expect(screen.getByTestId('override-count')).toHaveTextContent('0 overridden');
  });

  it('seeds from a stored override and lists it in the summary', () => {
    renderForm({
      overrideConfigSchema: SCHEMA,
      profileConfig,
      overrideConfig: { buy: { maxPurchaseAmount: '20' } },
      onSave: vi.fn(),
    });
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('20');
    expect(screen.getByTestId('override-count')).toHaveTextContent('1 overridden');
    expect(screen.getByTestId('override-leaf-buy.maxPurchaseAmount')).toHaveTextContent(
      'profile: 50',
    );
  });

  it('submits only the differing leaf as the override partial', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({ overrideConfigSchema: SCHEMA, profileConfig, overrideConfig: null, onSave });
    const input = screen.getByLabelText('Max Purchase Amount');
    await user.clear(input);
    await user.type(input, '20');
    await user.click(screen.getByTestId('symbol-config-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toEqual({ buy: { maxPurchaseAmount: '20' } });
  });

  it('submits null when the edited config matches the profile config', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderForm({ overrideConfigSchema: SCHEMA, profileConfig, overrideConfig: null, onSave });
    await user.click(screen.getByTestId('symbol-config-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toBeNull();
  });

  it('reverts an overridden field back to the inherited profile value', async () => {
    const user = userEvent.setup();
    renderForm({
      overrideConfigSchema: SCHEMA,
      profileConfig,
      overrideConfig: { buy: { maxPurchaseAmount: '20' } },
      onSave: vi.fn(),
    });
    await user.click(screen.getByTestId('override-revert-buy.maxPurchaseAmount'));
    expect(screen.getByLabelText('Max Purchase Amount')).toHaveValue('50');
    await waitFor(() =>
      expect(screen.getByTestId('override-count')).toHaveTextContent('0 overridden'),
    );
  });
});

describe('formatValue (override-summary leaf rendering)', () => {
  it('prints a scalar as-is', () => {
    expect(formatValue('20')).toBe('20');
    expect(formatValue(false)).toBe('false');
  });

  it('prints array elements inline, recursing into each', () => {
    // `titleCase` is acronym-aware — `usdAmount` humanises to "USD Amount".
    expect(formatValue([{ usdAmount: '100', quantityMultiplier: '2' }])).toBe(
      'USD Amount: 100 · Quantity Multiplier: 2',
    );
  });

  it('prints an object as inline humanised fields, not a raw JSON blob', () => {
    expect(formatValue({ enabled: false, triggerAfterMinutes: 20 })).toBe(
      'Enabled: false · Trigger After Minutes: 20',
    );
  });

  it('renders null, undefined, and an empty array/object as an em dash', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue([])).toBe('—');
    expect(formatValue({})).toBe('—');
  });
});

describe('humanisePath', () => {
  it('turns a dotted path into a breadcrumb of humanised segments', () => {
    expect(humanisePath('buy.gridLevels')).toBe('Buy › Grid Levels');
    expect(humanisePath('buy.autoTriggerBuy')).toBe('Buy › Auto Trigger Buy');
  });
});
