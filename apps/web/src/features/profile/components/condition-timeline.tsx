// What was true, and when — one swimlane per subject.
//
// Built from two sources that answer different halves of the question. The log
// edges say what changed and when; the open conditions say what is true right
// now and since when. The second half is retention-immune: a symbol blocked by
// one reason for thirty days has a single edge row, written thirty days ago and
// long since pruned, so an edges-only timeline is emptiest for exactly the
// subject that has been stuck longest.
//
// Where a span began before the oldest edge we still hold, it is drawn running
// off the left of the track and labelled with its real duration. Clipping it to
// the window would silently restate "stuck for 30 days" as "stuck since the
// window opened", which is the failure this view exists to prevent.

import { CONDITION_SEVERITY, type ProfileDiagnosis } from '@app/contracts';

import { humaniseAge } from '@/shared/lib/format-time';

export interface TimelineSpan {
  condition: string;
  code: string;
  startMs: number;
  endMs: number;
  /** Still true at the end of the window. */
  open: boolean;
  /** Began before the oldest edge the log still holds; the left end is clipped. */
  clipped: boolean;
}

export interface TimelineLane {
  /** The symbol, or null for a profile-wide condition. */
  symbol: string | null;
  spans: TimelineSpan[];
}

export interface Timeline {
  startMs: number;
  endMs: number;
  lanes: TimelineLane[];
  /** True when any span is clipped, so the view can explain the left edge once. */
  clipped: boolean;
}

const laneKey = (symbol: string | null): string => symbol ?? '';
const spanKey = (condition: string, symbol: string | null): string =>
  `${condition}|${laneKey(symbol)}`;

interface OpenSpan {
  condition: string;
  symbol: string | null;
  code: string;
  startMs: number;
  clipped: boolean;
}

/**
 * Fold condition edges and currently-open conditions into per-subject spans.
 *
 * Pure and exported so the clipping rule can be tested directly: it is the one
 * behaviour here that decides whether the view tells the truth about a span
 * older than the log.
 */
export const buildTimeline = (report: ProfileDiagnosis): Timeline => {
  const edges = [...report.timeline].sort((a, b) => a.atMs - b.atMs);
  const endMs = report.asOfMs;

  // The oldest edge is the log's own horizon: nothing before it survives, so a
  // span reaching past it is clipped rather than shortened. With no edges there
  // is no horizon to be older than, and marking spans clipped against a
  // stand-in would tell the operator they were cut off by a log that is empty.
  const horizonMs = edges[0]?.atMs ?? null;
  const clippedAt = (ms: number): boolean => horizonMs !== null && ms < horizonMs;
  const chartStartMs = horizonMs ?? endMs;

  const done: (TimelineSpan & { symbol: string | null })[] = [];
  const live = new Map<string, OpenSpan>();

  for (const e of edges) {
    const key = spanKey(e.condition, e.symbol);
    const current = live.get(key);
    if (current !== undefined) {
      done.push({ ...current, endMs: e.atMs, open: false });
      live.delete(key);
    } else if (e.previousCode !== null) {
      // A code ended here that we never saw begin: its opening edge is gone.
      done.push({
        condition: e.condition,
        symbol: e.symbol,
        code: e.previousCode,
        startMs: chartStartMs,
        endMs: e.atMs,
        open: false,
        clipped: true,
      });
    }
    if (e.code !== null) {
      live.set(key, {
        condition: e.condition,
        symbol: e.symbol,
        code: e.code,
        startMs: e.atMs,
        clipped: false,
      });
    }
  }

  // The open conditions carry the authoritative start. Where one is older than
  // the edge that appeared to open it, the older value wins: `since` outlives
  // the log row.
  //
  // Each coin uses its OWN start, never the item's. An item groups coins by
  // reason and reports the oldest of them, so painting that on every lane would
  // claim a coin was blocked since before it was — and mark it clipped on top.
  // A coin whose own start is unknown gets no synthesised span at all; the
  // profile-level item is the only one that falls back to the item's `sinceMs`.
  for (const item of report.items) {
    if (item.code === null) continue;
    const subjects: { symbol: string | null; sinceMs: number | null }[] =
      item.symbols.length > 0 ? [...item.symbols] : [{ symbol: null, sinceMs: item.sinceMs }];
    for (const { symbol, sinceMs } of subjects) {
      if (sinceMs === null) continue;
      const key = spanKey(item.condition, symbol);
      const current = live.get(key);
      if (current === undefined) {
        live.set(key, {
          condition: item.condition,
          symbol,
          code: item.code,
          startMs: sinceMs,
          clipped: clippedAt(sinceMs),
        });
      } else if (sinceMs < current.startMs) {
        live.set(key, { ...current, startMs: sinceMs, clipped: clippedAt(sinceMs) });
      }
    }
  }

  for (const s of live.values()) done.push({ ...s, endMs, open: true });

  const startMs = Math.min(chartStartMs, ...done.map((s) => s.startMs), endMs);

  const lanes = new Map<string, TimelineLane>();
  for (const s of done) {
    const key = laneKey(s.symbol);
    const lane = lanes.get(key) ?? { symbol: s.symbol, spans: [] };
    lane.spans.push({
      condition: s.condition,
      code: s.code,
      startMs: s.startMs,
      endMs: s.endMs,
      open: s.open,
      clipped: s.clipped,
    });
    lanes.set(key, lane);
  }
  for (const lane of lanes.values()) lane.spans.sort((a, b) => a.startMs - b.startMs);

  return {
    startMs,
    endMs,
    // Profile-wide first, then symbols alphabetically: the wide conditions are
    // the ones that explain every lane below them.
    lanes: [...lanes.values()].sort((a, b) =>
      a.symbol === null ? -1 : b.symbol === null ? 1 : a.symbol.localeCompare(b.symbol),
    ),
    clipped: done.some((s) => s.clipped),
  };
};

