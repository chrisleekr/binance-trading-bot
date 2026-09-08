// The archive's window control: the four presets, plus an explicit date range behind a fifth `Custom` option.
//
// The range is whole days rather than instants because that is the granularity the presets themselves resolve at: the server cuts Today / This week / This month at the operator's wall-clock calendar date and reads that date as UTC midnight. A `<input type="date">` bound the same way lands on the boundary rule the four presets already use, where a `datetime-local` field would offer a minute-precision the rest of the control cannot honour. What the server actually resolved is echoed back under the inputs as a labelled instant, so the approximation is visible rather than something the operator has to infer from a row that fell outside the range they thought they asked for.

import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { formatInstant } from '@/shared/lib/format-time';

import type { ArchivePeriod } from '@app/contracts';

/** The window the ledger is scoped to. `'custom'` is a fifth choice rather than a modifier on the other four: selecting it is what makes the date inputs the window in force, and leaving it is what puts them back out of play without clearing what was typed. */
export type PeriodChoice = ArchivePeriod | 'custom';

/** A custom window as the two inputs hold it — `YYYY-MM-DD` each, `''` for an edge the operator has left open. Kept as the raw input strings rather than `Date`s so an edge that is half-typed is representable without becoming an invalid instant. */
export interface CustomRange {
  readonly from: string;
  readonly to: string;
}

/** Both edges open, which is what `Custom` opens on. */
export const EMPTY_RANGE: CustomRange = { from: '', to: '' };

const PRESETS: readonly { value: ArchivePeriod; label: string }[] = [
  { value: 'a', label: 'All time' },
  { value: 'd', label: 'Today' },
  { value: 'w', label: 'This week' },
  { value: 'm', label: 'This month' },
];

/**
 * Whether the two edges are the wrong way round.
 *
 * Compared as strings, which is exact for this format and not a shortcut: a zero-padded `YYYY-MM-DD` sorts lexically in the same order it sorts chronologically, so no parse is needed and no timezone can enter the comparison.
 *
 * @param range - The two input values; an open edge cannot be on the wrong side of anything.
 * @returns True when both edges are set and `from` falls after `to`.
 */
export function rangeInverted(range: CustomRange): boolean {
  return range.from !== '' && range.to !== '' && range.from > range.to;
}

/**
 * The ISO bounds one selection puts on the read.
 *
 * `to` is the last millisecond of its day, not its midnight: the server's range predicate is inclusive on both edges, so binding a bare midnight would silently drop every trade archived during the day the operator named as the end of the window.
 *
 * An inverted range sends no bounds at all. The server answers it with a 422, which reaches this screen as the ledger's generic load failure and says nothing about the dates — so the pair is held back while it is inverted and the picker states that instead.
 *
 * @param choice - The active window; the presets send no explicit bounds and let the server resolve them from `period`.
 * @param range - The two input values, either of which may be open.
 * @returns The `from`/`to` an archive read carries, each undefined where this selection puts no bound on that edge.
 */
export function rangeBounds(
  choice: PeriodChoice,
  range: CustomRange,
): { from: string | undefined; to: string | undefined } {
  if (choice !== 'custom' || rangeInverted(range)) return { from: undefined, to: undefined };
  return {
    from: range.from === '' ? undefined : `${range.from}T00:00:00.000Z`,
    to: range.to === '' ? undefined : `${range.to}T23:59:59.999Z`,
  };
}

/**
 * What the resolved window is called, given which edges the operator actually bounded.
 *
 * Phrased from the inputs but dated from the response, because the two answer different halves of the question: the inputs say which edges are meant to be bounds, and only the response says where the server put them. An unbounded `from` comes back as the epoch, which is true and is also not something to render as `1970-01-01` beside a real date.
 *
 * @param range - The two input values, which say which edges are bounded.
 * @param from - The window start the response reported.
 * @param to - The window end the response reported.
 * @param timeZone - The operator's display zone, so the echoed instants carry the same wall clock as every other time on the page.
 * @returns The sentence under the inputs, or null while the response for this window has not arrived.
 */
