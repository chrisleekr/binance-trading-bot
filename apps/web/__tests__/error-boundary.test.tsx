import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/shared/components/error-boundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('render-time crash');
  return <p>healthy</p>;
}

// Built outside the harness so the render prop is not re-declared per render.
// `react/no-unstable-nested-components` flags component definitions in props as
// well as in a render body, and exempts only prop names matching its
// `propNamePattern` default (`render*`) — `fallback` is not one. ErrorBoundary
// calls the fallback rather than mounting it, so this is a lint accommodation,
// not a correctness fix; hoisting keeps the gate strict for production code
// rather than opening `allowAsProps` for the whole repo.
const recoverFallback = (stopThrowing: () => void) => (error: Error, reset: () => void) => (
  <div>
    <p data-testid="fallback-msg">{error.message}</p>
    <button
      type="button"
      onClick={() => {
        stopThrowing();
        reset();
      }}
    >
      recover
    </button>
  </div>
);

function ToggleHarness() {
  const [shouldThrow, setShouldThrow] = useState(true);
  return (
    <ErrorBoundary fallback={recoverFallback(() => setShouldThrow(false))}>
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
