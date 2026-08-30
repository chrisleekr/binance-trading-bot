import { cn } from '@/shared/lib/cn';
import { formatPercent, formatSignedAmount, signOf } from '@/shared/lib/format';

// Colour for a PnL value, keyed by its sign. Module-private on purpose: it was exported so that sign-coloured readouts which are not a full `PnlValue` could reuse the scale, and every one of those hand-rolled its own sign prefix and precision alongside it. `PnlPercent` is now the readout for a percent, so there is nothing left outside this file to hand the map to, and keeping it unexported means a future percent cannot be assembled from the parts again.
const PNL_TONE: Record<'pos' | 'neg' | 'zero', string> = {
  pos: 'text-success',
  neg: 'text-danger',
  zero: 'text-muted-fg',
};

/**
 * Unrealised-PnL readout — a sign-prefixed, formatted amount colour-coded by
 * direction (green up / red down / muted flat); a null value renders as an em
 * dash. The single PnL presentation shared by the dashboard cards and the
 * profile symbol list, so the two cannot drift.
 */
export function PnlValue({
  value,
  unit,
  className,
  testId,
}: {
  readonly value: string | null;
  /** Quote asset (e.g. "USDT") appended after the amount so the number isn't unitless. Omitted when the value is null/em-dash. */
  readonly unit?: string;
  readonly className?: string;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <span className={cn('font-mono', PNL_TONE[signOf(value)], className)} data-testid={testId}>
      {value != null ? formatSignedAmount(value) : '—'}
      {value != null && unit ? (
        <span className="ml-1 font-mono text-xs text-muted-fg">{unit}</span>
      ) : null}
    </span>
  );
}

/**
 * The percentage counterpart to {@link PnlValue} — a signed P/L ratio at a fixed 2 decimal places, colour-coded on the same green-up / red-down / muted-flat scale.
 *
 * A percentage is not money and must not share money's precision policy: `formatMoneyAmount` keeps up to 8 fraction digits below 1, which renders a genuine `-0.52246604%` directly beneath a `+18.54%` in the same column. Two decimals is all a ratio carries, and `formatPercent` also collapses a `-0.00%` that rounds to zero from below, which otherwise reads as a sign glitch rather than a loss. The `%` sign comes from the formatter, so callers must not append their own. There is no unavailable arm: a row with no usable ratio has no percentage to sign or colour, and its caller renders the dash instead of reaching here.
 *
 * @param value - The percentage as a decimal string already scaled to percent (e.g. `'-0.52246604'` for -0.52%).
 * @param className - Extra classes for the span, merged LAST so a caller's spacing or size wins a Tailwind conflict against the base classes. Every call site owns its own layout, so without this the component could only be adopted by wrapping it, and a wrapper is what let the tone drift between surfaces before.
 * @param testId - Optional `data-testid`, so a test can assert one specific row's percentage rather than searching by rendered copy.
 * @returns The formatted, sign-coloured percentage span.
 */
export function PnlPercent({
  value,
  className,
  testId,
}: {
  readonly value: string;
  readonly className?: string;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <span className={cn('font-mono', PNL_TONE[signOf(value)], className)} data-testid={testId}>
      {formatPercent(Number(value), { sign: true })}
    </span>
  );
}

/**
 * Marker for a P/L nobody could work out, and the companion of {@link PnlValue}: whenever a surface cannot render a number, it renders this instead of a zero. A cycle whose sale had no recorded purchase price contributes nothing to `profit`, so the stored number is an under-count — and an under-count of zero renders as a confident "+0.00", turning a real trade into a flat one.
 *
 * A compact glyph rather than the sentence this used to be. The sentence was the widest thing in a numeric column at 375px and repeated itself down the list, so the page spent more room saying a number was missing than it spent on the numbers that were there.
 *
 * The glyph and the description are separate props, and both must carry the fault, because they reach different readers and neither one substitutes for the other. There is deliberately no `title`: a tooltip is hover-only, so on the phone — the only place the compact card and the detail sheet it opens render at all — it would be an affordance nobody can reach, and an identical `aria-label` and `title` also makes some screen readers announce the same words twice, once as the name and once as the description.
 *
 * The glyphs are `n/a` and `net n/a`, deliberately NOT an em dash: the percent cell beside this one, and `PnlValue` with a null value, already use the em dash to mean "there is nothing here". Reusing it would make "empty" and "unknowable" the same mark, and those are the two states a reader most needs to tell apart.
 *
 * Carries no font size, because it stands in for a number `PnlValue` would have rendered and `PnlValue` sizes itself from its host too. The hosts disagree — a `text-xs` table cell and card, a `text-sm` detail sheet row, an 11px share line — so any size fixed here is the wrong one on most of them.
 *
 * Shared rather than local to one panel because the archive renders the same withheld value on five surfaces — a table row on desktop, a compact card on a phone, the detail sheet that card opens, and each summary band's amount and share — and they must never disagree about whether a number exists.
 *
 * @param testId - Optional `data-testid`, so a test can assert the unavailable marker rendered for one specific row rather than searching by copy.
 * @param glyph - The visible mark, e.g. `unavailablePnlGlyph(reason)` for a row. Required: it is the only channel a sighted touch user can read, so a caller that let it default would erase the fault distinction for exactly the reader who cannot fall back on the accessible name.
 * @param description - The full wording a screen reader announces in place of the glyph, e.g. `unavailablePnlLabel(reason)` for a row or a band-specific string for a rollup bucket. Required for the mirror-image reason: the glyph is too terse to stand alone in speech.
 * @returns The muted marker, exposed as an image so its description replaces the glyph's letters rather than being read out alongside them.
 */
export function UnavailablePnl({
  testId,
  glyph,
  description,
}: {
  readonly testId?: string;
  readonly glyph: string;
  readonly description: string;
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={description}
      className="font-mono text-muted-fg"
      data-testid={testId}
    >
      {glyph}
    </span>
  );
}
