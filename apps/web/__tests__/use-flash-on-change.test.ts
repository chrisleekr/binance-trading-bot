// useFlashOnChange — flash tone on numeric change, auto-clear, no-op guards.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLASH_MS, useFlashOnChange } from '../src/shared/lib/use-flash-on-change.js';

interface Props {
  v: string | null;
}

const renderFlash = (initial: string | null) =>
  renderHook(({ v }: Props) => useFlashOnChange(v), { initialProps: { v: initial } });

describe('useFlashOnChange', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not flash on the first render', () => {
    const { result } = renderFlash('100');
    expect(result.current).toBeNull();
  });

  it('flashes up when the value increases', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: '101' });
    expect(result.current).toBe('up');
  });

  it('flashes down when the value decreases', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: '99' });
    expect(result.current).toBe('down');
  });

  it('clears the tone after FLASH_MS', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: '101' });
    expect(result.current).toBe('up');
    act(() => vi.advanceTimersByTime(FLASH_MS));
    expect(result.current).toBeNull();
  });

  it('does not flash on a no-op change or a non-numeric value', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: '100' });
    expect(result.current).toBeNull();
    rerender({ v: 'abc' });
    expect(result.current).toBeNull();
  });

  it('stays null when the value becomes null', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: null });
    expect(result.current).toBeNull();
  });

  it('resets the clear timer when the value changes again before FLASH_MS', () => {
    const { result, rerender } = renderFlash('100');
    rerender({ v: '101' });
    act(() => vi.advanceTimersByTime(FLASH_MS - 200));
    rerender({ v: '102' });
    // The first change's timer is cancelled; the second restarts the window.
    act(() => vi.advanceTimersByTime(FLASH_MS - 200));
    expect(result.current).toBe('up');
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBeNull();
  });

  it('cancels the pending timer on unmount', () => {
    const { rerender, unmount } = renderFlash('100');
    rerender({ v: '101' });
    unmount();
    // The clear timer was cleared by the effect cleanup; advancing past it
    // must not fire a state update on the unmounted hook.
    expect(() => act(() => vi.advanceTimersByTime(FLASH_MS))).not.toThrow();
  });
});
