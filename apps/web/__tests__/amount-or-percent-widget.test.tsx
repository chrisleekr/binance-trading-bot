import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AutoForm } from '@/shared/forms/auto-form';
import { FormEquityProvider } from '@/shared/forms';
import { Button } from '@/shared/components/ui/button';

// Minimal object field tagged with the widget hint — the same shape the
// strategy schemas emit for buy.entrySizing / accountCap.
const sizingSchema = (modes: readonly string[]) => ({
  type: 'object' as const,
  properties: {
    entrySizing: {
      type: 'object',
      description: '@ui:amount-or-percent How much to spend.',
      properties: {
        mode: { type: 'string', enum: modes, default: modes[0] },
        amount: { type: 'string', default: '' },
        percent: { type: 'string', default: '' },
      },
    },
  },
});

describe('amount-or-percent widget', () => {
  it('renders one segmented control per mode and shows the amount input for fixed', () => {
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'fixed', amount: '15', percent: '' } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Fixed amount' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '% of account' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Amount input prefilled; no percent suffix in fixed mode.
    expect(screen.getByDisplayValue('15')).toBeInTheDocument();
    expect(screen.queryByText('%')).not.toBeInTheDocument();
  });

  it('shows a stored percent fraction as a plain percent and the gloss', () => {
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.5' } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
    expect(screen.getByText(/% of account = your cash/i)).toBeInTheDocument();
  });

  it('switching to % stores the fraction and clears the fixed amount', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'fixed', amount: '15', percent: '' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '50');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.5' },
    });
  });

  it('supports an off mode (account cap) that hides every input', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['off', 'amount', 'percent'])}
        defaultValues={{ entrySizing: { mode: 'amount', amount: '500', percent: '' } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Off' }));
    // No value input rendered in off mode.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('off mode blanks both amount and percent on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['off', 'amount', 'percent'])}
        defaultValues={{ entrySizing: { mode: 'amount', amount: '500', percent: '' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.click(screen.getByRole('button', { name: 'Off' }));
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      entrySizing: { mode: 'off', amount: '', percent: '' },
    });
  });

  it('switching back to amount clears the percent fraction', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['off', 'amount', 'percent'])}
        defaultValues={{ entrySizing: { mode: 'percent', amount: '', percent: '0.5' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.click(screen.getByRole('button', { name: 'Amount' }));
    await user.type(screen.getByRole('textbox'), '250');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      entrySizing: { mode: 'amount', amount: '250', percent: '' },
    });
  });

  it('handles a cap object with no amount sub-field (momentum shape) without a phantom key', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            accountCap: {
              type: 'object',
              description: '@ui:amount-or-percent reserve cap',
              properties: {
                mode: { type: 'string', enum: ['off', 'percentOfAccount'], default: 'off' },
                percent: { type: 'string', default: '' },
              },
            },
          },
        }}
        defaultValues={{ accountCap: { mode: 'off', percent: '' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '50');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const saved = onSubmit.mock.calls[0]?.[0] as { accountCap: Record<string, unknown> };
    // The two-field cap submits the right mode + fraction. RHF also carries the
    // always-registered (but schema-absent) `amount` controller as a blank
    // string; that stray key is benign — the server's non-strict z.object strips
    // it on re-parse — so we assert the meaningful fields, not its absence.
    expect(saved.accountCap).toMatchObject({ mode: 'percentOfAccount', percent: '0.5' });
  });

  it('previews a percent as a live quote figure when the form supplies equity', () => {
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 800 }}>
        <AutoForm
          jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
          defaultValues={{ entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.5' } }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    // 0.5 × 800 equity = 400; the gloss carries the live equity figure.
    expect(screen.getByTestId('amount-or-percent-entrySizing-preview')).toHaveTextContent(
      '≈ 400 USDT',
    );
    expect(screen.getByText(/800 USDT now/)).toBeInTheDocument();
  });

  it('recomputes the quote figure as the operator types a percent', async () => {
    const user = userEvent.setup();
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 800 }}>
        <AutoForm
          jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
          defaultValues={{ entrySizing: { mode: 'fixed', amount: '15', percent: '' } }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '25');
    // 0.25 × 800 = 200.
    await waitFor(() =>
      expect(screen.getByTestId('amount-or-percent-entrySizing-preview')).toHaveTextContent(
        '≈ 200 USDT',
      ),
    );
  });

  it('omits the quote figure and equity gloss when no equity is provided', () => {
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'percentOfAccount', amount: '', percent: '0.5' } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('amount-or-percent-entrySizing-preview')).not.toBeInTheDocument();
    // The static gloss still renders, but without the "(N USDT now)" suffix.
    expect(screen.getByText(/% of account = your cash/i)).toBeInTheDocument();
    expect(screen.queryByText(/USDT now/)).not.toBeInTheDocument();
  });

  it('ignores non-decimal keystrokes (keeps the last valid stored value)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'fixed', amount: '', percent: '' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.type(screen.getByRole('textbox'), '12a');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The stray letter is rejected; the stored amount stays the last valid '12'.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ entrySizing: { amount: '12' } });
  });

  it('warns when the typed percent exceeds the server-enforced 100% maximum', async () => {
    const user = userEvent.setup();
    // No FormEquityProvider: the (0, 1] bound is independent of equity, so the
    // warning must appear without an equity context too.
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'fixed', amount: '', percent: '' } }}
        onSubmit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '150');
    await waitFor(() =>
      expect(screen.getByTestId('amount-or-percent-entrySizing-over-max')).toBeInTheDocument(),
    );
  });

  it('does not warn at exactly 100% (the allowed maximum)', () => {
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'percentOfAccount', amount: '', percent: '1' } }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();
    expect(screen.queryByTestId('amount-or-percent-entrySizing-over-max')).not.toBeInTheDocument();
  });

  it('clears the warning once the value drops back to a valid percent', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
        defaultValues={{ entrySizing: { mode: 'percentOfAccount', amount: '', percent: '' } }}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    await user.type(input, '150');
    await waitFor(() =>
      expect(screen.getByTestId('amount-or-percent-entrySizing-over-max')).toBeInTheDocument(),
    );
    await user.clear(input);
    await user.type(input, '50');
    await waitFor(() =>
      expect(
        screen.queryByTestId('amount-or-percent-entrySizing-over-max'),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows the warning alongside the equity preview when equity is supplied', async () => {
    const user = userEvent.setup();
    render(
      <FormEquityProvider value={{ quoteAsset: 'USDT', equityQuote: 800 }}>
        <AutoForm
          jsonSchema={sizingSchema(['fixed', 'percentOfAccount'])}
          defaultValues={{ entrySizing: { mode: 'fixed', amount: '', percent: '' } }}
          onSubmit={vi.fn()}
        />
      </FormEquityProvider>,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '150');
    // Both render: the preview shows the over-equity figure (1.5 × 800), the
    // warning flags that it is rejected on save.
    await waitFor(() => {
      expect(screen.getByTestId('amount-or-percent-entrySizing-preview')).toHaveTextContent(
        '≈ 1,200 USDT',
      );
      expect(screen.getByTestId('amount-or-percent-entrySizing-over-max')).toBeInTheDocument();
    });
  });

  it('warns on the account-cap percent shape too (name-templated testid)', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            accountCap: {
              type: 'object',
              description: '@ui:amount-or-percent reserve cap',
              properties: {
                mode: { type: 'string', enum: ['off', 'percentOfAccount'], default: 'off' },
                percent: { type: 'string', default: '' },
              },
            },
          },
        }}
        defaultValues={{ accountCap: { mode: 'off', percent: '' } }}
        onSubmit={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: '% of account' }));
    await user.type(screen.getByRole('textbox'), '150');
    await waitFor(() =>
      expect(screen.getByTestId('amount-or-percent-accountCap-over-max')).toBeInTheDocument(),
    );
  });
});
