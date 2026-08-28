// useOverflowEdges — the paths a component test cannot reach. happy-dom has no layout
// engine, so scroll metrics are stubbed as own properties, and its ResizeObserver is a
// constructor with empty observe/disconnect stubs whose callback never fires. That last
// part is why the resize path needs a fake observer: without one, the entire reason the
// hook takes a SECOND ref is untested, and deleting contentRef would keep every component
// test green.

import { render } from '@testing-library/react';
import { act, useEffect, useRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOverflowEdges, type OverflowEdges } from '@/shared/lib/use-overflow-edges';

type Geometry = { scrollHeight: number; clientHeight: number; scrollTop: number };

/** Impose scroll metrics happy-dom would otherwise report as 0. Own properties shadow the prototype getters. */
const setGeometry = (el: HTMLElement, geometry: Geometry): void => {
  Object.defineProperty(el, 'scrollHeight', { value: geometry.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  el.scrollTop = geometry.scrollTop;
};

// Every element handed to observe(), so a test can assert WHICH elements are watched, plus the single callback so a test can fire it — and, by staying null, prove no observer was ever constructed. Reset per test in beforeEach.
let roCallback: ResizeObserverCallback | null = null;
let roObserved: Element[] = [];
let roDisconnects = 0;
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe(target: Element): void {
    roObserved.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    roDisconnects += 1;
  }
}
const fireResize = (): void => {
  act(() => {
    roCallback?.([], {} as ResizeObserver);
  });
};

/** Which of the hook's two refs the probe actually attaches. `scroller-only` is a caller that forgot the content wrapper; `none` is a scroller that never mounts. */
type ProbeShape = 'both' | 'scroller-only' | 'none';

/**
 * Mount the hook over a scroller wrapping a content div.
 *
 * Every committed edge state is appended to an array from an EFFECT, never assigned during render: the array's last entry is the current answer with its object identity intact, and its length is the number of commits. Both are things a test needs and neither is observable from the DOM.
 *
 * @param shape - Which refs the probe attaches, so the hook's degraded and degenerate arms are reachable.
 * @returns The scroller and content elements (null when that shape omits them), the committed-state log, and `unmount`.
 */
function mountScroller(shape: ProbeShape = 'both'): {
  scroller: HTMLElement | null;
  content: HTMLElement | null;
  committed: OverflowEdges[];
  unmount: () => void;
} {
  const committed: OverflowEdges[] = [];
  function Probe(): ReactElement {
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const edges = useOverflowEdges(scrollRef, contentRef);
    useEffect(() => {
      committed.push(edges);
    });
    if (shape === 'none') return <div data-testid="empty" />;
    return (
      <div ref={scrollRef} data-testid="scroller">
        {shape === 'both' && <div ref={contentRef} data-testid="content" />}
      </div>
    );
  }
  const view = render(<Probe />);
  return {
    scroller: shape === 'none' ? null : view.getByTestId('scroller'),
    content: shape === 'both' ? view.getByTestId('content') : null,
    committed,
    unmount: view.unmount,
  };
}

/**
 * The hook's current answer: the most recent state it committed.
 *
 * @param committed - The commit log from `mountScroller`.
 * @returns The latest edge state, by identity.
 */
const latest = (committed: OverflowEdges[]): OverflowEdges => {
  const last = committed.at(-1);
  if (!last) throw new Error('the probe never committed an edge state');
  return last;
};

describe('useOverflowEdges', () => {
  const realResizeObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    roCallback = null;
    roObserved = [];
    roDisconnects = 0;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    // Order matters and is the opposite of the obvious one. `vi.stubGlobal` records the value it found AT STUB TIME, which inside a test is the fake this beforeEach installed — so unstubbing LAST would put the fake straight back and make the restore below a no-op.
    vi.unstubAllGlobals();
    globalThis.ResizeObserver = realResizeObserver;
  });

  it('re-measures on a resize of the CONTENT with no scroll event at all', () => {
    // The regression this hook exists for. Expanding a profile grows the content
    // inside a scroller whose own box is fixed by its flex parent: no scroll
    // event fires, and the scroller never resizes — so an implementation
    // observing only the scroller reports "nothing hidden below" over a list
    // that has just overflowed.
    const { scroller, content, committed } = mountScroller();
    if (!scroller || !content) throw new Error('probe did not render its scroller');
    expect(roObserved).toContain(scroller);
    expect(roObserved).toContain(content);

    setGeometry(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    // Deliberately NOT dispatching 'scroll': the observer callback is the only
    // thing that may move the answer here.
    fireResize();

    expect(latest(committed)).toEqual({ top: false, bottom: true });
  });

  it('re-measures on scroll and reports both edges from the middle of the range', () => {
    const { scroller, committed } = mountScroller();
    if (!scroller) throw new Error('probe did not render its scroller');

    setGeometry(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 100 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });

    expect(latest(committed)).toEqual({ top: true, bottom: true });
  });

  it('returns the same object and does not re-render while the answer is unchanged', () => {
    // A fresh object per measurement would re-render the caller on every frame
    // of a drag, and a caller that ever put it in a dependency array would loop.
    const { scroller, committed } = mountScroller();
    if (!scroller) throw new Error('probe did not render its scroller');

    setGeometry(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 100 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    const afterFirst = latest(committed);
    const commitsAfterFirst = committed.length;

    // Same geometry, three more measurements.
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    }

    expect(latest(committed)).toBe(afterFirst);
    expect(committed.length).toBe(commitsAfterFirst);
  });

  it('watches the scroller alone, without throwing, when the caller omits the content wrapper', () => {
    // The `if (content)` arm. A caller that forgets the second ref gets the
    // degraded contract — scroll and viewport resize still tracked, content
    // growth silently not — which is exactly the original defect. Pinned so the
    // degradation is a documented shape rather than an accident, and so removing
    // the null check surfaces as a failure rather than a throw in production.
    const { scroller, content, committed } = mountScroller('scroller-only');
    if (!scroller) throw new Error('probe did not render its scroller');
    expect(content).toBeNull();
    expect(roObserved).toEqual([scroller]);

    setGeometry(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    fireResize();
    expect(latest(committed)).toEqual({ top: false, bottom: true });
  });

  it('reports no overflow and does not throw when the scroller never mounts', () => {
    const { scroller, committed } = mountScroller('none');
    expect(scroller).toBeNull();
    // The mount default, not evidence of anything — it passes against any
    // implementation that returns early. What distinguishes "returned before
    // wiring up" from "wired up" is that no observer was ever constructed: the
    // fake records its callback in its own constructor, so a null callback is
    // proof the constructor never ran.
    expect(latest(committed)).toEqual({ top: false, bottom: false });
    expect(roCallback).toBeNull();
    expect(roObserved).toEqual([]);
  });

  it('still tracks scrolling when the environment has no ResizeObserver', () => {
    // An older WebView should lose the resize half of the affordance, not crash
    // the surface that uses it.
    vi.stubGlobal('ResizeObserver', undefined);
    const { scroller, committed } = mountScroller();
    if (!scroller) throw new Error('probe did not render its scroller');

    setGeometry(scroller, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });

    expect(latest(committed)).toEqual({ top: true, bottom: false });
  });

  it('disconnects the observer and removes the scroll listener, by identity, on unmount', () => {
    // The removal is the only observable half. React 19 dropped the
    // setState-on-unmounted warning, so a surviving listener measures a dead
    // component in silence — no warning, no extra commit, nothing a behavioural
    // assertion could catch. Hence the spy, and hence asserting the SAME
    // function reference: removeEventListener with a different one removes
    // nothing at all.
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const { scroller, unmount } = mountScroller();
    if (!scroller) throw new Error('probe did not render its scroller');

    // Filtered by receiver, not just by type: React registers its own delegated
    // `scroll` listener on the root container, so type alone matches two calls.
    const onScroller = addSpy.mock.calls
      .map((call, i) => ({ call, target: addSpy.mock.contexts[i] }))
      .filter(({ call, target }) => call[0] === 'scroll' && target === scroller);
    expect(onScroller).toHaveLength(1);
    const handler = onScroller[0]?.call[1];
    expect(handler).toBeTypeOf('function');

    unmount();

    expect(roDisconnects).toBe(1);
    expect(removeSpy).toHaveBeenCalledWith('scroll', handler);
  });
});
