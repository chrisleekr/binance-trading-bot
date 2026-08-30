// The single orientation control for nested routes, replacing the bare `Back` link that told you a step existed but never what it led to.
//
// The trail is derived, not authored: every route already declares `staticData.title` for the document title, so a breadcrumb is that same leaf→root walk collecting every entry instead of stopping at the first. A new route therefore gets a correct crumb from the title it already had to write, and a renamed route cannot leave a stale crumb behind.
//
// One label can't come from a route's static data because it names a row, not a route: the profile's operator-given name. It is supplied as an override keyed by route id.

import { Link, useMatches } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

import { useProfileName } from '@/features/profile/lib/use-profile-name';
import { PROFILE_SECTION_LABELS } from '@/features/profile/lib/profile-sections';
import type { RouteTitle } from '@/app/use-document-title';
import { cn } from '@/shared/lib/cn';

/** Route ids whose crumb is a data lookup rather than a static title. */
const PROFILE_ROUTE_ID = '/accounts/$accountId/profiles/$profileId';
const ACCOUNT_ROUTE_ID = '/accounts/$accountId';

export interface Crumb {
  readonly label: string;
  readonly to: string;
  /** The page you are on. Rendered as plain text — a link to here is a no-op. */
  readonly current: boolean;
}

interface CrumbMatch {
  readonly routeId: string;
  readonly pathname: string;
  readonly fullPath?: string | undefined;
  readonly staticData?: { title?: RouteTitle; crumb?: RouteTitle } | undefined;
  readonly params?: Record<string, string> | undefined;
}

/** Trailing-slash-insensitive path equality; `/a/` and `/a` are one place. */
const samePath = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Build the trail from a route-match chain. Pure, so the ordering and de-duping rules are unit-testable without a router.
 *
 * A match contributes a crumb when it can be named. Layout routes that render a bare `<Outlet />` (the account scope, the profile layout's index) declare no title and drop out, which is what keeps `/accounts/$id/profiles/$pid/risk` from producing an unnamed rung. Consecutive matches resolving to the same pathname collapse to one, because an index route and its layout parent are the same place.
 *
 * @param matches - The router's match chain, root→leaf, each carrying its own resolved params.
 * @param overrides - Labels that cannot come from static data, keyed by route id — today only the profile's operator-given name and the account's "Home". A key mapping to an empty string means that data has not loaded yet, and the rung falls back to the route's own static title so the ancestry stays true while the label refines.
 * @returns The trail root→leaf with the last entry marked `current`, or an empty array when nothing above the leaf can be named (a top-level page needs no breadcrumb).
 */
export function buildCrumbs(
  matches: readonly CrumbMatch[],
  overrides: Readonly<Record<string, string>> = {},
): readonly Crumb[] {
  const out: Crumb[] = [];
  for (const m of matches) {
    // A declared-but-empty override means "named by data that has not loaded". It falls through to the route's own static title rather than skipping the rung: dropping an INTERMEDIATE match re-parents everything below it, so a cold load of a profile's Risk page would render "Home > Risk" and state a hierarchy that does not exist.
    const override = overrides[m.routeId] === '' ? undefined : overrides[m.routeId];
    // The section labels win over `staticData.title` so the crumb reads as the
    // nav row the operator clicked ("Risk"), not the page's own longer heading
    // ("Risk controls").
    // PROFILE_ROUTE_ID is excluded deliberately: the Overview nav row shares its path with the profile LAYOUT rung, whose label is the profile's own name. Letting the section map answer here would name that rung after one of its own children, so a cold load would read "Home > Overview > Risk".
    const sectionLabel =
      m.fullPath === undefined || m.fullPath === PROFILE_ROUTE_ID
        ? undefined
        : PROFILE_SECTION_LABELS.get(m.fullPath);
    // `crumb` first: a document title is written to stand alone in a browser
    // tab and often repeats an ancestor, which reads as a stutter in a trail.
    const title = m.staticData?.crumb ?? m.staticData?.title;
    const label =
      override ?? sectionLabel ?? (typeof title === 'function' ? title(m.params ?? {}) : title);
    if (label === undefined || label === '') continue;
    // An index route resolves to its parent's pathname, but carries a trailing
    // slash the parent's does not — so the comparison has to normalise, or the
    // account overview renders "Home > Home". Keep the deeper entry so the crumb
    // links where the operator expects.
    if (samePath(out.at(-1)?.to, m.pathname)) out.pop();
    out.push({ label, to: m.pathname, current: false });
  }
  if (out.length < 2) return [];
  const last = out[out.length - 1];
  if (last) out[out.length - 1] = { ...last, current: true };
  return out;
}

/**
 * The trail for the active route. Returns an empty array on pages that have no ancestor worth naming, so a caller can render it unconditionally.
 *
 * @returns The crumbs root→leaf, last entry `current`.
 */
export function useCrumbs(): readonly Crumb[] {
  const matches = useMatches();
  const leafParams = matches.at(-1)?.params as Record<string, string> | undefined;
  const profileId = leafParams?.['profileId'] ?? '';
  // Its own cache key, not the sidebar's dashboard aggregate, so a hard refresh onto a profile sub-page does pay one round trip. The rung falls back to the route's static title meanwhile, so the trail is complete and only the label refines.
  const profileName = useProfileName(profileId);
  const overrides: Record<string, string> = {};
  if (profileId !== '') overrides[PROFILE_ROUTE_ID] = profileName ?? '';
  // The account is the operator's top scope and is always the trail's root, but
  // its own name adds nothing an operator navigates by — the account switcher
  // in the header already states it. "Home" names the place it links to.
  overrides[ACCOUNT_ROUTE_ID] = 'Home';
  return buildCrumbs(
    matches.map((m) => ({
      routeId: String(m.routeId),
      pathname: m.pathname,
      fullPath: 'fullPath' in m ? String(m.fullPath) : undefined,
      staticData: m.staticData,
      params: m.params as Record<string, string> | undefined,
    })),
    overrides,
  );
}

/**
 * Renders the trail as a `nav` landmark. Ancestors are real links, so middle-click and copy-link work; the current page is plain text carrying `aria-current="page"` — the one element on the page that legitimately holds it.
 *
 * Renders nothing when there is no ancestor to name, which is why callers need no conditional.
 *
 * @param className - Extra classes for the wrapping `nav`.
 * @returns The breadcrumb landmark, or null on a top-level page.
 */
export function Breadcrumb({ className }: { className?: string }): React.JSX.Element | null {
  const crumbs = useCrumbs();
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-x-0.5 text-sm text-muted-fg">
        {crumbs.map((c, i) => (
          <li key={c.to} className="flex min-w-0 items-center">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
            )}
            {c.current ? (
              // Plain text, not a link: an anchor to the page you are on is a
              // no-op that still takes a tab stop and announces as a target.
              <span aria-current="page" className="truncate px-1.5 py-2.5 font-medium text-fg">
                {c.label}
              </span>
            ) : (
              // py-2.5 gives the row a 44px touch target without a visible box.
              <Link
                // Every crumb `to` is a resolved pathname from a live match, so
                // it is a real route; the cast keeps this generic over all of them.
                to={c.to as '/'}
                // exact, and this is the whole point of the component: TanStack's
                // default non-exact matching counts an ancestor as active and
                // stamps `aria-current="page"` on it. That is exactly the defect
                // the old Back link had — announcing itself as the current page
                // while linking away from it — so a crumb that inherited it
                // would have reintroduced the bug it exists to fix.
                activeOptions={{ exact: true }}
                className="truncate rounded px-1.5 py-2.5 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
