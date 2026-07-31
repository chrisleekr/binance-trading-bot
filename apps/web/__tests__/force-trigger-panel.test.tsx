// ForceTriggerPanel — the force buy/sell buttons are gated per operator action,
// so a strategy that only declares `trigger-sell` (momentum: flatten a held
// position, no manual entry) shows only Force sell, never a Force buy the API
// would 422.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { ForceTriggerPanel } from '../src/features/symbol/components/symbol-trade-panels.js';

const renderPanel = (props: { canBuy: boolean; canSell: boolean }) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ForceTriggerPanel profileId="p1" symbol="BTCUSDT" held {...props} />
    </QueryClientProvider>,
  );

describe('ForceTriggerPanel — per-action buttons', () => {
  it('shows only Force sell when the strategy declares trigger-sell only (momentum)', () => {
    renderPanel({ canBuy: false, canSell: true });
    expect(screen.getByTestId('force-sell')).toBeInTheDocument();
    expect(screen.queryByTestId('force-buy')).not.toBeInTheDocument();
  });

  it('shows both buttons when the strategy declares trigger-buy and trigger-sell', () => {
    renderPanel({ canBuy: true, canSell: true });
    expect(screen.getByTestId('force-buy')).toBeInTheDocument();
    expect(screen.getByTestId('force-sell')).toBeInTheDocument();
  });
});
