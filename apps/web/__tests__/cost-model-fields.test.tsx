// CostModelFields — backtest cost-model inputs.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CostModelFields } from '../src/shared/components/cost-model-fields';

const values = {
  initialQuoteBalance: '1000',
  slippageBps: '5',
  makerBps: '10',
  takerBps: '10',
};

describe('CostModelFields', () => {
  it('renders all four fields with their current values and unique ids', () => {
    render(<CostModelFields idPrefix="bt" values={values} onChange={() => () => undefined} />);
    expect(screen.getByLabelText('Starting balance (quote)')).toHaveValue('1000');
    expect(screen.getByLabelText('Slippage (bps)')).toHaveValue('5');
    expect(screen.getByLabelText('Maker fee (bps)')).toHaveValue('10');
    expect(screen.getByLabelText('Taker fee (bps)')).toHaveValue('10');
    expect(document.querySelector('#bt-slippage')).not.toBeNull();
  });

  it('glosses "bps" inline so a non-expert does not need to know the term', () => {
    render(<CostModelFields idPrefix="op" values={values} onChange={() => () => undefined} />);
    // The gloss appears on every fee/slippage field (1 bps = 0.01%).
    expect(screen.getAllByText(/basis points \(1 bps = 0\.01%\)/i).length).toBe(3);
    expect(screen.getByText(/add liquidity/i)).toBeInTheDocument();
    expect(screen.getByText(/take liquidity/i)).toBeInTheDocument();
  });

  it.each([
    ['Starting balance (quote)', 'initialQuoteBalance'],
    ['Slippage (bps)', 'slippageBps'],
    ['Maker fee (bps)', 'makerBps'],
    ['Taker fee (bps)', 'takerBps'],
  ])('wires the %s input to onChange(%s) and no other field', (label, field) => {
    const handlers: Record<string, ReturnType<typeof vi.fn>> = {};
    const onChange = (f: string): React.ChangeEventHandler<HTMLInputElement> => {
      handlers[f] ??= vi.fn();
      return handlers[f];
    };
    render(
      <CostModelFields
        idPrefix="bt"
        values={values}
        onChange={onChange as Parameters<typeof CostModelFields>[0]['onChange']}
      />,
    );
    fireEvent.change(screen.getByLabelText(label), { target: { value: '7' } });
    expect(handlers[field]).toHaveBeenCalledTimes(1);
    // No sibling field's handler fired — guards against a copy-paste key swap.
    for (const other of ['initialQuoteBalance', 'slippageBps', 'makerBps', 'takerBps']) {
      if (other !== field) expect(handlers[other] ?? vi.fn()).not.toHaveBeenCalled();
    }
  });

  it('omits the execution-realism inputs unless a realism block is passed', () => {
    render(<CostModelFields idPrefix="op" values={values} onChange={() => () => undefined} />);
    expect(screen.queryByLabelText('Spread (bps)')).toBeNull();
    expect(screen.queryByLabelText('Max fill per candle (% volume)')).toBeNull();
  });

  it('renders and wires the execution-realism inputs when the realism block is passed', () => {
    const spread = vi.fn();
    const volcap = vi.fn();
    render(
      <CostModelFields
        idPrefix="bt"
        values={values}
        onChange={() => () => undefined}
        realism={{
          values: { spreadBps: '5', volumeCapPct: '25' },
          onChange: (f) => (f === 'spreadBps' ? spread : volcap),
        }}
      />,
    );
    expect(screen.getByLabelText('Spread (bps)')).toHaveValue('5');
    expect(screen.getByLabelText('Max fill per candle (% volume)')).toHaveValue('25');
    fireEvent.change(screen.getByLabelText('Spread (bps)'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Max fill per candle (% volume)'), {
      target: { value: '50' },
    });
    expect(spread).toHaveBeenCalledTimes(1);
    expect(volcap).toHaveBeenCalledTimes(1);
  });
});
