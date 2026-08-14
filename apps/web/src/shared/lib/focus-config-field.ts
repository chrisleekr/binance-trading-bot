// Land a deep link on one config field: expand whatever is hiding it, scroll to
// it, and mark it.
//
// A diagnosis finding names the setting that armed it. Sending the operator to
// the right tab is not enough — the field is usually inside a collapsed group,
// so they arrive at a page that looks like it does not contain the thing they
// were promised.
//
// Both collapsers in this app are native uncontrolled `<details>` (the Panel
// and the AutoForm group), so walking `closest('details')` up the chain and
// setting `.open` expands every level with no state plumbing. Fields render
// even inside a closed group, so `getElementById` resolves before expansion.
//
// The main scroller already runs `useScrollAnchor`, so expanding a `<details>`
// above the target cannot jump the viewport out from under the scroll.

import { useEffect } from 'react';

/** How long the landing marker stays. Long enough to find, short enough to leave. */
const PULSE_MS = 2_000;

const PULSE_CLASS = 'field-focus-pulse';

/**
 * Expand, scroll to, and mark the field with this id. Returns false when no
 * such field is on the page, so a stale link degrades to doing nothing rather
 * than to a silent partial scroll.
 */
export const focusConfigField = (path: string): boolean => {
  const el = document.getElementById(path);
  if (!el) return false;

  for (
    let node: HTMLElement | null = el.closest('details');
    node;
    node = node.parentElement?.closest('details') ?? null
  ) {
    (node as HTMLDetailsElement).open = true;
  }

  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add(PULSE_CLASS);
  window.setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS);
  return true;
};

/**
 * Run `focusConfigField` once the page has painted the field.
 *
 * One retry frame, not a poll: the form renders from data already in the query
 * cache on a deep-link arrival, but the very first commit can land before the
 * field mounts. Anything longer would be waiting for a page that is not coming.
 */
export const useFocusConfigField = (path: string | undefined): void => {
  useEffect(() => {
    if (!path) return;
    if (focusConfigField(path)) return;
    const raf = window.requestAnimationFrame(() => focusConfigField(path));
    return () => window.cancelAnimationFrame(raf);
  }, [path]);
};

/** Read the `?focus=` deep-link target. Non-string values are simply absent. */
export const focusParam = (search: unknown): { focus?: string } => {
  const raw = (search as Record<string, unknown> | null | undefined)?.['focus'];
  return typeof raw === 'string' && raw.length > 0 ? { focus: raw } : {};
};
