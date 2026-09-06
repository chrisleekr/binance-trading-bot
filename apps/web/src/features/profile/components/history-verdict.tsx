// The five-second answer at the top of History: what the period made, over how many cycles, and how well that number is evidenced.
//
// Every figure here is derived from the SAME bucket the bands below render, merged per quote coin, so the header and the bands can never disagree. The ratios go through `Number` because they are display ratios, never money; the amounts stay verbatim decimal strings and render through `PnlValue`, the split documented on `shared/lib/rollup-stats.ts`.

import { PnlValue, UnavailablePnl } from '@/shared/components/pnl-value';
import { mergeRollupBuckets } from '@/shared/lib/live-scorecard';
import {
  expectancy,
  formatExpectancy,
  formatProfitFactor,
  profitFactor,
  winPct,
} from '@/shared/lib/rollup-stats';
import { formatPercent } from '@/shared/lib/format';
import {
  unavailablePnlGlyph,
  unavailablePnlLabel,
} from '@/features/profile/lib/archive-view-model';

import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';

/** The bucket shape the verdict merges. Structural rather than the wire type, so the by-source and by-intent arrays both fit and a fixture does not have to be a whole response. */
export interface VerdictBucket {
  readonly quoteAsset: string;
  readonly tradeCount: number;
  readonly netTradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly profitSum: string;
  readonly netProfit: string;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly totalFees: string;
  readonly feeBasis?: string;
}

/**
 * What share of the P/L the cycles produced was handed to Binance.
 *
 * The denominator is the winners' and losers' magnitudes AFTER their fees, which is what the bucket carries, so the reading is "for every unit of profit and loss these cycles produced, this much again went in commission". A bucket that moved no money has no drag to state rather than an infinite one.
 *
 * @param bucket - The merged bucket, whose gross magnitudes and fee total span the same fee-valued cycles.
 * @returns The drag as a percentage, or null when there is no P/L for it to be a share of.
 */
function feeDragPct(bucket: VerdictBucket): number | null {
  const magnitude = Number(bucket.grossProfit) + Number(bucket.grossLoss);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const fees = Number(bucket.totalFees);
  if (!Number.isFinite(fees)) return null;
  return (fees / magnitude) * 100;
}

/**
 * One verdict cell.
 *
 * Module-level because `react/no-unstable-nested-components` is armed: a component declared in a render body remounts its subtree on every render, which on WebKit also clamps the page's scroll position.
 *
 * @param label - The figure's name, in the operator's words rather than the field's.
 * @param hint - Plain-language gloss of what the figure means, available to screen readers without turning the summary into a false control.
 * @param testId - Identifies this tile; keyed by quote coin at the call site, since a period spanning two coins renders two of every tile.
 * @param children - The figure itself, or the withheld marker where the evidence cannot support one.
 * @param sub - The caveat line under the figure, e.g. the cycles it actually covers. Absent when the figure carries none.
 * @returns The tile.
 */
