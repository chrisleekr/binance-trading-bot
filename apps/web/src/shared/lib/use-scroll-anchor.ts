import { useCallback, useEffect, useRef } from 'react';

// A move above half a pixel is a real reflow; anything smaller is sub-pixel
// layout jitter not worth a scroll write (and risks a feedback wobble).
const MIN_DELTA_PX = 0.5;

// Hit-test the top of the scroller's viewport for the element painted there.
// elementFromPoint, not a box-descent over children: content routinely
// overflows a height-clamped flex ancestor (`min-h-0 flex-1`) whose own box
// sits outside the viewport once scrolled, and a descent would skip that
// ancestor and never reach the visible content inside it. Hit-testing follows
// the pixels regardless of overflow or layout mode. Returns null when the probe
// lands on the scroller itself (its own top padding — nothing above to anchor
// to) or outside it (a portalled overlay).
function topVisibleLeaf(scroller: HTMLElement): Element | null {
  const rect = scroller.getBoundingClientRect();
  const el = scroller.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + 2);
  if (!el || el === scroller || !scroller.contains(el)) return null;
  return el;
}

/**
 * Scroll-anchoring shim for WebKit/Safari, which has never shipped
 * `overflow-anchor`. When polled content above the viewport reflows (the app
 * refetches on a timer across every screen), WebKit keeps the raw `scrollTop`
 * and the reader is shoved off their spot — most visibly, someone reading at
 * the bottom is bounced upward on the next tick — while Blink silently holds
 * the visual position. This reproduces Blink's behaviour: capture the top-most
 * visible element's offset from the scroller's top edge, and after each reflow
 * nudge `scrollTop` so that element stays put.
 *
 * Returns one ref callback for the scroll container (the element with
 * `overflow-y: scroll|auto`). Content below the viewport growing or shrinking
 * never moves the anchor, so a reader mid-page is held exactly where they are.
 */
export function useScrollAnchor<T extends HTMLElement = HTMLElement>(): (node: T | null) => void {
  const scrollerRef = useRef<T | null>(null);
  const anchorRef = useRef<Element | null>(null);
  // Anchor's distance from the scroller's top edge, captured pre-reflow.
  const anchorTopRef = useRef(0);
  const mutationObs = useRef<MutationObserver | null>(null);
  const captureRaf = useRef(0);
  const restoreRaf = useRef(0);

  const capture = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const anchor = topVisibleLeaf(scroller);
    anchorRef.current = anchor;
    if (anchor) {
      anchorTopRef.current =
        anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }
  }, []);

  const restore = useCallback(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor || !anchor.isConnected || !scroller.contains(anchor)) {
      capture();
      return;
    }
    const newTop = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const delta = newTop - anchorTopRef.current;
    if (Math.abs(delta) > MIN_DELTA_PX) scroller.scrollTop += delta;
    // Re-anchor from the settled layout so the next reflow measures against it.
    capture();
  }, [capture]);

  // Both observers fire mid-frame; defer to a rAF so a multi-node React commit
  // coalesces into one pass and we read the settled layout before paint.
  const scheduleCapture = useCallback(() => {
    if (captureRaf.current) return;
    captureRaf.current = requestAnimationFrame(() => {
      captureRaf.current = 0;
      capture();
    });
  }, [capture]);

  const scheduleRestore = useCallback(() => {
    if (restoreRaf.current) return;
    restoreRaf.current = requestAnimationFrame(() => {
      restoreRaf.current = 0;
      restore();
    });
  }, [restore]);

  useEffect(
    () => () => {
      mutationObs.current?.disconnect();
      if (captureRaf.current) cancelAnimationFrame(captureRaf.current);
      if (restoreRaf.current) cancelAnimationFrame(restoreRaf.current);
      scrollerRef.current?.removeEventListener('scroll', scheduleCapture);
    },
    [scheduleCapture],
  );

  return useCallback(
    (node: T | null) => {
      mutationObs.current?.disconnect();
      mutationObs.current = null;
      scrollerRef.current?.removeEventListener('scroll', scheduleCapture);

      scrollerRef.current = node;
      if (!node) return;

      // Keep the anchor fresh as the reader scrolls, so the next reflow measures
      // against where they actually are. Passive: never blocks the scroll.
      node.addEventListener('scroll', scheduleCapture, { passive: true });

      // Trigger: a poll re-renders a panel = a DOM mutation in the scroller's
      // subtree, and that reflow is what we must absorb. A ResizeObserver on a
      // child misses it when the scroller is a flex column whose child is
      // height-clamped (min-h-0 flex-1) and the growth happens in an
      // overflowing descendant — so key off subtree mutations, which fire
      // regardless of the scroller's layout mode.
      if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(scheduleRestore);
        observer.observe(node, { childList: true, subtree: true, characterData: true });
        mutationObs.current = observer;
      }
      capture();
    },
    [capture, scheduleCapture, scheduleRestore],
  );
}
