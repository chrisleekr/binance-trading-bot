// Add-symbol picker — searchable list over Binance's exchangeInfo, rendered as
// the body of the `/profiles/:id/symbols/new` route page.
//
// One TanStack Query (`exchange-info`) keyed via `queryDefaults.exchangeInfo`
// so the wizard, the picker, and any future symbol-aware screen share a
// single cached payload. The picker filters client-side; even at ~3000
// symbols the substring match runs in well under a frame on a low-end phone,
// and pre-pagination keeps the empty-state copy honest ("no match" is always
// derivable without a round-trip).
//
// Submit calls the existing `POST /profiles/:id/symbols`; on success the
// panel invalidates the profile dashboard read and closes the drawer.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Panel } from '@/shared/components/panel';
import { ApiError } from '@/shared/lib/api';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import { queryDefaults } from '@/shared/lib/query-client';
import { notifySaveDiagnostics } from '@/shared/lib/save-diagnostics';
import { addProfileSymbol } from '@/features/symbol/api/symbols-mutations';
import { profileDashboardQueryKey } from '@/features/profile/api/profile-dashboard';
import { useNavigate } from '@tanstack/react-router';

import { PositiveDecimalString, type ExchangeInfoSymbol, type SymbolCreate } from '@app/contracts';

const TRADING_STATUS = 'TRADING';
// Cap the rendered list — the operator finds via search, not infinite scroll;
// a 200-row ceiling keeps the DOM cheap on the 375×667 reference viewport
// without losing the "BTCUSDT is in the list, just keep typing" affordance.
const RENDER_CAP = 200;

const matches = (sym: ExchangeInfoSymbol, query: string): boolean => {
  if (query.length === 0) return true;
  const q = query.toUpperCase();
  return sym.symbol.includes(q) || sym.baseAsset.includes(q) || sym.quoteAsset.includes(q);
};

// Map raw API failures to plain operator guidance. The wire `code`/`message`
// pair ("1001: symbol already in profile") leaks internals; the operator needs
// the remedy, not the diagnostic. VALIDATION_FAILED keeps the server message —
// it already phrases the specific field problem.
const errorMessage = (err: unknown): string => {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'VALIDATION_FAILED':
        return err.message;
      case 'CONFLICT':
        return 'That symbol is already on this profile.';
      case 'RATE_LIMITED':
        return 'Too many requests — wait a moment and try again.';
      case 'UNAUTHENTICATED':
        return 'Your session has expired — please log in again.';
      case 'FORBIDDEN':
        return "You don't have permission to do that.";
      case 'NOT_FOUND':
        return 'That profile no longer exists.';
      case 'UPSTREAM_FAILED':
        return 'Unable to reach Binance right now — try again in a moment.';
      case 'SERVICE_UNAVAILABLE':
        return 'Service temporarily unavailable — try again soon.';
      case 'NETWORK_FAILED':
        return 'Network error — check your connection and try again.';
      default:
        return 'Something went wrong — try again.';
    }
  }
  if (err instanceof Error) return err.message;
  return 'request failed';
};

