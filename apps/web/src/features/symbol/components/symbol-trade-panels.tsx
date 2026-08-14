// Manual trade + force-trigger panels for /profiles/$profileId/symbols/$symbol.
//
// Both panels are operator-initiated, side-effecting, and end on a confirm
// modal so the worker never gets a click-through accident. The manual-trade
// form maps 1:1 to ManualOrderRequest; the force-trigger panel posts the
// fixed /trigger-buy and /trigger-sell endpoints whose semantics are
// documented in the modal copy itself ("ignores Technicals gate") so the
// operator sees the override before they confirm.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { useOutcomeBanner, useOverrideOutcome } from '../lib/use-override-outcome';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { errorMessage } from '@/shared/lib/api';
import { formatAmount, formatBalanceAmount, formatMoneyAmount } from '@/shared/lib/format';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import {
  fetchSymbolTicker,
  submitManualOrder,
  symbolTickerQueryKey,
  triggerBuy,
  triggerSell,
} from '@/features/symbol/api/symbol';
import { queryDefaults } from '@/shared/lib/query-client';

import { asDecimalString, type DecimalString, type ManualOrderRequest } from '@app/contracts';

type ManualType = 'MARKET' | 'LIMIT';
type ManualSizing = 'quoteAmount' | 'quantity';

interface ManualForm {
  side: 'BUY' | 'SELL';
  type: ManualType;
  sizing: ManualSizing;
  amount: string;
  price: string;
}

const initialForm = (): ManualForm => ({
  side: 'BUY',
  type: 'MARKET',
  sizing: 'quoteAmount',
  amount: '',
  price: '',
});

/** Balances drift only on fills; a 15s poll keeps the readout live cheaply. */
const BALANCES_REFETCH_MS = 15_000;

const QUICK_PERCENTS = [25, 50, 75, 100] as const;

/**
 * Format a computed quick-fill amount as a clean decimal string for the form
 * input. apps/web is barred from decimal.js, and this is a convenience
 * pre-fill the operator reviews in the confirm dialog before it becomes an
 * order, so a `Number` round-trip is safe here (same pattern as the rest of
 * apps/web's display formatting). Trailing zeros are trimmed.
 */
const formatPrefill = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(8).replace(/\.?0+$/, '');
};

/** Display-only formatter for the "Avbl" balance readout. */
const formatBalance = (value: number): string =>
  Number.isFinite(value) ? formatAmount(value) : '0';

/**
 * Format an order-recap value with its asset suffix. Returns '—' for a
 * missing or non-positive value (e.g. a MARKET estimate with no live price
 * yet). `approx` prefixes ≈ for a value derived from a reference price rather
 * than entered by the operator.
 */
const formatRecap = (value: number, asset: string | undefined, approx: boolean): string => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const n = formatAmount(value);
  return `${approx ? '≈ ' : ''}${n}${asset ? ` ${asset}` : ''}`;
};

/**
 * Size a manual order at `percent` of the operator's available balance,
 * mirroring Binance's order-entry quick-select. The relevant balance and the
 * conversion depend on side and sizing:
 *   BUY  + quote → percent of quote free
 *   BUY  + qty   → percent of quote free, divided by price
 *   SELL + qty   → percent of base free
 *   SELL + quote → percent of base free, multiplied by price
 * The cross cases need a reference price; returns '' when one is unavailable.
 */
export const quickFillAmount = (
  percent: number,
  side: ManualForm['side'],
  sizing: ManualSizing,
  quoteFree: number,
  baseFree: number,
  price: number,
): string => {
  const fraction = percent / 100;
  if (side === 'BUY') {
    const quote = quoteFree * fraction;
    if (sizing === 'quoteAmount') return formatPrefill(quote);
    return price > 0 ? formatPrefill(quote / price) : '';
  }
  const base = baseFree * fraction;
  if (sizing === 'quantity') return formatPrefill(base);
  return price > 0 ? formatPrefill(base * price) : '';
};

/**
 * Returns the {@link ManualOrderRequest} body or a string error message
 * describing exactly why the form is invalid. Validation lives here, not
 * inside the React Hook Form / zod stack, because the form is small enough
 * that a bespoke check is clearer than wiring resolvers for two fields.
 */