function VerdictTile({
  label,
  hint,
  testId,
  children,
  sub,
}: {
  readonly label: string;
  /** Plain-language gloss of the term. The operator is not a finance professional, so the meaning must remain available to assistive technology. */
  readonly hint: string;
  readonly testId: string;
  readonly children: React.ReactNode;
  readonly sub?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex min-h-11 flex-col items-start gap-0.5 rounded-md border border-border p-2 text-left"
    >
      <dt className="text-[11px] tracking-wide text-muted-fg uppercase">
        {label}
        <span className="sr-only">. {hint}.</span>
      </dt>
      <dd className="flex flex-col gap-0.5">
        <span className="font-mono text-sm tabular-nums">{children}</span>
        {sub !== undefined ? <span className="text-[11px] text-muted-fg">{sub}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The caveats the headline amount carries, joined into one line.
 *
 * Composed rather than chosen between: coverage and estimation are independent facts about the same figure, and the common case is both — a window holding some unvalued cycles is usually one whose valued ones were priced off the rate card. A ternary chain silently dropped whichever came second.
 *
 * `estimated` is scoped to the Net basis alone, because the Recorded amount subtracts no fee at all, so no fee tier qualifies it.
 *
 * @param basis - Which amount the tile is showing; only Net rests on a reconstructed commission.
 * @param netTradeCount - Cycles the Net amount was summed over.
 * @param tradeCount - Cycles the window holds, which is what the Trades tile beside it counts.
 * @param feeBasis - The bucket's weakest fee tier.
 * @returns The joined caveat line, or undefined when the amount carries none.
 */
function pnlCaveats(
  basis: PnlBasis,
  netTradeCount: number,
  tradeCount: number,
  feeBasis: string | undefined,
): string | undefined {
  if (basis !== 'net') return undefined;
  const parts: string[] = [];
  if (tradeCount > netTradeCount) parts.push(`${netTradeCount} of ${tradeCount} cycles`);
  if (feeBasis === 'estimated') parts.push('estimated');
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * The withheld marker every fee-derived tile shares, so one missing fee reads the same way in all four.
 *
 * @returns The `net n/a` marker with the accessible description naming the fee fault. The fault has to survive in the glyph and its description together, because the four tiles that use this sit beside a Trades tile that is never withheld — so "this one is blank" is not on its own a readable difference.
 */
function withheldTile(): React.JSX.Element {
  return (
    <UnavailablePnl glyph={unavailablePnlGlyph('fees')} description={unavailablePnlLabel('fees')} />
  );
}

/**
 * The period's verdict, one block per quote coin the period holds.
 *
 * One block per coin rather than one merged block, because the buckets are keyed by `(quoteAsset, dimension)` and a profile whose quote changed carries cycles in two currencies: merging them would add a BTC figure to a USDT one and label the result with whichever coin came first.
 *
 * The four fee-derived tiles follow the bucket's tier rather than the operator's basis choice. Win rate, expectancy, profit factor and fee drag are all read off the fee-adjusted money whatever basis the amount above them is showing, so a bucket that valued nothing has no honest reading for any of them, and the Recorded basis does not rescue them.
 *
 * @param buckets - The period's rollup buckets; the by-source array, since it partitions the same cycles as by-intent and every cycle carries a source.
 * @param basis - Which P/L the operator asked to see, which selects the headline amount only.
 * @returns One verdict block per quote coin, or nothing when the period holds no cycles.
 */
export function HistoryVerdict({
  buckets,
  basis,
}: {
  readonly buckets: readonly VerdictBucket[];
  readonly basis: PnlBasis;
}): React.JSX.Element | null {
  if (buckets.length === 0) return null;
  const quotes = [...new Set(buckets.map((b) => b.quoteAsset))].sort((a, b) => a.localeCompare(b));

  return (
    <>
      {quotes.map((quoteAsset) => {
        // `mergeRollupBuckets` drops the coin from its result, having been asked to count in exactly one; the tiles below still have to name it.
        const merged = { ...mergeRollupBuckets(buckets, quoteAsset), quoteAsset };
        const valued = merged.netTradeCount > 0;
        const pf = valued ? profitFactor(merged) : null;
        const exp = valued ? expectancy(merged) : null;
        const drag = valued ? feeDragPct(merged) : null;
        const amount = basis === 'net' ? merged.netProfit : merged.profitSum;

        return (
          <section
            key={quoteAsset}
            className="space-y-2 rounded-md border border-border p-3"
            data-testid={`history-verdict-${quoteAsset}`}
            aria-label={`Verdict for ${quoteAsset}`}
          >
            <p className="text-sm font-medium text-fg">
              Verdict{quotes.length > 1 ? ` · ${quoteAsset}` : ''}
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <VerdictTile
                label={basis === 'net' ? 'Net P/L' : 'Recorded P/L'}
                hint={
                  basis === 'net'
                    ? 'What the closed cycles made after commission'
                    : 'What the closed cycles made as booked, before the commissions charged outside the coin you bought'
                }
                testId={`verdict-pnl-${quoteAsset}`}
                sub={
                  valued
                    ? pnlCaveats(basis, merged.netTradeCount, merged.tradeCount, merged.feeBasis)
                    : undefined
                }
              >
                {basis === 'net' && !valued ? (
                  withheldTile()
                ) : (
                  <PnlValue value={amount} unit={quoteAsset} />
                )}
              </VerdictTile>

              <VerdictTile
                label="Trades"
                hint="Closed buy-then-sell cycles in this period"
                testId={`verdict-trades-${quoteAsset}`}
              >
                {merged.tradeCount}
              </VerdictTile>

              <VerdictTile
                label="Win rate"
                hint="Share of cycles that finished ahead once their commission was taken off"
                testId={`verdict-winrate-${quoteAsset}`}
              >
                {valued ? formatPercent(winPct(merged)) : withheldTile()}
              </VerdictTile>

              <VerdictTile
                label="Expectancy"
                hint="What an average cycle in this period was worth"
                testId={`verdict-expectancy-${quoteAsset}`}
                sub={exp !== null ? 'per trade' : undefined}
              >
                {exp !== null ? formatExpectancy(exp) : withheldTile()}
              </VerdictTile>

              <VerdictTile
                label="Profit factor"
                hint="What the winners brought back for every unit the losers cost; above 1 means the edge pays"
                testId={`verdict-pf-${quoteAsset}`}
              >
                {valued ? (pf === null ? '∞' : formatProfitFactor(pf)) : withheldTile()}
              </VerdictTile>

              <VerdictTile
                label="Fee drag"
                hint="Commission as a share of the profit and loss these cycles produced"
                testId={`verdict-fees-${quoteAsset}`}
              >
                {drag !== null ? formatPercent(drag) : withheldTile()}
              </VerdictTile>
            </dl>
          </section>
        );
      })}
    </>
  );
}
