import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useTheme } from '@/shared/hooks/use-theme';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.removeItem('theme');
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    localStorage.removeItem('theme');
  });

  it('defaults to light when nothing is set', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
  });

  it('toggles between light and dark and applies data-theme', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe('light');
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('cross-tab sync via storage event updates the hook state', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
    });
    expect(result.current.theme).toBe('dark');
  });
});
