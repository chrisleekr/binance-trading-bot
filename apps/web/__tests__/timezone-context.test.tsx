import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useTimezone } from '@/shared/context/timezone-context';

// The 'UTC' default outside a provider is a load-bearing contract: every panel
// calls useTimezone() unconditionally and must never receive undefined.
function Probe(): React.ReactNode {
  return <span>{useTimezone()}</span>;
}

describe('useTimezone', () => {
  it("returns 'UTC' when consumed outside a TimezoneProvider", () => {
    render(<Probe />);
    expect(screen.getByText('UTC')).toBeInTheDocument();
  });
});
