import { PageSkeleton } from '@/shared/components/page-skeleton';

/**
 * Global route pending screen, shown once a navigation's loaders pass the
 * router's pendingMs threshold.
 *
 * In flow, not a `fixed inset-0` overlay. The overlay was there to stop the
 * outgoing route showing through — after sign-in the form stayed on screen for
 * the whole account+dashboard fetch — but nothing needs covering: the router
 * renders each match inside a Suspense boundary it reuses across the outgoing
 * and incoming route, and React hides the already-committed nodes with
 * `display: none !important` (`hideInstance` in react-dom) while that boundary
 * shows this fallback. Covering the viewport only cost the operator the top
 * bar, ticker, health bar and nav for the length of a slow load; in flow they
 * stay visible and tappable.
 *
 * It owns a scroller, and the skeleton inside is taller than a phone viewport.
 * This app has no document scroll to fall back on, so a loading screen with no
 * scroll range leaves a touch landing on something that cannot move, and the
 * app reads as frozen rather than busy. `flex-1 min-h-0` matters on the
 * full-screen routes, where the shell makes `<main>` a non-scrolling flex
 * column and each route supplies its own scroller; on the normal routes
 * `<main>` already scrolls and this box simply grows to its content.
 */
export function RoutePending() {
  return (
    // The skeleton owns the live region; a second one here would announce the
    // same load twice.
    <div
      className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain"
      // Styling hook, separate from the test id: app.css insets this box where
      // its parent supplies no padding, and a test id is meant to be safe to
      // rename.
      data-route-pending=""
      data-testid="route-pending"
    >
      <PageSkeleton />
    </div>
  );
}
