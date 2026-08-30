// PageHeader / Page — the shell primitives every document-style route composes.
//
// PageHeader now renders the breadcrumb itself rather than taking a `back`
// slot, so these render inside a router: the header's orientation control is
// derived from the active route, and a bare render would not exercise it. The
// trail's own rules live in breadcrumb.test.tsx; here we only pin that the
// header mounts one and still owns title/meta/description/actions.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { Page, PageHeader } from '@/shared/components/page';
import { createQueryClient } from '@/shared/lib/query-client';

/**
 * Mount a node under a two-level route tree so `useMatches` has an ancestor to name.
 *
 * @param node - The element under test, rendered at the leaf route.
 * @returns Nothing; the tree is rendered and its loaders awaited.
 */
const renderAtLeaf = async (node: React.ReactNode): Promise<void> => {
  const root = createRootRoute({ component: () => <Outlet /> });
  const parent = createRoute({
    getParentRoute: () => root,
    path: '/parent',
    staticData: { title: 'Parent' },
    component: () => <Outlet />,
  });
  const leaf = createRoute({
    getParentRoute: () => parent,
    path: '/leaf',
    staticData: { title: 'Leaf' },
    component: () => <>{node}</>,
  });
  const router = createRouter({
    routeTree: root.addChildren([parent.addChildren([leaf])]),
    history: createMemoryHistory({ initialEntries: ['/parent/leaf'] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  await act(async () => {
    await router.load();
  });
};

describe('PageHeader', () => {
  it('renders the title as a single h1 with optional meta and description', async () => {
    await renderAtLeaf(
      <PageHeader title="Account" meta="TestNet" description="Account-wide settings." />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Account');
    expect(screen.getByText('TestNet')).toBeInTheDocument();
    expect(screen.getByText('Account-wide settings.')).toBeInTheDocument();
  });

  it('omits meta and description when not provided', async () => {
    await renderAtLeaf(<PageHeader title="Orphan orders" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Orphan orders');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('renders the breadcrumb itself, so no route has to pass an orientation control', async () => {
    // The `back` slot is gone deliberately: 18 routes each named their own
    // ancestor, and four of them named the wrong one. Deriving the trail here
    // makes that class of mistake unrepresentable.
    await renderAtLeaf(<PageHeader title="Backtest" />);
    expect(await screen.findByTestId('breadcrumb')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^back$/i })).toBeNull();
  });

  it('keeps the actions container right-aligned when it wraps', async () => {
    // `justify-between` only right-aligns the actions while they share the title
    // row. On a narrow screen the flex container wraps them onto their own line,
    // where justify-between has nothing to push against and they collapse to the
    // left. `ml-auto` on the actions container holds the right edge in both
    // cases. Asserted as a class: happy-dom does no layout, so wrapping itself
    // cannot be observed.
    await renderAtLeaf(
      <PageHeader title="Backtest" actions={<button data-testid="act">Run</button>} />,
    );
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
