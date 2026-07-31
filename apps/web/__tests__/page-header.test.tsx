import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BackLink, Page, PageHeader } from '@/shared/components/page';

describe('PageHeader', () => {
  it('renders the title as a single h1 with optional meta and description', () => {
    render(<PageHeader title="Account" meta="TestNet" description="Account-wide settings." />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Account');
    expect(screen.getByText('TestNet')).toBeInTheDocument();
    expect(screen.getByText('Account-wide settings.')).toBeInTheDocument();
  });

  it('omits meta and description when not provided', () => {
    render(<PageHeader title="Orphan orders" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Orphan orders');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('renders a provided back control above the title', () => {
    render(<PageHeader title="Backtest" back={<span data-testid="back-slot">Back</span>} />);
    expect(screen.getByTestId('back-slot')).toBeInTheDocument();
  });

  it('keeps the actions container right-aligned when it wraps', () => {
    // `justify-between` only right-aligns the actions while they share the title
    // row. On a narrow screen the flex container wraps them onto their own line,
    // where justify-between has nothing to push against and they collapse to the
    // left. `ml-auto` on the actions container holds the right edge in both
    // cases. Asserted as a class: happy-dom does no layout, so wrapping itself
    // cannot be observed.
    render(<PageHeader title="Backtest" actions={<button data-testid="act">Run</button>} />);
    const actions = screen.getByTestId('act').parentElement;
    expect(actions).not.toBeNull();
    expect(actions?.className).toContain('ml-auto');
  });
});

describe('Page', () => {
  it('wraps children in a vertical-rhythm container, not a second main landmark', () => {
    render(
      <Page>
        <p>body</p>
      </Page>,
    );
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});

describe('BackLink', () => {
  it('renders a "Back" link pointing at the given route', async () => {
    const rootRoute = createRootRoute({
      component: () => <BackLink to="/account" />,
    });
    const accountRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/account',
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([accountRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />,
    );
    const link = await screen.findByRole('link', { name: /back/i });
    expect(link).toHaveAttribute('href', '/account');
  });

  it('accepts a custom label', async () => {
    const rootRoute = createRootRoute({
      component: () => <BackLink to="/">Overview</BackLink>,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />,
    );
    expect(await screen.findByRole('link', { name: 'Overview' })).toBeInTheDocument();
  });
});