const spanTone = (condition: string): string =>
  CONDITION_SEVERITY[condition as keyof typeof CONDITION_SEVERITY] === 'blocking'
    ? 'bg-danger'
    : 'bg-warning';

function Lane({
  lane,
  startMs,
  endMs,
}: {
  readonly lane: TimelineLane;
  readonly startMs: number;
  readonly endMs: number;
}): React.JSX.Element {
  const width = Math.max(1, endMs - startMs);
  const pos = (ms: number): number => ((ms - startMs) / width) * 100;

  return (
    <li data-testid={`timeline-lane-${lane.symbol ?? 'profile'}`}>
      <p className="text-xs text-muted-fg">{lane.symbol ?? 'This profile'}</p>
      <div className="relative mt-1 h-4 w-full overflow-hidden rounded-sm bg-muted">
        {lane.spans.map((s) => {
          const left = Math.max(0, pos(s.startMs));
          return (
            <div
              key={`${s.condition}-${s.code}-${s.startMs}`}
              data-testid={`timeline-span-${s.condition}-${s.code}`}
              data-clipped={s.clipped ? 'true' : 'false'}
              data-open={s.open ? 'true' : 'false'}
              title={`${s.code} — ${humaniseAge(s.endMs - s.startMs)}${s.clipped ? ', began before the log window' : ''}`}
              className={`absolute inset-y-0 ${spanTone(s.condition)} ${
                // A clipped span keeps its square left edge and a marker stripe:
                // a rounded start would draw a beginning that was not observed.
                s.clipped ? 'rounded-r-sm border-l-2 border-dashed border-fg' : 'rounded-sm'
              }`}
              style={{ left: `${left}%`, width: `${Math.max(1, pos(s.endMs) - left)}%` }}
            />
          );
        })}
      </div>
    </li>
  );
}

export function ConditionTimeline({
  report,
}: {
  readonly report: ProfileDiagnosis;
}): React.JSX.Element | null {
  const timeline = buildTimeline(report);
  if (timeline.lanes.length === 0) return null;

  return (
    <div data-testid="condition-timeline">
      <p className="text-xs font-semibold text-fg">What has been true</p>
      <ul className="mt-2 space-y-2">
        {timeline.lanes.map((lane) => (
          <Lane
            key={lane.symbol ?? 'profile'}
            lane={lane}
            startMs={timeline.startMs}
            endMs={timeline.endMs}
          />
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-fg">
        {humaniseAge(timeline.endMs - timeline.startMs)} of history, ending now.
      </p>
      {timeline.clipped ? (
        <p className="mt-1 text-xs text-muted-fg" data-testid="timeline-clipped-note">
          A dashed left edge means the span started before the oldest log entry still kept. Its real
          length is in the finding above, which reads the start time from the condition itself, not
          from the log.
        </p>
      ) : null}
    </div>
  );
}
