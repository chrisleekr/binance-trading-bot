import { useCallback, useEffect, useRef } from 'react';

// A move above half a pixel is a real reflow; anything smaller is sub-pixel
// layout jitter not worth a scroll write (and risks a feedback wobble).
const MIN_DELTA_PX = 0.5;

// How long after the last reader-driven scroll event the position is still
// treated as theirs. WebKit runs scrolling on the compositor, so writing
// `scrollTop` while a drag or its momentum is live does not nudge the reader —
// it cancels the fling and snaps them back to the last offset the main thread
// observed. Corrections wait for the scroll to go quiet instead.
const SETTLE_MS = 120;

// A correction of our own makes the browser emit a scroll event. Events this
// close behind a write are ours, not the reader's; counting them would let the
// shim suspend itself and bake the drift it was about to remove into the next
// anchor.
const SELF_WRITE_WINDOW_MS = 50;

// How long after the reader's last drag, wheel notch or scrolling key a scroll
// event is still credited to them. This is a floor, not the whole story: iOS
// momentum can outlast it, and the unbroken-run term in `onScroll` is what
// carries the credit for as long as the fling actually lasts.
const GESTURE_MS = 1_500;

// A finger that has produced no touch event for this long is a `touchend` we
// never received, not a live gesture: the browser fires it at the node the
// touch started on, and this app's polling can remove that node mid-gesture, so
// the event has no path back to the scroller. Unbounded, one lost event would
// hold corrections off for the lifetime of the page — a dead shim looks exactly
// like a still one, so it must degrade rather than wedge.
const TOUCH_STALE_MS = 10_000;

