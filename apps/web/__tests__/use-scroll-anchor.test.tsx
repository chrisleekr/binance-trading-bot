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

// Real touch events carry a `touches` list of the points still on the glass,
// and the hook reads its length rather than latching a boolean. happy-dom's
// Event has no such field, so supply it — a synthetic event without one would
// let these tests pass against a hook that ignored multi-touch entirely.
function useClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  // The hook treats a 0 timestamp as the epoch, i.e. long idle. Start the clock
  // well past it so a never-touched scroller is idle from the first frame,
  // rather than depending on vitest defaulting the fake clock to wall time.
  vi.setSystemTime(1_700_000_000_000);
}

function touchEvent(type: 'touchstart' | 'touchend' | 'touchcancel', fingers: number): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'touches', { value: { length: fingers } });
  return event;
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

// One hook instance, two different scroller nodes — the ref callback is handed
// null and then the replacement, which is what a route swapping its scroll
// container does. Distinct keys so React really replaces the element.
function SwapHarness({ swapped }: { swapped: boolean }): React.JSX.Element {
  const ref = useScrollAnchor<HTMLDivElement>();
  const suffix = swapped ? 'b' : 'a';
  return (
    <div key={suffix} ref={ref} data-testid={`scroller-${suffix}`}>
      <section>
        <div data-testid={`b-${suffix}`}>B</div>
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
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow(); // baseline anchor = B at 5px

      // Reader scrolls: B is now 2px below the top edge. The scroll listener must
      // re-capture that new offset.
      stubRect(b, { top: 2, bottom: 102, width: 100, height: 100 });
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      // Let the scroll settle: corrections stay off while the position is still
      // the reader's, so the reflow below has to land on a quiet scroller.
      vi.advanceTimersByTime(500);

      // A reflow above pushes B down to 42px.
      stubRect(b, { top: 42, bottom: 142, width: 100, height: 100 });
      reflow();

      // Correction is measured against the post-scroll baseline (2), not the
      // original (5): delta = 42 - 2 = 40.
      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // A scrollTop write only nudges the reader when the compositor is not already
  // driving the position. Mid-drag on WebKit it cancels the fling instead, which
  // is what a reader on iOS feels as the page yanking itself around.
  //
  // The wait past SETTLE_MS is what makes this test about the finger rather than
  // the settle window: a resting finger emits no scroll events, so after 120ms
  // only the touch count can still hold corrections off. Without it the test
  // passes against a hook with no finger tracking at all.
  it('does not correct while a finger rests, however long it stays down', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow(); // baseline anchor = B at 5px

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      vi.advanceTimersByTime(500);

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // touchend fires once per point lifted, not once per gesture, and reports the
  // points still down. Treating the first one as the end of the gesture would
  // let a correction land mid-pinch.
  it('keeps holding when one finger of a two-finger gesture lifts', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 2));
      scroller.dispatchEvent(touchEvent('touchend', 1));
      vi.advanceTimersByTime(500);

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not correct during the momentum that outlives the touch', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(new Event('touchmove'));
      scroller.dispatchEvent(touchEvent('touchend', 0));
      // The fling is still emitting scroll events; each one re-arms the window.
      for (let i = 0; i < 5; i += 1) {
        vi.advanceTimersByTime(50);
        scroller.dispatchEvent(new Event('scroll'));
        flushRaf();
      }
      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes correcting once the scroll goes quiet', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(touchEvent('touchend', 0));
      vi.advanceTimersByTime(500);

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // The browser takes the gesture away on an orientation change, an app switch
  // or palm rejection, and touchend never arrives. Without touchcancel wired to
  // the same handler the count latches and the shim goes dead for the lifetime
  // of the page — silently, since a dead shim looks exactly like a still one.
  it('releases the hold when the browser cancels the gesture', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(touchEvent('touchcancel', 0));
      vi.advanceTimersByTime(500);

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // The defect this shim exists for IS a browser-initiated scroll: shrinking
  // content makes the browser clamp scrollTop, and that clamp emits a scroll
  // event of its own, dispatched before the rAF that runs the correction
  // (verified in WebKit). Reading it as the reader taking over would make the
  // shim stand down for its primary case and re-anchor at the drifted position,
  // turning a one-frame clamp into permanent drift.
  it('still corrects when the scroll event came from the browser, not the reader', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      // No touch, no wheel: nothing the reader did produced this.
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // The mirror of the case above: with a gesture behind it, the same scroll
  // event must suspend corrections. Pins the gate to "was this the reader?"
  // rather than "ignore scroll events".
  it('stands down for a wheel scroll, which is the reader driving', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(new Event('wheel'));
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Without this the shim reads the scroll event its own correction emits as the
  // reader taking over, suspends itself, and re-anchors at the drifted position —
  // turning one absorbed reflow into permanent drift on the next one.
  it('does not treat its own correction as reader activity', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      // A gesture that has just ended is the only window where this guard can
      // matter: past SETTLE_MS so corrections are back on, still within
      // GESTURE_MS so scroll events are credited to the reader.
      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(new Event('touchmove'));
      scroller.dispatchEvent(touchEvent('touchend', 0));
      vi.advanceTimersByTime(200);

      // First reflow: B drops 20px, the shim corrects.
      stubRect(b, { top: 25, bottom: 125, width: 100, height: 100 });
      reflow();
      expect(scroller.scrollTop).toBe(20);
      // The write's own scroll event lands on the next frame.
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      // A second reflow immediately after must still be corrected.
      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();
      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // A tap is not a scroll. Marking reader activity on touchstart suppressed
  // corrections for the settle window after every button press, and credited
  // the browser's clamp to the reader for a second and a half after it — so a
  // poll landing just after any tap went uncorrected.
  it('does not stand down for a tap that never became a drag', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      // Down and up with no touchmove between: a tap, not a drag.
      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(touchEvent('touchend', 0));

      // The tap changed layout, so the browser clamps and emits a scroll event
      // of its own. Crediting that to the reader — which is what marking the
      // tap as activity would do — leaves the clamp uncorrected for good.
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // A hard flick on iOS can outlast GESTURE_MS, and momentum emits no input
  // events at all — only scroll events. The unbroken-run term is what keeps the
  // credit alive for as long as the fling actually lasts; without it the shim
  // starts writing scrollTop into a live fling and cancels it.
  it('keeps holding through momentum that outlasts the gesture window', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      scroller.dispatchEvent(new Event('touchmove'));
      scroller.dispatchEvent(touchEvent('touchend', 0));

      // 2s of fling — well past GESTURE_MS — with nothing but scroll events.
      for (let i = 0; i < 40; i += 1) {
        vi.advanceTimersByTime(50);
        scroller.dispatchEvent(new Event('scroll'));
        flushRaf();
      }
      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Keys land on the focused element, so the listener sits on the document and
  // sees ordinary typing. A character in a filter field scrolls nothing —
  // crediting it would disarm corrections for GESTURE_MS on exactly the routes
  // that have both text inputs and polling panels.
  // Each of the two guards is isolated: an arrow key IS a scroll key but moves
  // the caret inside a field, and a character is not a scroll key wherever it
  // lands. A test that fails only when both are removed would let either one be
  // deleted silently.
  it.each([
    { label: 'an arrow key inside a text field', key: 'ArrowDown', inField: true },
    { label: 'a character typed outside any field', key: 'a', inField: false },
  ])('does not stand down for $label', ({ key, inField }) => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      const field = document.createElement('input');
      document.body.appendChild(field);
      const typed = new Event('keydown', { bubbles: true });
      Object.defineProperty(typed, 'key', { value: key });
      (inField ? field : document.body).dispatchEvent(typed);

      // The browser clamps and emits its own scroll event.
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
      field.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down for a PageDown that actually scrolls the page', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      const pressed = new Event('keydown', { bubbles: true });
      Object.defineProperty(pressed, 'key', { value: 'PageDown' });
      document.body.dispatchEvent(pressed);

      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Pins the far edge of GESTURE_MS. Without it any positive value passes, and a
  // single wheel notch could credit every later scroll event for the session.
  it('stops crediting scrolls to the reader once the gesture has aged out', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(new Event('wheel'));
      vi.advanceTimersByTime(2_000);
      scroller.dispatchEvent(new Event('scroll'));
      flushRaf();

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // The browser fires touchend at the node the touch started on, and a poll can
  // remove that node mid-gesture, so the event never reaches the scroller.
  // Unbounded, that one lost event would hold corrections off forever.
  it('gives up on a finger that has been down implausibly long', () => {
    useClock();
    try {
      const { scroller, b } = mount();
      trackScrollTop(scroller);
      seed(scroller, b);
      reflow();

      scroller.dispatchEvent(touchEvent('touchstart', 1));
      vi.advanceTimersByTime(11_000); // past TOUCH_STALE_MS; no touchend ever came

      stubRect(b, { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(scroller.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
  });

  // The layout-stability e2e probe selects the scroller by this marker. Nothing
  // in CI runs that spec, so without this test the marker could be dropped and
  // the probe would silently measure the wrong element.
  it('marks its scroller so the layout-stability probe can find it', () => {
    const { scroller, unmount } = mount();
    expect(scroller.dataset['scrollAnchor']).toBe('');
    unmount();
    expect(scroller.dataset['scrollAnchor']).toBeUndefined();
  });

  // The refs live on the hook instance, not the node, so a route that swaps its
  // scroller element (a loading branch giving way to a loaded one) keeps them.
  // A finger down on the old node would otherwise hold the new one's
  // corrections off. Remounting the whole component would NOT show this — that
  // gets fresh refs and passes either way.
  it('does not carry a held finger across a scroller swap', () => {
    useClock();
    try {
      const view = render(<SwapHarness swapped={false} />);
      const first = view.getByTestId('scroller-a');
      trackScrollTop(first);
      seed(first, view.getByTestId('b-a'));
      reflow();

      // Finger down on the old scroller, never lifted.
      first.dispatchEvent(touchEvent('touchstart', 1));

      view.rerender(<SwapHarness swapped />);
      const second = view.getByTestId('scroller-b');
      trackScrollTop(second);
      seed(second, view.getByTestId('b-b'));
      reflow();

      stubRect(view.getByTestId('b-b'), { top: 45, bottom: 145, width: 100, height: 100 });
      reflow();

      expect(second.scrollTop).toBe(40);
    } finally {
      vi.useRealTimers();
    }
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