export const buildManualOrderBody = (
  form: ManualForm,
): { ok: true; body: ManualOrderRequest } | { ok: false; error: string } => {
  if (!form.amount.trim()) {
    return { ok: false, error: 'Amount is required.' };
  }
  let amount: DecimalString;
  try {
    amount = asDecimalString(form.amount);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid amount' };
  }
  let price: DecimalString | undefined;
  if (form.type === 'LIMIT') {
    if (!form.price.trim()) {
      return { ok: false, error: 'Price is required for a LIMIT order.' };
    }
    try {
      price = asDecimalString(form.price);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'invalid price' };
    }
  }
  const body: ManualOrderRequest = {
    side: form.side,
    type: form.type,
    ...(form.sizing === 'quoteAmount' ? { quoteAmount: amount } : { quantity: amount }),
    ...(price !== undefined ? { price } : {}),
  };
  return { ok: true, body };
};

interface SymbolTradePanelsProps {
  readonly profileId: string;
  readonly symbol: string;
}

/**
 * The manual-trade form. The operator picks side/type/sizing/amount[/price],
 * the form validates locally, and submission is gated by a confirm modal
 * that recaps the order. The worker decides whether to use `quantity` or
 * `quoteAmount` based on `type` — both fields are accepted upstream and the
 * server returns a 4xx if the wrong combination shows up.
 */
