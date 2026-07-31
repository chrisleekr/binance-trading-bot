import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AutoForm } from '@/shared/forms/auto-form';
import { Button } from '@/shared/components/ui/button';

// The percent-converting widget lets the operator type a plain percent while
// the stored config keeps the exact multiplier/fraction decimal-string. These
// tests pin the display (stored -> percent) and the submit (percent -> stored)
// for each direction; the math itself is unit-tested in @app/contracts.

describe('percent-convert widget', () => {
  it('displays a stored below-multiplier as a plain percent', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { trigger: { type: 'string', description: '@ui:percent-below' } },
        }}
        defaultValues={{ trigger: '0.97' }}
        onSubmit={vi.fn()}
      />,
    );
    // 0.97 stored -> "3" shown (3% below), with a % affordance.
    expect(screen.getByRole('textbox')).toHaveValue('3');
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('displays a stored above-multiplier as a plain percent', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { arm: { type: 'string', description: '@ui:percent-above' } },
        }}
        defaultValues={{ arm: '1.05' }}
        onSubmit={vi.fn()}
      />,
    );
    // 1.05 stored -> "5" shown (5% above).
    expect(screen.getByRole('textbox')).toHaveValue('5');
  });

  it('displays a stored fraction as a plain percent', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { trail: { type: 'string', description: '@ui:percent-of' } },
        }}
        defaultValues={{ trail: '0.05' }}
        onSubmit={vi.fn()}
      />,
    );
    // 0.05 stored -> "5" shown (5% of).
    expect(screen.getByRole('textbox')).toHaveValue('5');
  });

  it('stores the below-multiplier when the operator types a percent', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          required: ['stopLoss'],
          properties: { stopLoss: { type: 'string', description: '@ui:percent-below' } },
        }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.type(screen.getByRole('textbox'), '3');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ stopLoss: '0.97' });
  });

  it('stores the above-multiplier for a percent-above field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          required: ['arm'],
          properties: { arm: { type: 'string', description: '@ui:percent-above' } },
        }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.type(screen.getByRole('textbox'), '5');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ arm: '1.05' });
  });

  it('stores the raw fraction for a percent-of field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          required: ['trail'],
          properties: { trail: { type: 'string', description: '@ui:percent-of' } },
        }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.type(screen.getByRole('textbox'), '5');
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ trail: '0.05' });
  });

  it('shows a blank input for the disabled sentinels', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { trigger: { type: 'string', description: '@ui:percent-below' } },
        }}
        defaultValues={{ trigger: '0' }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
