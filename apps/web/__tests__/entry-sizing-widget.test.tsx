import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFieldArray, useFormContext } from 'react-hook-form';

import { AutoForm } from '@/shared/forms/auto-form';
import { FormEquityProvider } from '@/shared/forms';

// A `buy` object carrying the grid-aware entry-sizing widget alongside its
// sibling `gridLevels` array — the shape trailing-trade emits. The widget
// watches `buy.gridLevels` to decide whether entry sizing applies.
const buySchema = (withGrid = true) => ({
  type: 'object' as const,
  properties: {
    buy: {
      type: 'object',
      properties: {
        entrySizing: {
          type: 'object',
          description: '@ui:amount-or-percent-entry How much to spend on the entry buy.',
          properties: {
            mode: { type: 'string', enum: ['fixed', 'percentOfAccount'], default: 'fixed' },
            amount: { type: 'string', default: '' },
            percent: { type: 'string', default: '' },
          },
        },
        ...(withGrid
          ? {
              gridLevels: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { maxPurchaseAmount: { type: 'string', default: '' } },
                },
              },
            }
          : {}),
      },
    },
  },
});

const NOTE_TESTID = 'entry-sizing-grid-note-buy.entrySizing';

// Renders inside the AutoForm's FormProvider and appends a grid level on click,
// so a test can prove the widget reacts to a live sibling change (not just to a
// matching start state) — this exercises siblingGridLevelsPath + the useWatch
// subscription, the project glue the static cases can't catch.
function GridAppender() {
  const { control } = useFormContext();
  const { append } = useFieldArray({ control, name: 'buy.gridLevels' });
  return (
    <button type="button" onClick={() => append({ maxPurchaseAmount: '15' })}>
      add-grid
    </button>
  );
}

describe('entry-sizing widget (grid-aware)', () => {
  it('shows the amount-or-percent control when the grid ladder is empty', () => {
    render(
      <AutoForm
        jsonSchema={buySchema()}
        defaultValues={{
          buy: { entrySizing: { mode: 'fixed', amount: '15', percent: '' }, gridLevels: [] },
        }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fixed amount' })).toBeInTheDocument();
    expect(screen.queryByTestId(NOTE_TESTID)).not.toBeInTheDocument();
  });

  it('replaces the control with a note when a grid ladder is configured', () => {
    render(
      <AutoForm
        jsonSchema={buySchema()}
        defaultValues={{
          buy: {
            entrySizing: { mode: 'fixed', amount: '15', percent: '' },
            gridLevels: [{ maxPurchaseAmount: '15' }],
          },
        }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId(NOTE_TESTID)).toHaveTextContent(/entry sizing is not used here/i);
    // The segmented sizing control is gone — no silent no-op knob.
    expect(screen.queryByRole('button', { name: 'Fixed amount' })).not.toBeInTheDocument();
  });

  it('hides the control for the note when a grid level is added, without a save', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={buySchema()}
        defaultValues={{
          buy: { entrySizing: { mode: 'fixed', amount: '15', percent: '' }, gridLevels: [] },
        }}
        onSubmit={vi.fn()}
      >
        <GridAppender />
      </AutoForm>,
    );
    // Empty grid: the sizing control is live.
    expect(screen.getByRole('button', { name: 'Fixed amount' })).toBeInTheDocument();
    expect(screen.queryByTestId(NOTE_TESTID)).not.toBeInTheDocument();
    // Operator adds a grid level — the control steps aside for the note reactively.
    await user.click(screen.getByRole('button', { name: 'add-grid' }));
    expect(await screen.findByTestId(NOTE_TESTID)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fixed amount' })).not.toBeInTheDocument();
  });

  it('renders the control when the parent has no gridLevels sibling (momentum)', () => {
    render(
      <AutoForm
        jsonSchema={buySchema(false)}
        defaultValues={{ buy: { entrySizing: { mode: 'fixed', amount: '15', percent: '' } } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fixed amount' })).toBeInTheDocument();
    expect(screen.queryByTestId(NOTE_TESTID)).not.toBeInTheDocument();
  });
});

const PREVIEW_TESTID = 'entry-risk-preview-buy.entrySizing';

describe('entry-sizing widget (risk-aware percent preview)', () => {
  it('shows risk per trade and the stop-sized position when a stop is set', () => {
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 1000 }}>
        <AutoForm
          jsonSchema={buySchema(false)}
          defaultValues={{
            buy: { entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.01' } },
            sell: { enabled: true, stopLossPercentage: '0.95' },
          }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    // risk = 1% of 1000 = 10; stop distance 0.05 → position = 10 / 0.05 = 200.
    const preview = screen.getByTestId(PREVIEW_TESTID);
    expect(preview).toHaveTextContent(/Risking/i);
    expect(preview).toHaveTextContent(/per trade/i);
    expect(preview).toHaveTextContent(/position/i);
  });

  it('flags when a tight stop pushes the position to the half-equity cap', () => {
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 1000 }}>
        <AutoForm
          jsonSchema={buySchema(false)}
          defaultValues={{
            buy: { entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.02' } },
            sell: { enabled: true, stopLossPercentage: '0.99' },
          }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    // risk 20 / distance 0.01 = 2000 raw → capped to 0.5 × 1000 = 500.
    expect(screen.getByTestId(PREVIEW_TESTID)).toHaveTextContent(/capped at half your equity/i);
  });

  it('falls back to a spend preview when no stop-loss is set', () => {
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 1000 }}>
        <AutoForm
          jsonSchema={buySchema(false)}
          defaultValues={{
            buy: { entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.01' } },
          }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    expect(screen.getByTestId(PREVIEW_TESTID)).toHaveTextContent(/No active stop-loss/i);
  });

  it('treats a disabled sell side as no active stop (spend preview)', () => {
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 1000 }}>
        <AutoForm
          jsonSchema={buySchema(false)}
          defaultValues={{
            buy: { entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.01' } },
            sell: { enabled: false, stopLossPercentage: '0.95' },
          }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    expect(screen.getByTestId(PREVIEW_TESTID)).toHaveTextContent(/No active stop-loss/i);
  });

  it('shows the static gloss when equity is absent or zero', () => {
    // equityQuote 0 (a freshly funded account before equity loads) hits the same
    // guard as no provider, so it shows the gloss rather than a "Risking ≈ 0" line.
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 0 }}>
        <AutoForm
          jsonSchema={buySchema(false)}
          defaultValues={{
            buy: { entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.01' } },
            sell: { enabled: true, stopLossPercentage: '0.95' },
          }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    expect(screen.getByText(/risk per trade, sized against your stop-loss/i)).toBeInTheDocument();
  });
});
