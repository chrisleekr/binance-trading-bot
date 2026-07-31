import { Component, type ErrorInfo, type ReactNode } from 'react';

import { RouteErrorCard } from '@/shared/components/route-error-card';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// Top-level render-time error fallback. v1.0 has no third-party reporter
// (no Sentry, no Bugsnag); operator visibility comes from the in-app card
// and the API's structured logs.
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <RouteErrorCard error={error} onRetry={this.reset} />;
  }
}
