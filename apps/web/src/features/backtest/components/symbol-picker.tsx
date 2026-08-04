// Compact symbol picker for the backtest form.
//
// Defaults to the profile's configured symbol (the common case is "backtest
// what I trade"); a Change affordance reveals a searchable, TRADING-only list
// over the cached exchangeInfo so the operator can test a different single
// symbol. Mirrors the symbols/new picker's filter + render-cap, kept compact
// because it sits inside an already-long form.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { ExchangeInfoSymbol } from '@app/contracts';

import { TableSkeleton } from '@/shared/components/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import { queryDefaults } from '@/shared/lib/query-client';

const TRADING_STATUS = 'TRADING';
// A 200-row ceiling keeps the DOM cheap on the 375×667 reference viewport; the
// operator narrows the list by typing, not by scrolling thousands of rows.
const RENDER_CAP = 200;

const matches = (sym: ExchangeInfoSymbol, query: string): boolean => {
  if (query.length === 0) return true;
  const q = query.toUpperCase();
  return sym.symbol.includes(q) || sym.baseAsset.includes(q) || sym.quoteAsset.includes(q);
};

export interface SymbolPickerProps {
  readonly value: string;
  readonly onChange: (symbol: string) => void;
  /** Field label; defaults to "Symbol". The guided wizard passes "Coin". */
  readonly label?: string;
}

export function SymbolPicker({
  value,
  onChange,
  label = 'Symbol',
}: SymbolPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const exchangeInfo = useQuery({ ...queryDefaults.exchangeInfo(), queryFn: fetchExchangeInfo });

  const filtered = useMemo(() => {
    const tradable = (exchangeInfo.data?.symbols ?? []).filter((s) => s.status === TRADING_STATUS);
    return tradable.filter((s) => matches(s, search)).slice(0, RENDER_CAP);
  }, [exchangeInfo.data, search]);

  const pick = (symbol: string): void => {
    onChange(symbol);
    setSearch('');
    setOpen(false);
  };

  return (
    <div className="space-y-1">
      <Label htmlFor="bt-symbol">{label}</Label>
      <div className="flex items-center justify-between gap-2">
        <span id="bt-symbol" className="font-mono text-base font-medium tabular-nums">
          {value || '—'}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Change'}
        </Button>
      </div>

      {open ? (
        <div className="space-y-2 pt-1">
          <Input
            type="search"
            placeholder="BTCUSDT, ETH, USDT…"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            aria-label="Search symbols"
            autoComplete="off"
            autoCapitalize="characters"
          />
          {/* Matches the loaded list's `max-h-64` cap so the picker does not
              grow under the operator's thumb when exchangeInfo lands. */}
          {exchangeInfo.isLoading || exchangeInfo.isPaused ? <TableSkeleton rows={5} /> : null}
          {exchangeInfo.error ? (
            <Alert variant="danger">
              <AlertTitle>Failed to load symbols</AlertTitle>
              <AlertDescription>
                {exchangeInfo.error instanceof Error ? exchangeInfo.error.message : 'unknown'}
              </AlertDescription>
            </Alert>
          ) : null}
          {exchangeInfo.isSuccess && filtered.length === 0 ? (
            <p className="text-muted-fg text-sm">No matching symbol.</p>
          ) : null}
          {filtered.length > 0 ? (
            <ul
              className="divide-border max-h-64 divide-y overflow-y-auto rounded-lg border"
              data-testid="bt-symbol-list"
            >
              {filtered.map((s) => (
                <li key={s.symbol}>
                  <button
                    type="button"
                    className="hover:bg-surface-alt flex w-full items-center justify-between px-3 py-2 text-left"
                    onClick={() => pick(s.symbol)}
                  >
                    <span className="font-mono font-medium">{s.symbol}</span>
                    <span className="text-muted-fg text-xs">
                      {s.baseAsset}/{s.quoteAsset}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
