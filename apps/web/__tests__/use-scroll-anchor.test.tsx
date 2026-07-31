import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useScrollAnchor } from '@/shared/lib/use-scroll-anchor';

// happy-dom has no layout engine, so getBoundingClientRect is (0,0,0,0) and
// elementFromPoint returns null. Stub the anchor element and its rect, drive the
// trigger with a fake MutationObserver, and run the hook's rAF-throttled work
// through a manual queue — all deterministic.

type Rect = { top: number; bottom: number; width: number; height: number };

function stubRect(el: Element, r: Rect): void {
  el.getBoundingClientRect = () =>
    ({
      top: r.top,
      bottom: r.bottom,
      left: 0,
      right: 100,
      width: r.width,
      height: r.height,
      x: 0,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function trackScrollTop(el: HTMLElement): void {
  let value = 0;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next;
    },
  });
}

// The element the hook's hit-test resolves to. Tests point it at the anchor.
let anchorHit: Element | null = null;

let moCallback: MutationCallback | null = null;
let moDisconnects = 0;
class FakeMutationObserver {
  constructor(cb: MutationCallback) {
    moCallback = cb;
  }
  observe(): void {}
  disconnect(): void {
    moDisconnects += 1;
  }
  takeRecords(): MutationRecord[] {
    return [];
  }
}
function fireMutation(): void {
  moCallback?.([], {} as MutationObserver);
}

// Manual rAF queue so the hook's scheduleCapture/scheduleRestore run on demand.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): void {
  const queued = rafQueue;
  rafQueue = [];
  for (const cb of queued) cb(0);
}

// A subtree reflow: the observer fires, then its rAF-deferred restore runs.
function reflow(): void {
  fireMutation();
  flushRaf();
}

function Harness(): React.JSX.Element {
  const ref = useScrollAnchor<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="scroller">
      <section data-testid="content">
        <div data-testid="b">B</div>
      </section>
    </div>
  );
}

function mount(): { scroller: HTMLElement; b: HTMLElement; unmount: () => void } {
  const view = render(<Harness />);
  return {
    scroller: view.getByTestId('scroller'),
    b: view.getByTestId('b'),
    unmount: view.unmount,
  };
}

// Scroller fills the viewport; B is the top-most visible element (the anchor),
// sitting 5px below the scroller's top edge.
function seed(scroller: HTMLElement, b: HTMLElement): void {
  stubRect(scroller, { top: 0, bottom: 200, width: 100, height: 200 });
  stubRect(b, { top: 5, bottom: 105, width: 100, height: 100 });
  anchorHit = b;
}

describe('useScrollAnchor', () => {
  const realMutationObserver = globalThis.MutationObserver;
  let realElementFromPoint: typeof document.elementFromPoint;
  beforeEach(() => {
    moCallback = null;
    moDisconnects = 0;
    rafQueue = [];
    anchorHit = null;
    globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
    realElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = (() => anchorHit) as typeof document.elementFromPoint;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => {
    globalThis.MutationObserver = realMutationObserver;
    document.elementFromPoint = realElementFromPoint;
    vi.unstubAllGlobals();
  });

  it('holds the anchor in place when content above it grows', () => {
    const { scroller, b } = mount();
    trackScrollTop(scroller);
    seed(scroller, b);

    // First reflow captures the baseline anchor (B, 5px below the top edge).
    reflow();
    expect(scroller.scrollTop).toBe(0);

    // Content above the fold grows 30px, shoving B down to 35px.
    stubRect(b, { top: 35, bottom: 135, width: 100, height: 100 });
    reflow();

    // WebKit would leave scrollTop at 0 and let B drift to 35; the shim nudges
    // scrollTop +30 so B stays pinned at 5px — no visible jump.
    expect(scroller.scrollTop).toBe(30);
  });

  it('corrects upward when content above the viewport shrinks', () => {
    const { scroller, b } = mount();
    trackScrollTop(scroller);
    scroller.scrollTop = 100;
    seed(scroller, b);
    reflow();

    // Content above collapses 20px, pulling B up to -15px.
    stubRect(b, { top: -15, bottom: 85, width: 100, height: 100 });
    reflow();

    // B moved -20; scrollTop follows -20 (100 -> 80) so B stays at 5px.
    expect(scroller.scrollTop).toBe(80);
  });

  it('leaves scroll untouched when the anchor does not move', () => {
    const { scroller, b } = mount();
    trackScrollTop(scroller);
    seed(scroller, b);
    reflow();

    // Content changed below the fold — B (the anchor) stayed put. A reader
    // mid-page must not be scrolled.
    reflow();

    expect(scroller.scrollTop).toBe(0);
  });

  it('re-anchors against the reader position after a scroll before correcting', () => {
    const { scroller, b } = mount();
    trackScrollTop(scroller);
    seed(scroller, b);
    reflow(); // baseline anchor = B at 5px

    // Reader scrolls: B is now 2px below the top edge. The scroll listener must
    // re-capture that new offset.
    stubRect(b, { top: 2, bottom: 102, width: 100, height: 100 });
    scroller.dispatchEvent(new Event('scroll'));
    flushRaf();

    // A reflow above pushes B down to 42px.
    stubRect(b, { top: 42, bottom: 142, width: 100, height: 100 });
    reflow();

    // Correction is measured against the post-scroll baseline (2), not the
    // original (5): delta = 42 - 2 = 40.
    expect(scroller.scrollTop).toBe(40);
  });

  it('does not write scroll when the captured anchor is removed', () => {
    const { scroller, b } = mount();
    trackScrollTop(scroller);
    seed(scroller, b);
    reflow(); // anchor = B

    // The anchored element is unmounted on a poll (e.g. a row disappears) and
    // the hit-test now finds nothing.
    b.remove();
    anchorHit = null;
    reflow();

    // restore falls back to re-capture instead of nudging against a stale rect.
    expect(scroller.scrollTop).toBe(0);
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = mount();
    expect(moDisconnects).toBe(0);
    unmount();
    expect(moDisconnects).toBeGreaterThan(0);
  });

  it('does not throw when MutationObserver is unavailable', () => {
    globalThis.MutationObserver = undefined as unknown as typeof MutationObserver;
    expect(() => render(<Harness />)).not.toThrow();
  });
});
