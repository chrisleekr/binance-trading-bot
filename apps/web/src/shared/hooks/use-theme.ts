import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const CHANNEL = 'theme';

function readInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage unavailable (private mode); fall through.
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/*
 * Cross-tab sync via BroadcastChannel('theme'). Falls back to the `storage`
 * event for Safari ≤14. Without the fallback, two open tabs drift after a
 * toggle.
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage write rejected (quota / private mode); applied in-memory only.
    }
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage(next);
      ch.close();
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  useEffect(() => {
    const supportsBroadcast = typeof BroadcastChannel !== 'undefined';

    let bc: BroadcastChannel | null = null;
    if (supportsBroadcast) {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (ev: MessageEvent) => {
        const v: unknown = ev.data;
        if (v === 'dark' || v === 'light') setThemeState(v);
      };
    }

    const onStorage = (ev: StorageEvent): void => {
      if (ev.key !== STORAGE_KEY) return;
      const v = ev.newValue;
      if (v === 'dark' || v === 'light') setThemeState(v);
    };
    window.addEventListener('storage', onStorage);

    return () => {
      bc?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { theme, setTheme, toggleTheme };
}
