import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { decimalString } from '@app/contracts';

import { AutoForm } from '@/shared/forms/auto-form';
import { ValidationFailedError } from '@/shared/lib/api';
import { Button } from '@/shared/components/ui/button';

// JSON Schema for a single decimalString field, as the SPA derives it.
const decimalFieldSchema = (bounds: Parameters<typeof decimalString>[1]): Record<string, unknown> =>
  z.toJSONSchema(z.object({ spread: decimalString('Enter a decimal', bounds) }), {
    target: 'draft-07',
    unrepresentable: 'any',
    io: 'input',
  }) as Record<string, unknown>;

// AutoForm renders from JSON Schema (the wire format the API ships) and
// validates client-side via ajv against that same schema. Cross-field
// constraints are intentionally not modelled here — JSON Schema cannot carry
// a zod `.refine()`, so those are enforced server-side on save.

describe('AutoForm', () => {
  it('renders inputs derived from the JSON Schema with labels', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            enabled: { type: 'boolean' },
          },
        }}
        defaultValues={{ symbol: '', enabled: false }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Symbol')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('reports dirty state via onDirtyChange when a field is edited and reverted', async () => {
    const onDirtyChange = vi.fn();
    render(
      <AutoForm
        jsonSchema={{ type: 'object', properties: { symbol: { type: 'string' } } }}
        defaultValues={{ symbol: 'BTC' }}
        onSubmit={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    // Clean on mount: current values match the seeded defaults.
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));

    const field = screen.getByLabelText('Symbol');
    fireEvent.change(field, { target: { value: 'ETH' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    // Reverting to the seeded value clears dirty again (RHF compares to defaults).
    fireEvent.change(field, { target: { value: 'BTC' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('uses the registered percentage widget for a field tagged @ui:percentage', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            stopLoss: { type: 'number', description: '@ui:percentage' },
          },
        }}
        defaultValues={{ stopLoss: 0.5 }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('keeps a string field a string when edited through the percentage widget', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          required: ['stopLoss'],
          properties: {
            stopLoss: { type: 'string', description: '@ui:percentage' },
          },
        }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // A string field renders as a text input (textbox role), not a number
    // spinbutton — a trailing-zero decimal-string must survive byte-for-byte;
    // a native number input would normalise '0.50' to '0.5'.
    await user.type(screen.getByRole('textbox'), '0.50');
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ stopLoss: '0.50' });
  });

  it('coerces a number field to a number through the percentage widget', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          required: ['rsi'],
          properties: {
            rsi: { type: 'number', description: '@ui:percentage' },
          },
        }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // A number field renders as a spinbutton and round-trips as a number,
    // not the string the textbox-typed `string` branch produces.
    await user.type(screen.getByRole('spinbutton'), '5');
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ rsi: 5 });
  });

  it('renders a decimal-keypad text input for a field tagged @ui:decimal', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            stopLoss: { type: 'string', description: '@ui:decimal' },
          },
        }}
        defaultValues={{ stopLoss: '0.97' }}
        onSubmit={vi.fn()}
      />,
    );
    // The decimal widget is a text input with inputMode="decimal" so mobile
    // shows a numeric keypad without the lossy native number coercion.
    const input = screen.getByLabelText('Stop Loss');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveValue('0.97');
  });

  it('falls back to the default widget when the @ui hint is unknown', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            x: { type: 'string', description: '@ui:does-not-exist' },
          },
        }}
        defaultValues={{ x: 'hello' }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('X')).toHaveValue('hello');
  });

  it('reports a per-field validation error on blur', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { n: { type: 'number', minimum: 10 } },
          required: ['n'],
        }}
        defaultValues={{ n: 0 }}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('N');
    await user.click(input);
    await user.tab();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('labels array rows with the singularised label and removes a row on click', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            gridLevels: {
              type: 'array',
              items: {
                type: 'object',
                properties: { triggerPercentage: { type: 'string' } },
              },
            },
          },
        }}
        defaultValues={{
          gridLevels: [{ triggerPercentage: '0.97' }, { triggerPercentage: '0.94' }],
        }}
        onSubmit={vi.fn()}
      />,
    );
    // "Grid Levels" singularises to "Grid Level N" — not the generic "Item N",
    // each rendered exactly once (rows are not double-wrapped in a fieldset).
    expect(screen.getAllByText('Grid Level 1')).toHaveLength(1);
    expect(screen.getAllByText('Grid Level 2')).toHaveLength(1);
    expect(screen.queryByText('Item 1')).not.toBeInTheDocument();
    // The per-row remove control drops that row.
    await user.click(screen.getByLabelText('Remove Grid Level 1'));
    expect(screen.queryByText('Grid Level 2')).not.toBeInTheDocument();
  });

  it('binds a nested array-element field to its indexed path on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            gridLevels: {
              type: 'array',
              items: {
                type: 'object',
                properties: { triggerPercentage: { type: 'string' } },
                required: ['triggerPercentage'],
              },
            },
          },
        }}
        defaultValues={{ gridLevels: [] }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // Add a row, type into its nested field, submit. The element subtree's
    // paths carry a `$item` placeholder from the form-builder; the array
    // renderer must rewrite it to the row index or the value binds to a
    // phantom key and `gridLevels` submits empty.
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByLabelText('Buy-again trigger (below avg cost)'), '0.97');
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      gridLevels: [{ triggerPercentage: '0.97' }],
    });
  });

  it('humanizes enum option labels while keeping the raw value', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            smaBias: { type: 'string', enum: ['off', 'price-below-sma', 'price-above-sma'] },
          },
        }}
        defaultValues={{ smaBias: 'off' }}
        onSubmit={vi.fn()}
      />,
    );
    // Raw enum values render as readable labels; the option value stays raw.
    const opt = screen.getByRole<HTMLOptionElement>('option', { name: 'Price Below SMA' });
    expect(opt.value).toBe('price-below-sma');
  });

  it('seeds a field from the schema default when defaultValues omits it', () => {
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { candleInterval: { type: 'string', default: '1h' } },
        }}
        onSubmit={vi.fn()}
      />,
    );
    // No defaultValues passed — the field still renders at its schema default.
    expect(screen.getByLabelText('Candle Interval')).toHaveValue('1h');
  });

  it('calls onSubmit with the form values on a valid submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: { name: { type: 'string', minLength: 1 } },
          required: ['name'],
        }}
        defaultValues={{ name: '' }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'btc' } });
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ name: 'btc' });
  });

  it('renders a top-level object group as a collapsed <details> with its fields still mounted', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            buy: { type: 'object', properties: { triggerPercentage: { type: 'string' } } },
          },
        }}
        defaultValues={{ buy: { triggerPercentage: '0.97' } }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // The group renders inside a collapsed <details>, but its field stays mounted
    // so react-hook-form/ajv keep the value — the whole point of the disclosure.
    const details = screen.getByText('Buy').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Buy-again trigger (below avg cost)')).toBeInTheDocument();
    // Submitting while the section is collapsed still carries its value through.
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ buy: { triggerPercentage: '0.97' } });
  });

  // Schema whose top level mixes one everyday group and one `@ui:advanced` group.
  const tieredRootSchema = {
    type: 'object' as const,
    properties: {
      buy: { type: 'object', properties: { triggerPercentage: { type: 'string' } } },
      regime: {
        type: 'object',
        description: '@ui:advanced daily trend controls',
        properties: { ma: { type: 'string' } },
      },
    },
  };

  it('folds a top-level @ui:advanced group under a closed "Advanced settings" disclosure', () => {
    render(
      <AutoForm jsonSchema={tieredRootSchema} defaultValues={{ buy: {}, regime: {} }}>
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // The advanced group sits under one "Advanced settings (1)" fold, closed by
    // default so the form lands as its essential groups, not every knob.
    const fold = screen.getByText('Advanced settings').closest('details');
    expect(fold).not.toHaveAttribute('open');
    expect(screen.getByText('(1)')).toBeInTheDocument();
    // The essential group is NOT inside the advanced fold.
    expect(screen.getByText('Buy').closest('details')).not.toBe(fold);
  });

  it('opens the root Advanced disclosure when defaultOpenGroups is set', () => {
    render(
      <AutoForm
        jsonSchema={tieredRootSchema}
        defaultValues={{ buy: {}, regime: {} }}
        defaultOpenGroups
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    expect(screen.getByText('Advanced settings').closest('details')).toHaveAttribute('open');
  });

  it('keeps the root Advanced fold closed when defaultOpenAdvanced is false even with groups open', () => {
    // The profile config opens its essential group panels but keeps the
    // deliberately-tucked advanced knobs folded. The two flags must decouple.
    render(
      <AutoForm
        jsonSchema={tieredRootSchema}
        defaultValues={{ buy: {}, regime: {} }}
        defaultOpenGroups
        defaultOpenAdvanced={false}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    expect(screen.getByText('Buy').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Advanced settings').closest('details')).not.toHaveAttribute('open');
  });

  it('buckets loose top-level fields into a "Core settings" panel, unless groupLooseFields is false', () => {
    const looseSchema = {
      type: 'object' as const,
      properties: { name: { type: 'string' }, spread: { type: 'string' } },
    };
    const { rerender } = render(
      <AutoForm jsonSchema={looseSchema} defaultValues={{ name: '', spread: '' }}>
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    expect(screen.getByText('Core settings')).toBeInTheDocument();

    // A host that supplies its own section panel (e.g. /risk) opts out so the
    // fields don't get a redundant nested box.
    rerender(
      <AutoForm
        jsonSchema={looseSchema}
        defaultValues={{ name: '', spread: '' }}
        groupLooseFields={false}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    expect(screen.queryByText('Core settings')).not.toBeInTheDocument();
  });

  it('blocks submit when a decimalString field is left blank (client-side, not only server)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={decimalFieldSchema({ gt: 0 })}
        defaultValues={{ spread: '' }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    await user.click(screen.getByText('Save'));
    // The blank value must be rejected client-side: onSubmit never fires and the
    // operator gets a visible blocked-submit banner instead of a server round-trip.
    expect(await screen.findByText(/need attention/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a decimalString field once a valid decimal is entered', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <AutoForm
        jsonSchema={decimalFieldSchema({ gt: 0 })}
        defaultValues={{ spread: '' }}
        onSubmit={onSubmit}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    fireEvent.change(screen.getByLabelText('Spread'), { target: { value: '0.5' } });
    await user.click(screen.getByText('Save'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ spread: '0.5' });
  });

  it('maps a server validation issue onto its field inline', async () => {
    // A cross-field rule the JSON Schema can't express: the server rejects it
    // with a zod issue whose `path` points at the offending array element. The
    // form must render that message at the field, not only in a detached banner.
    render(
      <AutoForm
        defaultOpenGroups
        jsonSchema={{
          type: 'object',
          properties: {
            buy: {
              type: 'object',
              properties: {
                gridLevels: {
                  type: 'array',
                  items: { type: 'object', properties: { triggerPercentage: { type: 'string' } } },
                },
              },
            },
          },
        }}
        defaultValues={{ buy: { gridLevels: [{ triggerPercentage: '1.2' }] } }}
        onSubmit={vi.fn()}
        submitError={
          new ValidationFailedError('invalid strategy config', [
            {
              code: 'custom',
              path: ['buy', 'gridLevels', 0, 'triggerPercentage'],
              message: 'gridLevels[0].triggerPercentage must equal 1',
            },
          ])
        }
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    expect(await screen.findByText(/must equal 1/)).toBeInTheDocument();
  });

  it('clears a stale server field error when submitError changes', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const rejected = new ValidationFailedError('invalid', [
      { code: 'custom', path: ['name'], message: 'name is taken' },
    ]);
    const { rerender } = render(
      <AutoForm
        jsonSchema={schema}
        defaultValues={{ name: 'x' }}
        onSubmit={vi.fn()}
        submitError={rejected}
      />,
    );
    expect(await screen.findByText('name is taken')).toBeInTheDocument();
    // A later submit that succeeds (error → undefined) must drop the stale flag,
    // not leave the corrected field marked invalid.
    rerender(<AutoForm jsonSchema={schema} defaultValues={{ name: 'x' }} onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('name is taken')).not.toBeInTheDocument());
  });

  it('ignores a non-validation submit error, leaving it to the caller’s banner', () => {
    render(
      <AutoForm
        jsonSchema={{ type: 'object', properties: { name: { type: 'string' } } }}
        defaultValues={{ name: 'x' }}
        onSubmit={vi.fn()}
        submitError={new Error('network down')}
      />,
    );
    // A generic error is the caller's to surface; AutoForm adds nothing inline.
    expect(screen.queryByText('network down')).not.toBeInTheDocument();
  });

  it('surfaces a blocked-submit banner when a collapsed-group field is invalid', async () => {
    const user = userEvent.setup();
    render(
      <AutoForm
        jsonSchema={{
          type: 'object',
          properties: {
            buy: {
              type: 'object',
              properties: { maxPurchaseAmount: { type: 'number', minimum: 1 } },
              required: ['maxPurchaseAmount'],
            },
          },
        }}
        defaultValues={{ buy: { maxPurchaseAmount: 0 } }}
        onSubmit={vi.fn()}
      >
        <Button type="submit">Save</Button>
      </AutoForm>,
    );
    // No banner until the operator actually tries to save (avoids mid-edit nagging).
    expect(screen.queryByText(/need attention/i)).toBeNull();
    await user.click(screen.getByText('Save'));
    expect(await screen.findByText(/need attention/i)).toBeInTheDocument();
  });
});
