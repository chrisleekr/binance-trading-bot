import { useLayoutEffect, useState, type RefObject } from 'react';

/** Which edges of a scroller have content hidden past them. */
export interface OverflowEdges {
  /** Content is hidden ABOVE the visible box, i.e. the scroller has been scrolled down. */
  readonly top: boolean;
  /** Content is hidden BELOW the visible box, i.e. there is more to scroll to. */
  readonly bottom: boolean;
}

const NO_OVERFLOW: OverflowEdges = { top: false, bottom: false };

/**
 * Track whether a scroll container has content hidden past its top or bottom edge, so a caller can render a fade, a chevron, or any other "there is more here" affordance.
 *
 * A scrollbar is the browser's own answer to this question, but overlay scrollbars stay invisible until the user is already scrolling — exactly the moment the affordance is no longer needed. That is unconditional on iOS, and on macOS it is what the default "Automatically based on mouse or trackpad" setting does whenever no mouse is attached. A clipped list with no visible scrollbar reads as a list that simply ends.
 *
 * Three things move the answer, and all three have to be watched or the affordance goes stale rather than wrong-and-obvious: the user scrolling, the viewport resizing, and the CONTENT growing or shrinking underneath a fixed-height scroller. The third is why this takes a second ref: content growth fires no `scroll` event, and it does not change the scroller's own border box either when that box is sized by its flex parent, so a `ResizeObserver` watching only the scroller never fires. Observing the inner content element is what catches it.
 *
 * The 1px slack on both predicates absorbs sub-pixel rounding: fractional layout heights routinely leave `scrollTop + clientHeight` a hair short of `scrollHeight` at the very end of a scroll, which would otherwise pin the bottom affordance on forever.
 *
 * @param scrollRef - Ref to the element that actually scrolls, the one carrying `overflow-y-auto`. A null current is survived rather than supported: the hook reports no overflow and wires nothing up, and because the effect keys on the ref OBJECT it never re-runs, so a scroller mounted later would stay unobserved. Pass a ref to an unconditionally rendered element.
 * @param contentRef - Ref to a single stable element wrapping everything inside the scroller. It must not be conditionally rendered, or its size changes stop being observed at the moment the list grows.
 * @returns The current edge state. The SAME object identity is returned while the answer is unchanged, so scrolling does not re-render the caller on every frame of a drag.
 */
export function useOverflowEdges(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): OverflowEdges {
  const [edges, setEdges] = useState<OverflowEdges>(NO_OVERFLOW);

  // Layout, not passive: the first measurement has to land before paint, or an already-overflowing list flashes one frame with no affordance.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const measure = (): void => {
      const top = scroller.scrollTop > 1;
      const bottom = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };

    measure();
    // Passive: this listener only reads geometry, so telling the browser up front that it will never call preventDefault keeps scrolling off the main thread.
    scroller.addEventListener('scroll', measure, { passive: true });

    // Guarded rather than assumed: an older WebView or a test environment without the constructor should lose the resize half of the affordance, not crash the sidebar.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    const content = contentRef.current;
    if (content) observer?.observe(content);

    return () => {
      scroller.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
    // Refs are stable across renders, so this wires up once per mount.
  }, [scrollRef, contentRef]);

  return edges;
}