// Keys the browser scrolls with. A typed character is not one of them, and
// crediting it would let the next clamp bake its drift in for GESTURE_MS — the
// same mistake as treating a tap as a drag.
const SCROLL_KEYS = new Set([
  ' ',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** In a field these move the caret; the page does not scroll. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

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
 * Scroll-anchoring shim for WebKit/Safari. `overflow-anchor` has reached
 * Technology Preview and the Safari 27 beta, but no stable Safari release ships
 * it and no iOS Safari release supports it (caniuse.com/css-overflow-anchor,
 * checked 2026-08); once it lands on iOS this hook can be deleted in favour of
 * the native property. When polled content above the viewport reflows (the app
 * refetches on a timer across every screen), WebKit keeps the raw `scrollTop`
 * and the reader is shoved off their spot — most visibly, someone reading at
 * the bottom is bounced upward on the next tick — while Blink silently holds
 * the visual position. This reproduces Blink's behaviour: capture the top-most
 * visible element's offset from the scroller's top edge, and after each reflow
 * nudge `scrollTop` so that element stays put.
 *
 * Corrections only ever run while the reader's own scrolling is idle. A write
 * landing mid-drag or mid-momentum is worse than the drift it removes: on
 * WebKit the compositor owns the position then, so the write kills the fling
 * and teleports the reader. The cost is that a reflow arriving mid-flick goes
 * uncorrected — the reader is already moving, so it is not a position they were
 * holding. "Idle" is measured against gestures, not scroll events: a clamp
 * emits a scroll event of its own, and standing down for that would disable the
 * shim exactly when it is needed.
 *
 * Known gap: a scrollbar-thumb drag emits no touch, wheel or key event, so it
 * is not recognised as the reader and a reflow during one is still corrected.
 * That is desktop-only, where scrolling is not compositor-driven and a write
 * nudges rather than cancels, so it costs a small jump rather than a killed
 * fling. Accepted over listening for `pointerdown`, which fires on every tap
 * and would re-open the far worse case of taps suppressing corrections.
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
  // Reader-owned-scroll tracking. `lastScrollAt` starts at 0 (the epoch) so a
  // scroller that has never been touched is idle from the first frame.
  const touchCount = useRef(0);
  const lastTouchAt = useRef(0);
  const lastScrollAt = useRef(0);
  const lastInputAt = useRef(0);
  const selfWriteAt = useRef(0);

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

  /** A finger genuinely still on the glass, not a `touchend` that went missing. */
  const fingerDown = useCallback(
    () => touchCount.current > 0 && Date.now() - lastTouchAt.current < TOUCH_STALE_MS,
    [],
  );

  /** True while a finger is down or the scroll it threw is still settling. */
  const readerOwnsScroll = useCallback(
    () => fingerDown() || Date.now() - lastScrollAt.current < SETTLE_MS,
    [fingerDown],
  );

  const restore = useCallback(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor || !anchor.isConnected || !scroller.contains(anchor)) {
      capture();
      return;
    }
    // Re-anchor to wherever the reader currently is and leave the position
    // alone; correcting now would fight the gesture rather than absorb a reflow.
    if (readerOwnsScroll()) {
      capture();
      return;
    }
    const newTop = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const delta = newTop - anchorTopRef.current;
    if (Math.abs(delta) > MIN_DELTA_PX) {
      selfWriteAt.current = Date.now();
      scroller.scrollTop += delta;
    }
    // Re-anchor from the settled layout so the next reflow measures against it.
    capture();
  }, [capture, readerOwnsScroll]);

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

  const onScroll = useCallback(() => {
    const now = Date.now();
    const isSelfWrite = now - selfWriteAt.current <= SELF_WRITE_WINDOW_MS;
    // A scroll event is not proof the reader scrolled. When content above the
    // viewport shrinks the browser clamps `scrollTop` and emits one too — and
    // that clamp is the exact reflow this shim exists to undo, dispatched (as
    // the scroll step of the update-the-rendering cycle) before the rAF that
    // runs `restore`. Crediting it to the reader would make the shim stand down
    // for its own primary case and re-anchor at the drifted position, turning a
    // one-frame clamp into permanent drift. Only a scroll with a gesture behind
    // it is theirs.
    // Three things count as the reader: a finger on the glass, a recent
    // drag/wheel/key, or an unbroken run of scroll events already credited to
    // them. The last term is what carries iOS momentum, which emits no input
    // events at all and can outlast any fixed window — and a lone clamp cannot
    // start such a run, because its own first event is never credited.
    const gestureDriven =
      fingerDown() ||
      now - lastInputAt.current < GESTURE_MS ||
      now - lastScrollAt.current < SETTLE_MS;
    if (!isSelfWrite && gestureDriven) lastScrollAt.current = now;
    // Keep the anchor fresh as the reader scrolls, so the next reflow measures
    // against where they actually are.
    scheduleCapture();
  }, [fingerDown, scheduleCapture]);

  /**
   * Proof the reader is moving the content: a drag or a wheel notch. A tap is
   * deliberately none of these — it emits no `touchmove`, and counting one
   * would suppress corrections after every button press.
   */
  const onInput = useCallback(() => {
    lastInputAt.current = Date.now();
  }, []);

  /**
   * Keyboard scrolling. Keys land on the focused element rather than the
   * scroller, so this is bound at the document — which means it sees ordinary
   * typing too, and must ignore it: a character in a filter field scrolls
   * nothing, and crediting it would disarm corrections for GESTURE_MS.
   */
  const onKey = useCallback((event: Event) => {
    const key = event as KeyboardEvent;
    if (!SCROLL_KEYS.has(key.key) || isTextEntry(key.target)) return;
    lastInputAt.current = Date.now();
  }, []);

  // `touches` excludes the point that just ended, so on any touch event it is
  // the number of fingers still down. Reading the count off the event rather
  // than latching a boolean keeps lifting one finger of a pinch from ending the
  // gesture. This handler marks presence only, never activity: see `onInput`.
  const onTouch = useCallback((event: Event) => {
    touchCount.current = (event as TouchEvent).touches.length;
    lastTouchAt.current = Date.now();
  }, []);

  const detach = useCallback(
    (node: T) => {
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('wheel', onInput);
      node.removeEventListener('touchmove', onInput);
      node.removeEventListener('touchstart', onTouch);
      node.removeEventListener('touchend', onTouch);
      node.removeEventListener('touchcancel', onTouch);
      // Keys land on the focused element, which is rarely inside the scroller,
      // so this one is bound at the document.
      node.ownerDocument.removeEventListener('keydown', onKey);
      delete node.dataset['scrollAnchor'];
      // A scroller swapped out mid-gesture must not leave the next one holding
      // a finger that was never lifted.
      touchCount.current = 0;
      lastTouchAt.current = 0;
      lastScrollAt.current = 0;
      lastInputAt.current = 0;
      selfWriteAt.current = 0;
    },
    [onScroll, onInput, onKey, onTouch],
  );

  useEffect(
    () => () => {
      mutationObs.current?.disconnect();
      if (captureRaf.current) cancelAnimationFrame(captureRaf.current);
      if (restoreRaf.current) cancelAnimationFrame(restoreRaf.current);
      if (scrollerRef.current) detach(scrollerRef.current);
    },
    [detach],
  );

  return useCallback(
    (node: T | null) => {
      mutationObs.current?.disconnect();
      mutationObs.current = null;
      if (scrollerRef.current) detach(scrollerRef.current);

      scrollerRef.current = node;
      if (!node) return;

      // Names the scroller this hook owns. A page can hold several scrollable
      // boxes (panels with their own max-height), and only this one is anchored,
      // so the layout-stability e2e gate needs to find it rather than guess.
      node.dataset['scrollAnchor'] = '';

      // Passive: never blocks the scroll.
      node.addEventListener('scroll', onScroll, { passive: true });
      node.addEventListener('wheel', onInput, { passive: true });
      node.addEventListener('touchmove', onInput, { passive: true });
      node.addEventListener('touchstart', onTouch, { passive: true });
      node.addEventListener('touchend', onTouch, { passive: true });
      node.addEventListener('touchcancel', onTouch, { passive: true });
      node.ownerDocument.addEventListener('keydown', onKey, { passive: true });

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
    [capture, detach, onScroll, onInput, onKey, onTouch, scheduleRestore],
  );
}
