// Panel — the one titled-section container for editor/settings surfaces. The
// contract its doc-comment stresses: a chevron/<details> disclosure renders ONLY
// when `collapsible`, so the static form never lies about being clickable.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from '@/shared/components/panel';

describe('Panel', () => {
  it('renders a static <section> with no <details> or chevron when not collapsible', () => {
    const { container } = render(<Panel title="Timezone">body</Panel>);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('section')).not.toBeNull();
    // The static title is a real heading.
    expect(screen.getByRole('heading', { name: 'Timezone' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders a <details> disclosure honouring defaultOpen when collapsible', () => {
    const { container, rerender } = render(
      <Panel title="Advanced" collapsible defaultOpen={false}>
        body
      </Panel>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    // Children stay mounted while collapsed (details only hides them), so form
    // state and validation survive a closed section.
    expect(screen.getByText('body')).toBeInTheDocument();

    rerender(
      <Panel title="Advanced" collapsible defaultOpen>
        body
      </Panel>,
    );
    expect(container.querySelector('details')).toHaveAttribute('open');
  });

  it('renders the actions slot in both the static and collapsible forms', () => {
    const { rerender } = render(
      <Panel title="X" actions={<span data-testid="act">A</span>}>
        body
      </Panel>,
    );
    expect(screen.getByTestId('act')).toBeInTheDocument();

    rerender(
      <Panel title="X" collapsible actions={<span data-testid="act">A</span>}>
        body
      </Panel>,
    );
    expect(screen.getByTestId('act')).toBeInTheDocument();
  });

  it('places summaryTestId on the <summary> of a collapsible panel', () => {
    render(
      <Panel title="X" collapsible summaryTestId="toggle">
        body
      </Panel>,
    );
    expect(screen.getByTestId('toggle').tagName).toBe('SUMMARY');
  });

  it('renders the description in both forms', () => {
    const { rerender } = render(
      <Panel title="X" description="what this does">
        body
      </Panel>,
    );
    expect(screen.getByText('what this does')).toBeInTheDocument();
    rerender(
      <Panel title="X" collapsible description="what this does">
        body
      </Panel>,
    );
    expect(screen.getByText('what this does')).toBeInTheDocument();
  });
});