function windowEcho(
  range: CustomRange,
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): string | null {
  if (from === undefined || to === undefined) return null;
  const start = formatInstant(from, timeZone);
  const end = formatInstant(to, timeZone);
  if (range.from !== '' && range.to !== '') return `Showing ${start} to ${end}`;
  if (range.from !== '') return `Showing everything since ${start}`;
  if (range.to !== '') return `Showing everything up to ${end}`;
  return `Showing the whole archive, up to ${end}`;
}

/**
 * The period control above the archive: four presets and a custom date range.
 *
 * The strip scrolls in its own container rather than wrapping, so a fifth option cannot push the page itself sideways on a 375px screen — the one width every view here has to stay usable at.
 *
 * @param choice - The window in force; `'custom'` is what reveals the date inputs.
 * @param range - The two date inputs' current values, owned by the caller because they scope its read.
 * @param onChoiceChange - Called with the newly chosen window; the caller resets its pager, since an offset or a boundary row means nothing in a different set.
 * @param onRangeChange - Called with the next pair whenever either input moves.
 * @param from - The window start the last response reported, echoed so the operator can see where the server actually cut it.
 * @param to - The window end the last response reported.
 * @param timeZone - The operator's display zone for that echo.
 * @returns The preset strip, and beneath it the range inputs when `Custom` is in force.
 */
export function ArchivePeriodPicker({
  choice,
  range,
  onChoiceChange,
  onRangeChange,
  from,
  to,
  timeZone,
}: {
  readonly choice: PeriodChoice;
  readonly range: CustomRange;
  readonly onChoiceChange: (next: PeriodChoice) => void;
  readonly onRangeChange: (next: CustomRange) => void;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly timeZone: string;
}): React.JSX.Element {
  const inverted = rangeInverted(range);
  const echo = inverted ? null : windowEcho(range, from, to, timeZone);

  return (
    // min-w-0, on the OUTERMOST box: this is a flex item of the caller's row, and a flex item's automatic minimum size is its min-content width. The scroller below carries min-w-0 for its own row, but that only zeroes its contribution as a flex item — the block between them still reports the full strip upward, so without this the item never shrinks to the line, the scroller never engages, and the whole page scrolls sideways instead.
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-xs text-muted-fg">Period</span>
        {/* Its own scroller: the strip is wider than a phone once the fifth option is on it, and an overflowing inline-flex would take the page's own horizontal scroll with it. */}
        <div className="min-w-0 overflow-x-auto">
          <Tabs value={choice} onValueChange={(v) => onChoiceChange(v as PeriodChoice)}>
            <TabsList>
              {PRESETS.map((p) => (
                <TabsTrigger
                  key={p.value}
                  value={p.value}
                  data-testid={`archive-period-${p.value}`}
                >
                  {p.label}
                </TabsTrigger>
              ))}
              <TabsTrigger value="custom" data-testid="archive-period-custom">
                Custom
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {choice === 'custom' ? (
        <div className="space-y-2" data-testid="archive-custom-range">
          {/* One column on a phone: two date fields side by side at 375px leave neither wide enough for the native picker's own controls. */}
          <div className="grid grid-cols-1 gap-2 sm:max-w-md sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="archive-range-from">From</Label>
              <Input
                id="archive-range-from"
                type="date"
                data-testid="archive-range-from"
                value={range.from}
                // `max`/`min` mark the wrong-way-round pair invalid in the native picker; they do not prevent a typed one, which is why `rangeBounds` still holds an inverted pair back.
                max={range.to === '' ? undefined : range.to}
                onChange={(e) => onRangeChange({ ...range, from: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="archive-range-to">To</Label>
              <Input
                id="archive-range-to"
                type="date"
                data-testid="archive-range-to"
                value={range.to}
                min={range.from === '' ? undefined : range.from}
                onChange={(e) => onRangeChange({ ...range, to: e.target.value })}
              />
            </div>
          </div>
          {inverted ? (
            <p className="text-[11px] text-danger" data-testid="archive-range-invalid">
              From is after To, so this range is not applied. The trades below are still the whole
              archive.
            </p>
          ) : null}
          {echo !== null ? (
            <p className="text-[11px] text-muted-fg" data-testid="archive-range-echo">
              {echo}
            </p>
          ) : null}
          <p className="text-[11px] text-muted-fg">
            Whole days, counted the same way the presets beside it count them. Leave an edge blank
            for an open one.
          </p>
        </div>
      ) : null}
    </div>
  );
}
