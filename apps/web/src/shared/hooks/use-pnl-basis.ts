import { useCallback, useEffect, useState } from 'react';

// Whether P/L readouts show GROSS profit or NET of Binance commissions. Net is
// the honest default — gross overstates what was actually kept. Persisted in
// localStorage and synced across tabs (mirrors use-theme) so the operator's
// choice sticks across the History and Home P/L surfaces.

export type PnlBasis = 'net' | 'gross';

const STORAGE_KEY = 'pnl-basis';
const CHANNEL = 'pnl-basis';

function readInitialBasis(): PnlBasis {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'net' || stored === 'gross') return stored;
  } catch {
    // localStorage unavailable (private mode); fall through to the default.
  }
  return 'net';
}

export function usePnlBasis(): {
  basis: PnlBasis;
  setBasis: (next: PnlBasis) => void;
} {
  const [basis, setBasisState] = useState<PnlBasis>(readInitialBasis);

  const setBasis = useCallback((next: PnlBasis) => {
    setBasisState(next);
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

  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (ev: MessageEvent) => {
        const v: unknown = ev.data;
        if (v === 'net' || v === 'gross') setBasisState(v);
      };
    }
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key !== STORAGE_KEY) return;
      if (ev.newValue === 'net' || ev.newValue === 'gross') setBasisState(ev.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      bc?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { basis, setBasis };
}
