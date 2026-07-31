import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SymbolProtectiveStopBlocker } from '@/features/symbol/components/symbol-protective-stop-blocker';
import { glossProtectiveStopBlocker } from '@/shared/lib/gloss-protective-stop-blocker';

describe('<SymbolProtectiveStopBlocker>', () => {
  it('renders nothing when the stop is armed', () => {
    const { container } = render(<SymbolProtectiveStopBlocker protectiveStopBlocker={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the shortfall and tells the operator what to do about it', () => {
    render(
      <SymbolProtectiveStopBlocker
        protectiveStopBlocker={{
          reason: 'base-locked-by-foreign-order',
          detail: { required: '189.87', free: '0' },
        }}
      />,
    );
    const panel = screen.getByTestId('symbol-protective-stop-blocker');
    expect(panel).toHaveTextContent(/protective stop not in place/i);
    // The operator is a solo non-expert: the term is glossed and the fix is named.
    expect(panel).toHaveTextContent(/automatic sell that caps a loss/i);
    expect(panel).toHaveTextContent(/189\.87/);
    expect(panel).toHaveTextContent(/cancel that order on Binance/i);
  });
});

describe('glossProtectiveStopBlocker', () => {
  it('drops the numbers when the detail is absent, and still reads as a sentence', () => {
    const line = glossProtectiveStopBlocker({ reason: 'base-locked-by-foreign-order' });
    expect(line).toMatch(/locked by another sell order/i);
    expect(line).not.toMatch(/undefined/);
  });

  it('never renders blank for a reason code it does not know', () => {
    // A future strategy's code must degrade to a sentence, not an empty panel.
    const line = glossProtectiveStopBlocker({ reason: 'some-future-strategy-reason' });
    expect(line.length).toBeGreaterThan(0);
    expect(line).toMatch(/protective stop/i);
  });
});
