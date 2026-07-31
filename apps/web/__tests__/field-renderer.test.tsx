// FieldRenderer — after the guided-form rework: a field's description is painted
// inline (always visible) under its label, and a group's description renders as a
// "what this section controls" intro under its header. `@ui:advanced` fields fold
// into a per-section "Advanced settings (N)" disclosure so a section lands as its
// few essential fields. (This reverses issue #507's tap-to-reveal info popover.)

import type { FormField } from '@app/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';

import { FieldRenderer } from '@/shared/forms/field-renderer';

// Wrap the renderer in a react-hook-form context: FieldRenderer's controls call
// useFormContext/useController, which throw without a provider. defaultValues
// seed the bound paths so the controlled inputs render without a console warning.
function Harness({
  field,
  depth,
  defaultOpen,
  defaultValues,
}: {
  field: FormField;
  depth?: number;
  defaultOpen?: boolean;
  defaultValues?: Record<string, unknown>;
}): React.JSX.Element {
  const methods = useForm({ defaultValues: defaultValues ?? {} });
  return (
    <FormProvider {...methods}>
      <FieldRenderer field={field} depth={depth} defaultOpen={defaultOpen} />
    </FormProvider>
  );
}

const scalarField: FormField = {
  kind: 'string',
  path: 'spread',
  label: 'Spread',
  widget: null,
  description: 'Half the bid/ask gap to quote around the mid price.',
  advanced: false,
  required: false,
  defaultValue: '',
};

const groupField: FormField = {
  kind: 'object',
  path: 'buy',
  label: 'Buy',
  widget: null,
  description: 'When and how much the bot buys.',
  advanced: false,
  required: false,
  defaultValue: undefined,
  fields: [scalarField],
};

// A group rendered at depth>0 takes the nested-<fieldset>/<legend> path.
const nestedFieldsetField: FormField = {
  kind: 'object',
  path: 'limits',
  label: 'Limits',
  widget: null,
  description: 'Caps applied to every buy order.',
  advanced: false,
  required: false,
  defaultValue: undefined,
  fields: [scalarField],
};

describe('FieldRenderer inline descriptions', () => {
  it('paints a scalar field description inline, with no info-popover trigger', () => {
    render(<Harness field={scalarField} defaultValues={{ spread: '' }} />);
    // The description is visible without any interaction.
    expect(screen.getByText(scalarField.description as string)).toBeInTheDocument();
    // The old tap-to-reveal trigger is gone.
    expect(screen.queryByRole('button', { name: /about spread/i })).not.toBeInTheDocument();
  });

  it('paints a top-level group description as an inline section intro', () => {
    render(<Harness field={groupField} depth={0} defaultValues={{ buy: { spread: '' } }} />);
    // The group's own description shows in the (always-visible) summary, even
    // while the section is collapsed.
    expect(screen.getByText(groupField.description as string)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /about buy/i })).not.toBeInTheDocument();
  });

  it('paints a nested-fieldset (depth>0) group description inline', () => {
    render(<Harness field={nestedFieldsetField} depth={1} defaultValues={{ spread: '' }} />);
    expect(screen.getByText(nestedFieldsetField.description as string)).toBeInTheDocument();
  });

  it('still toggles a depth-0 collapsible section from its summary', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness field={groupField} depth={0} defaultValues={{ buy: { spread: '' } }} />,
    );
    const details = container.querySelector('details');
    const summary = container.querySelector('summary');
    if (!details || !summary) throw new Error('expected <details>/<summary> for a depth-0 group');
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
  });
});

const advancedChild: FormField = {
  kind: 'string',
  path: 'limits.expert',
  label: 'Expert Knob',
  widget: null,
  description: 'An expert-only knob.',
  advanced: true,
  required: false,
  defaultValue: '',
};

const fieldsetWithAdvanced: FormField = {
  kind: 'object',
  path: 'limits',
  label: 'Limits',
  widget: null,
  description: 'Caps applied to every buy order.',
  advanced: false,
  required: false,
  defaultValue: undefined,
  fields: [scalarField, advancedChild],
};

describe('FieldRenderer advanced fold', () => {
  it('folds @ui:advanced children under an "Advanced settings (N)" disclosure', () => {
    render(
      <Harness field={fieldsetWithAdvanced} depth={1} defaultValues={{ spread: '', expert: '' }} />,
    );
    // The essential field shows; the advanced one sits under a labelled fold
    // (collapsed <details> keeps its children mounted, so both render).
    expect(screen.getByLabelText('Spread')).toBeInTheDocument();
    expect(screen.getByLabelText('Expert Knob')).toBeInTheDocument();
    expect(screen.getByText(/Advanced settings/i)).toBeInTheDocument();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('renders no Advanced fold when a section has no advanced fields', () => {
    render(<Harness field={nestedFieldsetField} depth={1} defaultValues={{ spread: '' }} />);
    expect(screen.queryByText(/Advanced settings/i)).not.toBeInTheDocument();
  });
});

const booleanField: FormField = {
  kind: 'boolean',
  path: 'blockEntry',
  label: 'Block Entry',
  widget: null,
  description: 'Stop opening a new position in a confirmed downtrend.',
  advanced: false,
  required: false,
  defaultValue: false,
};

describe('FieldRenderer boolean accessible name', () => {
  it('names a boolean Switch from its field label', () => {
    // The Radix Switch is a <button>; a sibling <label htmlFor> does not give a
    // button an accessible name, so without an explicit aria-label the toggle is
    // nameless to screen readers and unreachable by role+name in tests.
    render(<Harness field={booleanField} defaultValues={{ blockEntry: false }} />);
    expect(screen.getByRole('switch', { name: 'Block Entry' })).toBeInTheDocument();
  });
});
