// Bulk manual order — places the same market order on every symbol a profile
// trades. This fires real money on every position at once, so the submit is a
// two-step action: the form builds the order, then an inline review step
// restates exactly what will happen and only its Confirm button POSTs. The
// result report shows the count and the time the orders were placed.
//
// Quote options are derived from the profile's actual symbols so a typo can't
// target a non-existent set. The component fetches the profile dashboard to
// read those symbols; the route only hands it a profileId.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Panel } from '@/shared/components/panel';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
  submitManualOrderAll,
} from '@/features/profile/api/profile-dashboard';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatClock } from '@/shared/lib/format-time';
import { distinctQuotes } from '@/shared/lib/symbol-quote';
import { Select } from '@/shared/components/ui/select';

import { asDecimalString } from '@app/contracts';
import type { ManualOrderAllRequest, ManualOrderAllResponse } from '@app/contracts';

interface BulkOrderForm {
  // Null follows the server default until an amount freezes the quote as that number's unit.
  quote: string | null;
  side: 'buy' | 'sell';
  mode: 'quoteAmount' | 'marketQuantity';
  amount: string;
}

const initialBulkForm = (): BulkOrderForm => ({
  quote: null,
  side: 'buy',
  mode: 'quoteAmount',
  amount: '',
});

/** Plain-language restatement of the staged order for the review step. */
function describeOrder(body: ManualOrderAllRequest): string {
  const verb = body.side === 'buy' ? 'Buy' : 'Sell';
  const detail =
    body.quoteAmount !== undefined
      ? `${body.quoteAmount} ${body.quote} worth`
      : `${body.marketQuantity ?? ''} units`;
  return `${verb} ${detail} on every ${body.quote} symbol this profile trades.`;
}

export function BulkOrderDrawer({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const timeZone = useTimezone();
  const [form, setForm] = useState<BulkOrderForm>(initialBulkForm);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  // The built order awaiting confirmation. Non-null = the review step is shown
  // and no POST has fired yet.
  const [pending, setPending] = useState<ManualOrderAllRequest | null>(null);

  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5_000,
  });
  const data = dashboard.data;

  // Deriving quote options from actual symbols prevents a typo from targeting a non-existent set.
  const quoteOptions = useMemo(() => (data ? distinctQuotes(data.symbols) : []), [data?.symbols]);
  const defaultQuote =
    data && quoteOptions.includes(data.quoteAsset)
      ? data.quoteAsset
      : (quoteOptions[0] ?? data?.quoteAsset ?? 'USDT');
  const selectedQuote = form.quote ?? defaultQuote;
  const quoteNeedsReselection =
    form.quote !== null && quoteOptions.length > 0 && !quoteOptions.includes(form.quote);

  const submit = useMutation({
    mutationFn: (body: ManualOrderAllRequest): Promise<ManualOrderAllResponse> =>
      submitManualOrderAll(profileId, body),
    onSuccess: (res) => {
      const placedAt = formatClock(res.firstFireAt, timeZone);
      setBanner({ kind: 'ok', message: `Placed ${res.scheduled} order(s) at ${placedAt}.` });
      setPending(null);
      setForm(initialBulkForm());
    },
    // Keep the review step open on failure so the operator can retry the same
    // order rather than re-entering it.
    onError: (err) => {
      setBanner({ kind: 'err', message: err instanceof Error ? err.message : 'submit failed' });
    },
  });

  // Step 1: build the order from the form and open the review step. No POST.
  const onSubmitBulk = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!form.amount || !dashboard.isSuccess) return;
    if (quoteOptions.length > 0 && !quoteOptions.includes(selectedQuote)) {
      setBanner({ kind: 'err', message: 'Choose an available quote currency again.' });
      return;
    }
    setBanner(null);
    const amount = asDecimalString(form.amount);
    setPending({
      quote: selectedQuote.toUpperCase(),
      side: form.side,
      ...(form.mode === 'quoteAmount' ? { quoteAmount: amount } : { marketQuantity: amount }),
    });
  };

  const submitting = submit.isPending;

  // Step 2: the review step replaces the form once an order is staged.
  if (pending) {
    return (
      <Panel
        title="Confirm bulk order"
        description="This places a market order on every matching symbol at once. There is no undo."
        testId="bulk-order-review"
      >
        <div className="space-y-3">
          <p className="text-sm" data-testid="bulk-order-review-summary">
            {describeOrder(pending)}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setPending(null)}
              disabled={submitting}
              data-testid="bulk-order-back"
            >
              Back
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => submit.mutate(pending)}
              disabled={submitting}
              data-testid="bulk-order-confirm"
            >
              {submitting ? 'Placing…' : 'Place orders'}
            </Button>
          </div>
          <ActionBanner banner={banner} />
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Bulk manual order"
      description="Places the same market order on every symbol this profile trades. You review the order before it fires; all orders are placed at once."
      testId="bulk-order-drawer"
    >
      <div className="space-y-3">
        <form
          onSubmit={onSubmitBulk}
          className="grid grid-cols-1 gap-3"
          aria-label="Bulk manual order form"
        >
          <div className="space-y-1">
            <Label htmlFor="bulk-quote">Quote</Label>
            {quoteOptions.length > 0 ? (
              <Select
                id="bulk-quote"
                className="w-full"
                value={quoteNeedsReselection ? '' : selectedQuote}
                onChange={(e) => setForm((f) => ({ ...f, quote: e.target.value, amount: '' }))}
                disabled={!dashboard.isSuccess}
                required
              >
                {quoteNeedsReselection ? (
                  <option value="" disabled>
                    Choose a quote again
                  </option>
                ) : null}
                {quoteOptions.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </Select>
            ) : (
              // Fallback for the (rare) case where no symbol's quote suffix
              // matches the known set — keep the operator unblocked rather than
              // disabling the form.
              <Input
                id="bulk-quote"
                value={selectedQuote}
                onChange={(e) => setForm((f) => ({ ...f, quote: e.target.value, amount: '' }))}
                disabled={!dashboard.isSuccess}
                required
                maxLength={8}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-side">Side</Label>
            <Select
              id="bulk-side"
              className="w-full"
              value={form.side}
              onChange={(e) => setForm((f) => ({ ...f, side: e.target.value as 'buy' | 'sell' }))}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-mode">Amount type</Label>
            <Select
              id="bulk-mode"
              className="w-full"
              value={form.mode}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  mode: e.target.value as 'quoteAmount' | 'marketQuantity',
                }))
              }
            >
              <option value="quoteAmount">Quote amount</option>
              <option value="marketQuantity">Market quantity</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bulk-amount">Amount</Label>
            <Input
              id="bulk-amount"
              inputMode="decimal"
              value={quoteNeedsReselection ? '' : form.amount}
              onChange={(e) =>
                setForm((f) => ({ ...f, quote: selectedQuote, amount: e.target.value }))
              }
              disabled={!dashboard.isSuccess || quoteNeedsReselection}
              required
            />
          </div>
          <p id="bulk-submit-hint" className="text-xs text-muted-fg">
            {quoteNeedsReselection
              ? 'The available quotes changed. Choose a quote and enter the amount again.'
              : 'Enter an amount above to enable review.'}
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={!dashboard.isSuccess || quoteNeedsReselection || !form.amount}
            aria-describedby="bulk-submit-hint"
            className="w-full sm:w-56"
          >
            Review order
          </Button>
        </form>
        <ActionBanner banner={banner} />
      </div>
    </Panel>
  );
}
