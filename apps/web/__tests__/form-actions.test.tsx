// FormActions — the one shared action-row for form/dialog/panel footers: a
// right-aligned row that wraps on narrow (375px) screens so buttons never
// overflow. Row-level extras (a margin, a hairline, a wider gap) ride in through
// `className` and merge onto the base classes rather than replacing them.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormActions } from '@/shared/components/form-actions';

describe('FormActions', () => {
  it('renders its children', () => {
    render(
      <FormActions>
        <button type="button">Cancel</button>
        <button type="submit">Save</button>
      </FormActions>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('lays actions out as a right-aligned, wrapping row', () => {
    const { container } = render(
      <FormActions>
        <button type="submit">Save</button>
      </FormActions>,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveClass('flex', 'flex-wrap', 'justify-end', 'gap-2');
  });

  it('merges a passthrough className onto the base classes', () => {
    const { container } = render(
      <FormActions className="mt-4">
        <button type="submit">Save</button>
      </FormActions>,
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveClass('mt-4');
    expect(row).toHaveClass('flex', 'flex-wrap', 'justify-end', 'gap-2');
  });
});
