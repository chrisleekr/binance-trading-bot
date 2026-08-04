// The loading placeholders exist to give a loading page real height: this app
// has no document scroll, so a zero-height loading state leaves a touch landing
// on something with no scroll range and the app reads as frozen. These tests
// pin what makes them safe to render a page-full of — one announcement, no
// motion for readers who opted out — and the bar counts that carry the height.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LoadingRows, PanelStackSkeleton, TableSkeleton } from '@/shared/components/page-skeleton';
import { Skeleton } from '@/shared/components/ui/skeleton';

const bars = (root: Element): number => root.querySelectorAll('[data-skeleton-bar]').length;

describe('skeleton placeholders', () => {
  it('hides individual bars from assistive tech and drops the pulse under reduced motion', () => {
    const { container } = render(<Skeleton className="h-4 w-10" />);
    const bar = container.firstElementChild;
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect(bar?.className).toContain('motion-reduce:animate-none');
  });

  it('announces a stack of rows exactly once', () => {
    const { container } = render(<LoadingRows rows={6} />);
    // One live region for the whole block. A `role="status"` per bar would make
    // a screen reader walk a wall of empty boxes.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    // Each field row is a label bar plus an input bar.
    expect(bars(container)).toBe(12);
  });

  it('renders one panel per shape entry, with that entry as its field count', () => {
    const { container } = render(<PanelStackSkeleton shape={[2, 5]} />);
    const panels = [...container.querySelectorAll('section')];
    expect(panels).toHaveLength(2);
    // Two header bars per panel, then two bars per field row.
    expect(bars(panels[0]!)).toBe(2 + 2 * 2);
    expect(bars(panels[1]!)).toBe(2 + 2 * 5);
  });

  it('announces a whole stack once, not once per panel', () => {
    // A four-panel page would otherwise read "Loading" four times.
    render(<PanelStackSkeleton shape={[3, 3, 3, 3]} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('reserves a page-worth of table rows', () => {
    const { container } = render(<TableSkeleton rows={4} />);
    // A header band of three bars, then three per row: the loaded table's box
    // is already the right size when the data lands, so nothing under the thumb
    // jumps.
    expect(bars(container)).toBe(3 + 3 * 4);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