export function AddSymbolPanel({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const exDefaults = queryDefaults.exchangeInfo();

  const exchangeInfo = useQuery({
    ...exDefaults,
    queryFn: fetchExchangeInfo,
  });

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [entryPrice, setEntryPrice] = useState('');
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const tradable = useMemo(
    () => (exchangeInfo.data?.symbols ?? []).filter((s) => s.status === TRADING_STATUS),
    [exchangeInfo.data],
  );

  const filtered = useMemo(
    () => tradable.filter((s) => matches(s, search)).slice(0, RENDER_CAP),
    [tradable, search],
  );

  const add = useMutation({
    mutationFn: (body: SymbolCreate) => addProfileSymbol(profileId, body),
    onSuccess: async (created, body) => {
      // The dashboard renders its symbols grid from the profile-dashboard
      // query; invalidate that exact key so the new symbol shows immediately
      // instead of waiting for the next 5s poll.
      await queryClient.invalidateQueries({ queryKey: profileDashboardQueryKey(profileId) });
      // Toast survives the navigation; a local banner would unmount with the page.
      toast.success(
        body.avgEntryPrice !== undefined
          ? `Added ${body.symbol} at entry ${body.avgEntryPrice}.`
          : `Added ${body.symbol}.`,
      );
      notifySaveDiagnostics(created.diagnostics);
      // Done — return to the overview.
      void navigate({ to: '/' });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!selected) return;
    // Block stale submissions: if the cache refreshed since the radio was
    // checked, the previously selected symbol may no longer satisfy
    // `status === TRADING`. Check against the full `tradable` set rather
    // than the search-scoped, RENDER_CAP-limited `filtered` view — a symbol
    // outside the current search results is still tradable, and shouldn't
    // be flagged as stale just because the operator typed in the filter.
    const stillEligible = tradable.some((s) => s.symbol === selected);
    if (!stillEligible) {
      setSelected(null);
      setBanner({
        kind: 'err',
        message: 'Selection no longer matches a tradable symbol — pick again.',
      });
      // Stale selection: guide the operator back to the picker instead of
      // leaving the cleared radio off-screen below the fold on mobile.
      searchInputRef.current?.focus();
      searchInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBanner(null);
    const trimmedPrice = entryPrice.trim();
    // Validate the optional entry price with the SAME contract the server
    // enforces (PositiveDecimalString), so a typo ("abc", "1.2.3", a negative)
    // surfaces a clear banner instead of throwing inside the click handler and
    // leaving a dead button. Blank stays optional (a plain fresh add).
    let avgEntryPrice: SymbolCreate['avgEntryPrice'];
    if (trimmedPrice) {
      const parsed = PositiveDecimalString.safeParse(trimmedPrice);
      if (!parsed.success) {
        setBanner({
          kind: 'err',
          message: 'Enter a positive number for the average entry price, or leave it blank.',
        });
        return;
      }
      avgEntryPrice = parsed.data;
    }
    add.mutate({ symbol: selected, ...(avgEntryPrice ? { avgEntryPrice } : {}) });
  };

  return (
    <Panel
      title="Choose a symbol"
      description="Search Binance's tradable pairs and pick one to add to this profile."
      testId="add-symbol-panel"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          ref={searchInputRef}
          type="search"
          placeholder="BTCUSDT, ETH, USDT…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label="Search symbols"
          autoComplete="off"
          autoCapitalize="characters"
        />

        {exchangeInfo.isLoading ? (
          // Reserve list height so the real rows don't shove layout when the
          // payload lands. Six rows ≈ the typical visible window on 375×667.
          <ul className="divide-y divide-border rounded-md border border-border" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex min-h-11 items-center justify-between px-3 py-2">
                <span className="h-4 w-24 animate-pulse rounded-sm bg-muted-fg/30" />
                <span className="h-4 w-16 animate-pulse rounded-sm bg-muted-fg/30" />
              </li>
            ))}
          </ul>
        ) : null}

        {exchangeInfo.error ? (
          <Alert variant="danger">
            <AlertTitle>Failed to load symbols</AlertTitle>
            <AlertDescription>
              {exchangeInfo.error instanceof Error ? exchangeInfo.error.message : 'unknown'}
            </AlertDescription>
          </Alert>
        ) : null}

        {exchangeInfo.isSuccess && filtered.length === 0 ? (
          <p className="text-sm text-muted-fg">
            No matching symbol. Check the spelling (e.g. BTC, ETH) or try a different pair — only
            pairs currently tradable on Binance appear here.
          </p>
        ) : null}

        {filtered.length > 0 ? (
          <ul
            className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border"
            data-testid="symbols-new-list"
          >
            {filtered.map((s) => {
              const checked = selected === s.symbol;
              return (
                <li key={s.symbol}>
                  <label className="flex min-h-11 items-center justify-between px-3 py-2">
                    <span className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="symbol"
                        value={s.symbol}
                        aria-label={s.symbol}
                        checked={checked}
                        onChange={() => setSelected(s.symbol)}
                        className="size-5 cursor-pointer accent-accent"
                      />
                      <span className="font-mono font-medium">{s.symbol}</span>
                    </span>
                    <span className="font-mono text-xs text-muted-fg">
                      {s.baseAsset}/{s.quoteAsset}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="space-y-1">
          <label htmlFor="add-symbol-entry-price" className="text-sm font-medium">
            Average entry price <span className="font-normal text-muted-fg">(optional)</span>
          </label>
          <Input
            id="add-symbol-entry-price"
            inputMode="decimal"
            placeholder="e.g. 42000"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.currentTarget.value)}
            autoComplete="off"
            data-testid="add-symbol-entry-price"
          />
          <p className="text-xs text-muted-fg">
            Already hold this coin? Enter your average buy price so the bot manages the position and
            can sell it. Leave blank to trade it fresh. The profile must be enabled so the bot can
            read your balance.
          </p>
        </div>

        <ActionBanner banner={banner} />

        <Button
          type="submit"
          variant="primary"
          disabled={add.isPending || !selected}
          className="w-full sm:w-56"
        >
          {add.isPending ? 'Adding…' : 'Add symbol'}
        </Button>
      </form>
    </Panel>
  );
}
