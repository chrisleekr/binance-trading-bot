// useCursorPager — forward/back paging over an opaque keyset cursor.
//
// A cursor names a boundary row, not an offset, so there is no arithmetic that reaches the previous page: going back means having remembered where you came from. That stack is the whole substance of the hook, and it is what a test has to hold — a `back` that does not pop it lets the operator step backwards off page 2 forever, each step re-fetching page 1 under a rising page number.

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useCursorPager } from '@/shared/hooks/use-cursor-pager';

describe('useCursorPager', () => {
  it('walks forward and back over the cursors it was handed, and stops at page 1', () => {
    const { result } = renderHook(() => useCursorPager());

    // The first page carries no cursor and has nothing to retrace to.
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoBack).toBe(false);

    act(() => result.current.next('c1'));
    expect(result.current.cursor).toBe('c1');
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.next('c2'));
    expect(result.current.cursor).toBe('c2');
    expect(result.current.pageNumber).toBe(3);

    // Back to the cursor page 2 was fetched under — not to page 3's own token, which would re-fetch the page just left.
    act(() => result.current.back());
    expect(result.current.cursor).toBe('c1');
    expect(result.current.pageNumber).toBe(2);
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.back());
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoBack).toBe(false);

    // A third `back` from page 1 is a no-op. Without the pop, `back` keeps returning the same remembered cursor while the page number falls past 1 — or, with the stack left alone, walks off it entirely.
    act(() => result.current.back());
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoBack).toBe(false);
  });

  it('returns to the first page from deep in the walk, discarding the whole history', () => {
    // Every filter, sort and window change calls this: a cursor is a position in one particular sequence, and replaying it against a different one pages through rows the operator never saw. Resetting the cursor while leaving the stack would leave `canGoBack` true on page 1.
    const { result } = renderHook(() => useCursorPager());
    act(() => result.current.next('c1'));
    act(() => result.current.next('c2'));
    expect(result.current.pageNumber).toBe(3);

    act(() => result.current.reset());
    expect(result.current.cursor).toBeNull();
    expect(result.current.pageNumber).toBe(1);
    expect(result.current.canGoBack).toBe(false);
  });
});
