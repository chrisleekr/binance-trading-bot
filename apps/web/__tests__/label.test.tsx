import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Label } from '@/shared/components/ui/label';

// The shared Label is block-level so a native <select> (display:inline-block)
// drops below its label instead of sitting crammed inline beside it — the
// app-wide fix for select label spacing. A caller's `flex` (both `block` and
// `flex` are in tailwind-merge's display group, so the later `flex` wins) still
// overrides the default.
describe('Label', () => {
  it('is block-level by default so selects stack below it', () => {
    render(<Label htmlFor="x">Timezone</Label>);
    expect(screen.getByText('Timezone')).toHaveClass('block');
  });

  it('lets a flex className override the default block display', () => {
    render(
      <Label className="flex flex-col" htmlFor="y">
        Amount
      </Label>,
    );
    const el = screen.getByText('Amount');
    expect(el).toHaveClass('flex');
    expect(el).not.toHaveClass('block');
  });
});
