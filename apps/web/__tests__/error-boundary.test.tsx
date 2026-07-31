import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/shared/components/error-boundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('render-time crash');
  return <p>healthy</p>;
}

function ToggleHarness() {
  const [shouldThrow, setShouldThrow] = useState(true);
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div>
          <p data-testid="fallback-msg">{error.message}</p>
          <button
            type="button"
            onClick={() => {
              setShouldThrow(false);
              reset();
            }}
          >
            recover
          </button>
        </div>
      )}
    >
      <Boom shouldThrow={shouldThrow} />
    </ErrorBoundary>
  );
}

describe('<ErrorBoundary>', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders the default RouteErrorCard when a child throws during render', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('render-time crash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('uses the supplied fallback render prop', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>captured: {error.message}</p>}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('captured: render-time crash')).toBeInTheDocument();
  });

  it('reset clears the captured error so children render again', async () => {
    render(<ToggleHarness />);
    expect(screen.getByTestId('fallback-msg')).toHaveTextContent('render-time crash');
    await userEvent.click(screen.getByRole('button', { name: /recover/i }));
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});
