import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RouteErrorCard } from '@/shared/components/route-error-card';

describe('<RouteErrorCard>', () => {
  it('renders error message and a Retry button', () => {
    render(<RouteErrorCard error={new Error('boom')} onRetry={() => undefined} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('falls back to a generic message when error has no message', () => {
    render(<RouteErrorCard error={null} onRetry={() => undefined} />);
    expect(screen.getByText(/unknown error/i)).toBeInTheDocument();
  });

  it('does not advertise any third-party error reporter affordance', () => {
    render(<RouteErrorCard error={new Error('boom')} onRetry={() => undefined} />);
    const card = screen.getByTestId('route-error-card');
    expect(card.textContent ?? '').not.toMatch(/sentry|bugsnag|report/i);
  });

  it('invokes onRetry when the button is clicked', async () => {
    const onRetry = vi.fn();
    render(<RouteErrorCard error={new Error('boom')} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