export function ManualTradePanel({ profileId, symbol }: SymbolTradePanelsProps): React.JSX.Element {
  const [form, setForm] = useState<ManualForm>(initialForm);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const firingRef = useRef(false);
  // The 202 only means "recorded". Watch the row until a tick settles it so the
  // operator sees whether the order actually went out, not just that it was
  // scheduled.
  const outcomeWatch = useOverrideOutcome(profileId, symbol);
  useOutcomeBanner(outcomeWatch, setBanner);

  // Balances, the trading pair's assets, and the live price feed the
  // Binance-style "Avbl" readout and percentage quick-select. All three
  // queries are keyed, so they share caches with the sibling panels
  // (SymbolBalancesPanel, SymbolStatsStrip) rather than adding network load.
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    refetchInterval: BALANCES_REFETCH_MS,
    staleTime: BALANCES_REFETCH_MS,
  });
  const exchangeInfo = useQuery({
    ...queryDefaults.exchangeInfo(),
    queryFn: fetchExchangeInfo,
  });
  const ticker = useQuery({
    queryKey: symbolTickerQueryKey(profileId, symbol),
    queryFn: () => fetchSymbolTicker(profileId, symbol),
    refetchInterval: BALANCES_REFETCH_MS,
    staleTime: BALANCES_REFETCH_MS,
  });

  const pair = exchangeInfo.data?.symbols.find((s) => s.symbol === symbol);
  const balances = dashboard.data?.balances ?? [];
  const freeOf = (asset: string | undefined): number => {
    const row = asset ? balances.find((b) => b.asset === asset) : undefined;
    return row ? Number(row.free) : 0;
  };
  const quoteFree = freeOf(pair?.quoteAsset);
  const baseFree = freeOf(pair?.baseAsset);
  // Reference price for the cross conversions (BUY by qty, SELL by quote).
  // A LIMIT order sizes off the operator's own limit price — and the quick
  // buttons stay disabled until that price is entered, rather than sizing
  // off a market price the operator did not pick. A MARKET order uses the
  // live last trade price.
  const limitPrice = Number(form.price);
  const refPrice =
    form.type === 'LIMIT'
      ? Number.isFinite(limitPrice) && limitPrice > 0
        ? limitPrice
        : 0
      : Number(ticker.data?.lastPrice ?? 0);

  // A BUY spends the quote asset, a SELL spends the base asset.
  const availAsset = form.side === 'BUY' ? pair?.quoteAsset : pair?.baseAsset;
  const availFree = form.side === 'BUY' ? quoteFree : baseFree;
  // A full-size quick-fill is the single source of truth for whether the
  // percentage buttons can produce a value: `quickFillAmount` returns '' for
  // a zero balance or a cross conversion with no price — exactly when the
  // buttons must be disabled. Deriving the gate from the same function the
  // buttons call keeps the two from drifting.
  const canQuickFill =
    pair !== undefined &&
    quickFillAmount(100, form.side, form.sizing, quoteFree, baseFree, refPrice) !== '';

  // Confirm-dialog recap: the operator enters one side of the trade (a quote
  // amount or a base quantity); the other is derived from the reference price
  // so they see the full Price / Amount / Total before committing — Binance
  // shows all three. The derived side carries ≈ since the actual fill price
  // may differ (and for MARKET the price itself is the live last trade).
  const isQuoteSized = form.sizing === 'quoteAmount';
  const recapAmount = Number(form.amount);
  const recapBaseQty = isQuoteSized ? (refPrice > 0 ? recapAmount / refPrice : NaN) : recapAmount;
  const recapQuoteTotal = isQuoteSized ? recapAmount : refPrice > 0 ? recapAmount * refPrice : NaN;

  // The amount this order spends, in the same asset the "Avbl" readout shows:
  // a BUY spends quote, a SELL spends base. Warn (do not block) when it
  // exceeds the free balance — the balance is a 15s-polled snapshot, so the
  // worker/Binance stays the authority; a stale read must not gate the form.
  const spendInAvail = form.side === 'BUY' ? recapQuoteTotal : recapBaseQty;
  const insufficientBalance =
    dashboard.isSuccess && Number.isFinite(spendInAvail) && spendInAvail > availFree;

  const applyPercent = (percent: number): void => {
    const next = quickFillAmount(percent, form.side, form.sizing, quoteFree, baseFree, refPrice);
    if (next) setForm((f) => ({ ...f, amount: next }));
  };

  const submit = useMutation({
    mutationFn: (body: ManualOrderRequest) => submitManualOrder(profileId, symbol, body),
    onSuccess: (res) => {
      setBanner({ kind: 'ok', message: 'Scheduled — waiting for the bot to run it…' });
      outcomeWatch.watch(res.overrideActionId, res.createdAt);
      setConfirmOpen(false);
      setForm(initialForm());
      firingRef.current = false;
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
      setConfirmOpen(false);
      firingRef.current = false;
    },
  });

  const onReview = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBanner(null);
    const built = buildManualOrderBody(form);
    if (!built.ok) {
      setBanner({ kind: 'err', message: built.error });
      return;
    }
    setConfirmOpen(true);
  };

  const onConfirm = (): void => {
    if (firingRef.current || submit.isPending) return;
    const built = buildManualOrderBody(form);
    if (!built.ok) {
      setBanner({ kind: 'err', message: built.error });
      setConfirmOpen(false);
      return;
    }
    firingRef.current = true;
    // Keep the dialog open while the mutation is in flight so the Confirm
    // button can show its "Scheduling…" pending state; onSuccess/onError close it.
    submit.mutate(built.body);
  };

  return (
    <section className="space-y-3" data-testid="manual-trade-panel">
      <h2 className="text-sm font-semibold text-fg">Manual trade</h2>
      <form className="space-y-3" onSubmit={onReview} aria-label="Manual trade form">
        {/* min-w-0 on each column lets the flex items shrink below their
            content width; w-full on the native selects then fits them to the
            narrow right rail instead of overflowing the card on desktop. */}
        <div className="flex gap-2">
          <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span>Side</span>
            <select
              data-testid="manual-side"
              className="h-9 w-full min-w-0 rounded-xs border border-border bg-surface-alt px-2 text-sm"
              value={form.side}
              onChange={(e) => setForm({ ...form, side: e.target.value as ManualForm['side'] })}
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </Label>
          <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span>Type</span>
            <select
              data-testid="manual-type"
              className="h-9 w-full min-w-0 rounded-xs border border-border bg-surface-alt px-2 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as ManualType, price: '' })}
            >
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
            </select>
          </Label>
          <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            <span>Size by</span>
            <select
              data-testid="manual-sizing"
              title="Choose whether you enter how much cash to spend (quote, e.g. USDT) or how much coin to trade (quantity, e.g. BTC)."
              className="h-9 w-full min-w-0 rounded-xs border border-border bg-surface-alt px-2 text-sm"
              value={form.sizing}
              onChange={(e) => setForm({ ...form, sizing: e.target.value as ManualSizing })}
            >
              <option value="quoteAmount">Cash (quote)</option>
              <option value="quantity">Coin (quantity)</option>
            </select>
          </Label>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span>{form.sizing === 'quoteAmount' ? 'Quote amount' : 'Quantity'}</span>
            <span className="text-xs text-muted-fg" data-testid="manual-avbl">
              <abbr
                title="Available balance — the free amount you can trade right now"
                className="no-underline"
              >
                Avbl
              </abbr>{' '}
              <span
                className="font-mono text-fg"
                title={`${formatBalance(availFree)}${availAsset ? ` ${availAsset}` : ''}`}
              >
                {/* Cash (quote, BUY) reads as 2dp money; a base coin (SELL) keeps
                    balance precision. Matches the price formatting elsewhere on
                    the screen; full precision stays in the title. */}
                {form.side === 'BUY'
                  ? formatMoneyAmount(String(availFree))
                  : formatBalanceAmount(String(availFree))}
                {availAsset ? ` ${availAsset}` : ''}
              </span>
            </span>
          </div>
          <Input
            data-testid="manual-amount"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="0"
            aria-label={form.sizing === 'quoteAmount' ? 'Quote amount' : 'Quantity'}
          />
          <div className="grid grid-cols-4 gap-1" data-testid="manual-quick-percents">
            {QUICK_PERCENTS.map((percent) => (
              <Button
                key={percent}
                type="button"
                variant="outline"
                disabled={!canQuickFill}
                title={
                  canQuickFill
                    ? undefined
                    : form.type === 'LIMIT' && !form.price.trim()
                      ? 'Enter a limit price to quick-fill'
                      : `Insufficient ${availAsset ?? ''} balance to quick-fill`.trim()
                }
                onClick={() => applyPercent(percent)}
                data-testid={`manual-pct-${percent}`}
              >
                {percent}%
              </Button>
            ))}
          </div>
          {insufficientBalance && availAsset ? (
            <p className="text-xs text-danger" data-testid="manual-insufficient">
              Exceeds available {availAsset} balance.
            </p>
          ) : null}
        </div>

        {form.type === 'LIMIT' ? (
          <Label className="flex flex-col gap-1 text-xs">
            <span>Limit price</span>
            <Input
              data-testid="manual-price"
              inputMode="decimal"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="0"
            />
          </Label>
        ) : null}

        {/* Color the prominent action by side, terminal-style: BUY is the
            mint go, SELL is destructive red. */}
        <Button
          type="submit"
          variant={form.side === 'BUY' ? 'primary' : 'destructive'}
          className="w-full"
          data-testid="manual-review"
        >
          Review order
        </Button>
      </form>

      <ActionBanner banner={banner} />

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o && !submit.isPending) setConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm manual order</DialogTitle>
            <DialogDescription>
              {form.side} {form.type} {symbol}. The worker schedules this override; the order isn't
              placed synchronously.
            </DialogDescription>
          </DialogHeader>
          <dl
            aria-label="Order summary"
            className="divide-y divide-border rounded-md border border-border text-sm"
            data-testid="manual-order-recap"
          >
            <div className="flex justify-between px-3 py-1.5">
              <dt className="text-muted-fg">Price</dt>
              <dd className="font-mono" data-testid="recap-price">
                {formatRecap(refPrice, pair?.quoteAsset, form.type !== 'LIMIT')}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-1.5">
              <dt className="text-muted-fg">Amount</dt>
              <dd className="font-mono" data-testid="recap-amount">
                {formatRecap(recapBaseQty, pair?.baseAsset, isQuoteSized)}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-1.5">
              <dt className="text-muted-fg">Total</dt>
              <dd className="font-mono" data-testid="recap-total">
                {formatRecap(recapQuoteTotal, pair?.quoteAsset, !isQuoteSized)}
              </dd>
            </div>
          </dl>
          {form.type === 'MARKET' && refPrice <= 0 ? (
            <p className="text-xs text-muted-fg">
              Live price unavailable — the worker prices this MARKET order at fill.
            </p>
          ) : null}
          <FormActions>
            <Button
              type="button"
              variant="ghost"
              disabled={submit.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="manual-confirm"
              disabled={submit.isPending}
              onClick={onConfirm}
            >
              {submit.isPending ? 'Scheduling…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}

type ForceMode = null | 'buy' | 'sell';

/**
 * Force-trigger panel. Force buy fires `/trigger-buy` which is hard-wired to
 * `checkTechnicals: false` server-side; the modal repeats that fact in
 * plain English so the operator can't miss it. Force sell uses the
 * symmetric endpoint and notifies on completion.
 */
export function ForceTriggerPanel({
  profileId,
  symbol,
  held,
  canBuy,
  canSell,
}: SymbolTradePanelsProps & {
  /**
   * Whether the symbol currently holds a position. `undefined` means the
   * position read has not loaded yet — the guard fails open in that case so a
   * protective exit is never blocked by a missing read. `false` (a confirmed
   * flat) is the only state that disables Force sell.
   */
  readonly held?: boolean | undefined;
  /**
   * Which force actions the strategy declares (`operatorActions`). A strategy
   * that only exposes `trigger-sell` (e.g. momentum: flatten a position, no
   * manual entry) must not show a Force buy the API would 422.
   */
  readonly canBuy: boolean;
  readonly canSell: boolean;
}): React.JSX.Element {
  const [mode, setMode] = useState<ForceMode>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const outcomeWatch = useOverrideOutcome(profileId, symbol);
  useOutcomeBanner(outcomeWatch, setBanner);
  // React's `useState` setter is async (the change is committed on the next
  // render), so two clicks in the same tick both observe the old `mode` and
  // both call `mutate`. The ref flips synchronously and is the actual gate.
  const firingRef = useRef(false);

  const buy = useMutation({
    mutationFn: () => triggerBuy(profileId, symbol),
    onSuccess: (res) => {
      setBanner({ kind: 'ok', message: 'Force buy scheduled — waiting for the bot to run it…' });
      outcomeWatch.watch(res.overrideActionId, res.createdAt);
      setMode(null);
      firingRef.current = false;
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
      setMode(null);
      firingRef.current = false;
    },
  });
  const sell = useMutation({
    mutationFn: () => triggerSell(profileId, symbol),
    onSuccess: (res) => {
      setBanner({ kind: 'ok', message: 'Force sell scheduled — waiting for the bot to run it…' });
      outcomeWatch.watch(res.overrideActionId, res.createdAt);
      setMode(null);
      firingRef.current = false;
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
      setMode(null);
      firingRef.current = false;
    },
  });

  const pending = buy.isPending || sell.isPending;
  // Disable Force sell only on a CONFIRMED flat (`held === false`). While the
  // position read is still loading (`held === undefined`) the button stays
  // enabled — a stale/missing read must not block a protective exit, the same
  // authority model ManualTradePanel uses (warn, never block).
  const sellBlockedFlat = held === false;

  return (
    <section className="space-y-3" data-testid="force-trigger-panel">
      <h2 className="text-sm font-semibold text-fg">Force trigger</h2>
      <p className="text-xs text-muted-fg">
        Runs the strategy&apos;s {canBuy && canSell ? 'buy or sell' : canBuy ? 'buy' : 'sell'} for{' '}
        {symbol} now, without waiting for its normal entry/exit conditions. Each opens a
        confirmation spelling out the exact effect before it fires.
      </p>
      <div className="flex gap-2">
        {canBuy ? (
          <Button
            type="button"
            variant="primary"
            className="flex-1"
            onClick={() => {
              setBanner(null);
              setMode('buy');
            }}
            data-testid="force-buy"
          >
            Force buy
          </Button>
        ) : null}
        {canSell ? (
          <Button
            type="button"
            variant="destructive"
            className="flex-1"
            disabled={sellBlockedFlat}
            onClick={() => {
              setBanner(null);
              setMode('sell');
            }}
            data-testid="force-sell"
          >
            Force sell
          </Button>
        ) : null}
      </div>
      {canSell && sellBlockedFlat ? (
        <p className="text-xs text-muted-fg" data-testid="force-sell-flat-note">
          No open position to sell.
        </p>
      ) : null}

      <ActionBanner banner={banner} />

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => {
          if (!o && !pending) setMode(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'buy' ? `Force buy ${symbol}?` : `Force sell ${symbol}?`}
            </DialogTitle>
            <DialogDescription>
              {mode === 'buy'
                ? `${held ? `You already hold a position in ${symbol} — this adds to it. ` : ''}The buy fires immediately, regardless of the Technicals gate (technical-analysis rules that gate entries). Any RSI / SMA / EMA indicator gate (Relative Strength Index, Simple/Exponential Moving Average thresholds) you have configured still applies — only Technicals is bypassed. Cost basis is taken from the current grid configuration (this symbol's order size and spacing rules).`
                : `The sell fires immediately at market, and a notification is sent on completion.`}
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="force-confirm"
              disabled={pending}
              onClick={() => {
                if (firingRef.current || pending) return;
                firingRef.current = true;
                // Hold the dialog open during the mutation so the "Triggering…"
                // state shows; onSuccess/onError close it.
                if (mode === 'buy') buy.mutate();
                else if (mode === 'sell') sell.mutate();
              }}
            >
              {pending ? 'Triggering…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}
