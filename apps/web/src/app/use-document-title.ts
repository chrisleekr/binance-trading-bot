// Per-route `document.title`, colocated on each route as `staticData.title`.
// Without a title every page shows the bare app name, so browser tabs, history
// entries, and bookmarks are indistinguishable. Colocating the title on the
// route rather than a central route-id map keeps titles from drifting when
// routes are re-nested or renamed; the symbol routes derive their title from
// the URL param, so a title is a function of the match's params.

import { useMatches } from '@tanstack/react-router';
import { useEffect } from 'react';

const APP_NAME = 'binance-trading-bot';

/** A route's page title: a fixed string, or a function of the route's params. */
export type RouteTitle = string | ((params: Record<string, string>) => string);

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: RouteTitle;
  }
}

/**
 * The page-name portion of the document title, resolved from the matched route
 * chain. Walks leaf→root and returns the first route that declares a
 * `staticData.title`, resolving the function form against that match's params.
 * Returns null when no matched route sets a title, so the caller shows the bare
 * app name. Pure and exported for unit testing.
 */
export function titleFromMatches(
  matches: { staticData?: { title?: RouteTitle }; params?: Record<string, string> }[],
): string | null {
  for (let i = matches.length - 1; i >= 0; i--) {
    const title = matches[i]?.staticData?.title;
    if (title === undefined) continue;
    return typeof title === 'function' ? title(matches[i]?.params ?? {}) : title;
  }
  return null;
}

/**
 * Sets `document.title` from the active route chain. Mounted once at the router
 * root; re-runs whenever the resolved page title changes.
 */
export function useDocumentTitle(): void {
  const matches = useMatches();
  const page = titleFromMatches(matches);
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
