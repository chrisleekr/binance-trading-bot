// Per-route `document.title`, colocated on each route as `staticData.title`.
// Without a title every page shows the bare app name, so browser tabs, history
// entries, and bookmarks are indistinguishable. Colocating the title on the
// route rather than a central route-id map keeps titles from drifting when
// routes are re-nested or renamed; the symbol routes derive their title from
// the URL param, so a title is a function of the match's params.

import { useMatches } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useCrumbs } from '@/shared/components/breadcrumb';

const APP_NAME = 'binance-trading-bot';

/** A route's page title: a fixed string, or a function of the route's params. */
export type RouteTitle = string | ((params: Record<string, string>) => string);

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    title?: RouteTitle;
    /** Breadcrumb label, when the document title would read wrong as a rung. A title is written to stand alone in a browser tab, so it often repeats an ancestor; a crumb only has to name this step. Falls back to `title`, so most routes never set it. */
    crumb?: RouteTitle;
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
 * Sets `document.title` from the active route chain. Mounted once at the router root; re-runs whenever the resolved page title changes.
 *
 * A leaf that declares no title of its own is named by the breadcrumb's last rung instead. That is the profile overview, whose identity is the profile's operator-given name and so cannot be a static string: without this it inherited its layout parent's generic "Profile" while the page's own `<h1>` said the name.
 */
export function useDocumentTitle(): void {
  const matches = useMatches();
  const crumbs = useCrumbs();
  const leafDeclaresTitle = matches.at(-1)?.staticData?.title !== undefined;
  const page = leafDeclaresTitle
    ? titleFromMatches(matches)
    : (crumbs.at(-1)?.label ?? titleFromMatches(matches));
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
