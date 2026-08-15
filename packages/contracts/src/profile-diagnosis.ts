// "Why isn't this profile trading?" — a ranked list of PROVABLE causes.
//
// Every rung is a threshold comparison, a timestamp subtraction, or a set
// difference over facts the caller already gathered. Nothing here guesses, and
// nothing here calls a model: the feature's whole value is that a verdict can be
// re-derived from the same inputs and come out identical, which is what makes it
// worth trusting over the operator's own reading of the logs.
//
// Pure and I/O-free by construction. The caller does every read, then runs the
// ladder; that is also what lets a background job persist each rung's outcome as
// it lands, so displayed progress is the worker's real position and never a
// timer pretending to be one.

import { z } from 'zod';
import { assessDiscoveryHealth, type SnapshotHealth } from './discovery-health.js';
import { labelForPath, titleCase } from './form-builder.js';
import { attributeBlocker, type ReasonAttributionMap } from './reason-attribution.js';
import { CONDITION_SEVERITY, type Condition, type ConditionSeverity } from './condition.js';

/**
 * The ladder, in order. Position IS the ranking: the first rung that finds
 * something owns the headline, because a dead worker makes every later answer
 * moot. All findings are still listed — the operator sees the whole picture, not
 * just the top of it.
 */
export const DIAGNOSIS_STEPS = [
  'worker-alive',
  'profile-active',
  'config-valid',
  'order-execution',
  'discovery-running',
  'market-breadth',
  'candidate-funnel',
  'symbol-slots',
  'entry-blockers',
  'exit-blockers',
  'exit-protection',
  'config-levers',
] as const;

export type DiagnosisStepId = (typeof DIAGNOSIS_STEPS)[number];

export const DIAGNOSIS_STEP_LABELS: Record<DiagnosisStepId, string> = {
  'worker-alive': 'Is the trading engine running?',
  'profile-active': 'Is this profile switched on?',
  'config-valid': 'Are the settings valid?',
  'order-execution': "Is Binance accepting this profile's orders?",
  'discovery-running': 'Is auto-discovery scanning?',
  'market-breadth': 'Is the market broad enough to buy into?',
  'candidate-funnel': 'Where do candidate coins drop out?',
  'symbol-slots': 'Is there room for another coin?',
  'entry-blockers': 'What is holding back buys?',
  'exit-blockers': 'What are the held coins waiting on to sell?',
  'exit-protection': 'Does every held coin have a way out?',
  'config-levers': 'Which setting is responsible?',
};

/**
 * `skipped` means an earlier rung made this one meaningless (no point asking
 * where candidates die when discovery is off). `unknown` means the rung could
 * not be decided — missing data, or the step itself threw. They are kept apart
 * on purpose: collapsing "not applicable" into "no problem found" is how a
 * diagnostic ends up quietly reporting health it never established.
 */
const DIAGNOSIS_STEP_STATUSES = [
  'pending',
  'running',
  'ok',
  'finding',
  'skipped',
  'unknown',
] as const;

export type DiagnosisStepStatus = (typeof DIAGNOSIS_STEP_STATUSES)[number];

export const diagnosisStepSchema = z.object({
  id: z.enum(DIAGNOSIS_STEPS),
  label: z.string(),
  status: z.enum(DIAGNOSIS_STEP_STATUSES),
  /** One line the operator reads; present for every terminal status. */
  line: z.string(),
});

export type DiagnosisStep = z.infer<typeof diagnosisStepSchema>;

/** Which settings page owns a config path, so a finding can link straight to it. */
const DIAGNOSIS_SURFACES = ['discovery', 'config', 'risk'] as const;

export type DiagnosisSurface = (typeof DIAGNOSIS_SURFACES)[number];

export const diagnosisLeverSchema = z.object({
  /** The field's rendered form label, derived the same way the form derives it. */
  label: z.string(),
  path: z.string(),
  /** Current value, formatted; null when the value could not be read. */
  value: z.string().nullable(),
  surface: z.enum(DIAGNOSIS_SURFACES),
});

export type DiagnosisLever = z.infer<typeof diagnosisLeverSchema>;

/**
 * A coin this finding covers, with its own start time.
 *
 * The pair and not a bare string because items group by reason: fifteen coins
 * held back by one guard is one finding, whose `sinceMs` is the OLDEST of the
 * fifteen. That is the right headline and the wrong span for fourteen of them,
 * so the timeline needs each coin's real start rather than the group's.
 */
export const diagnosisSymbolRefSchema = z.object({
  symbol: z.string(),
  /** When this coin picked up the condition, epoch ms; null when not known. */
  sinceMs: z.number().nullable(),
});

export type DiagnosisSymbolRef = z.infer<typeof diagnosisSymbolRefSchema>;

export const diagnosisItemSchema = z.object({
  id: z.string(),
  condition: z.string(),
  code: z.string().nullable(),
  severity: z.enum(['blocking', 'degraded']),
  title: z.string(),
  detail: z.string().nullable(),
  /** When this became true, epoch ms; null when the start is not known. */
  sinceMs: z.number().nullable(),
  /** The facts this finding rests on. Each is checkable by the operator. */
  evidence: z.array(z.string()),
  symbols: z.array(diagnosisSymbolRefSchema),
  lever: diagnosisLeverSchema.nullable(),
});

export type DiagnosisItem = z.infer<typeof diagnosisItemSchema>;

/**
 * `idle-by-design` is a first-class answer, not a fallback. A profile that is
 * switched off, or whose settings are simply strict, is working correctly, and
 * saying "blocked" there would train the operator to ignore the word.
 * `unknown` means the ladder could not establish anything — never dressed up as
 * `trading`.
 */
const DIAGNOSIS_VERDICTS = ['trading', 'blocked', 'idle-by-design', 'unknown'] as const;

export type DiagnosisVerdict = (typeof DIAGNOSIS_VERDICTS)[number];

export const diagnosisFunnelSchema = z.object({
  latestAtMs: z.number(),
  /**
   * The two segments, kept apart because they count over DIFFERENT denominators:
   * the ticker ladder over every quote-matched symbol, the candidate ladder only
   * over the shortlist whose klines were fetched. Merging them into one funnel
   * would render the drop at the seam as a collapse, when it is the design.
   */
  ticker: z.array(z.object({ stage: z.string(), survivors: z.number() })),
  candidate: z.array(z.object({ stage: z.string(), survivors: z.number() })),
  breadthOk: z.boolean().nullable(),
  /**
   * Where the ladder counts came from. `stored` is the bot's own last scan and
   * can be up to a refresh period old; `live` was re-derived against the
   * exchange during this run. The reader is told which, because "the funnel is
   * empty" and "the funnel WAS empty an hour ago" are different claims.
   */
  source: z.enum(['stored', 'live']),
  /**
   * Every field here is nullable for the same reason: a snapshot persisted
   * before the funnel field existed recorded no counts, and plotting that as
   * zero would read as "this scan found nothing" when the truth is "this scan
   * did not say". The strip exists to separate an unlucky scan from a chronic
   * choke, and a fabricated zero answers that question wrongly.
   */
  history: z.array(
    z.object({
      atMs: z.number(),
      eligible: z.number().nullable(),
      added: z.number().nullable(),
      breadthOk: z.boolean().nullable(),
    }),
  ),
});

export type DiagnosisFunnel = z.infer<typeof diagnosisFunnelSchema>;

export const profileDiagnosisSchema = z.object({
  asOfMs: z.number(),
  verdict: z.enum(DIAGNOSIS_VERDICTS),
  headline: z.string(),
  steps: z.array(diagnosisStepSchema),
  items: z.array(diagnosisItemSchema),
  funnel: diagnosisFunnelSchema.nullable(),
  timeline: z.array(
    z.object({
      atMs: z.number(),
      condition: z.string(),
      code: z.string().nullable(),
      previousCode: z.string().nullable(),
      symbol: z.string().nullable(),
    }),
  ),
});

export type ProfileDiagnosis = z.infer<typeof profileDiagnosisSchema>;

export const DIAGNOSIS_RUN_STATUSES = ['queued', 'running', 'done', 'error'] as const;

export type DiagnosisRunStatus = (typeof DIAGNOSIS_RUN_STATUSES)[number];

/**
 * One investigation as the client watches it. `steps` is live from the first
 * response — the row is seeded with every rung pending before the job is
 * enqueued — so the checklist renders immediately and every later change to it
 * is the worker's own write. `report` stays null until the run finishes.
 */
export const diagnosisRunSchema = z.object({
  id: z.string(),
  status: z.enum(DIAGNOSIS_RUN_STATUSES),
  steps: z.array(diagnosisStepSchema),
  report: profileDiagnosisSchema.nullable(),
  /** Operator-facing failure reason; null unless `status` is `error`. */
  error: z.string().nullable(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
});

export type DiagnosisRun = z.infer<typeof diagnosisRunSchema>;

/**
 * The live re-probe re-derives the funnel against the exchange, which is what
 * turns "the bot says so" into "verified" — and what makes the run take seconds
 * and spend per-account request weight. Defaulted on, declined explicitly.
 */
export const startDiagnosisRequestSchema = z.object({
  liveProbe: z.boolean().default(true),
});

export type StartDiagnosisRequest = z.infer<typeof startDiagnosisRequestSchema>;

/** The always-visible funnel panel's payload. Null when no scan carries counts. */
export const discoveryFunnelResponseSchema = z.object({
  funnel: diagnosisFunnelSchema.nullable(),
});

export type DiscoveryFunnelResponse = z.infer<typeof discoveryFunnelResponseSchema>;

/** Every rung, all pending. Seeded on the row so the first poll has a ladder. */
export const initialDiagnosisSteps = (): DiagnosisStep[] =>
  DIAGNOSIS_STEPS.map((id) => ({
    id,
    label: DIAGNOSIS_STEP_LABELS[id],
    status: 'pending' as const,
    line: '',
  }));

/** One open condition, as the caller read it out of `condition_states`. */
export interface OpenCondition {
  readonly condition: string;
  /** Empty string means the profile itself rather than one symbol. */
  readonly symbol: string;
  readonly code: string;
  readonly detail: unknown;
  readonly sinceMs: number;
}

/** One persisted discovery scan, newest-first in the input. */
export interface DiagnosisSnapshot extends SnapshotHealth {
  /** Absent for rows persisted before the funnel field; must read as unknown, not zero. */
  readonly funnel?: {
    readonly universe: number;
    readonly quote: number;
    readonly blacklist: number;
    readonly liquidity: number;
    readonly activity: number;
    readonly spread: number;
    readonly changeBand: number;
    /**
     * Candidates whose klines were fetched: the candidate ladder's denominator.
     * Optional for the same reason `funnel` itself is — a scan recorded before
     * the field existed did not measure it, and the ladder drops the rung rather
     * than drawing a zero that would read as "nothing was checked".
     */
    readonly probed?: number;
    readonly age: number;
    readonly trend: number;
    readonly eligible: number;
    readonly added: number;
    readonly breadthOk: boolean;
  };
}

export interface ProfileDiagnosisInput {
  readonly nowMs: number;
  readonly profile: {
    readonly enabled: boolean;
    readonly quoteAsset: string;
    /** The stored strategy config, for lever attribution. */
    readonly config: Record<string, unknown>;
    /** `null` when the stored discovery config did not parse, which is not "off". */
    readonly discoveryEnabled: boolean | null;
    /**
     * The stored discovery config, for the discovery levers. Separate from
     * `config` because it IS separate: discovery is platform-owned and lives in
     * its own column and its own settings page, while `config` is whatever the
     * active strategy declares. Null when it did not parse.
     */
    readonly discoveryConfig: Record<string, unknown> | null;
    readonly maxAutoSymbols: number | null;
    readonly refreshPeriodMs: number | null;
    /** Symbols currently bound by discovery (not operator-pinned). */
    readonly autoSymbolCount: number;
  };
  readonly worker: {
    /**
     * Whether the engine's heartbeat key is present.
     *
     * A boolean and not a timestamp because the key carries no last-beat time:
     * it is written with a TTL and refreshed on an interval, so expiry is the
     * staleness mechanism and presence is the whole signal. An age comparison
     * here would need a timestamp nothing writes, and a threshold that can
     * never fire reads as a live check while proving nothing.
     */
    readonly heartbeatPresent: boolean;
  };
  /**
   * Kill-switch / daily-loss halts currently in force, or null when the flag
   * could not be read.
   *
   * Nullable rather than defaulting to empty: the flag lives in Redis, and an
   * empty list is the answer "nothing is halted", which a failed read cannot
   * earn. Collapsing the two would let an unreadable store render as a clean
   * bill of health on the one rung the operator consults to find out why
   * nothing is trading.
   */
  readonly halts: readonly { readonly label: string; readonly sinceMs: number | null }[] | null;
  readonly conditions: readonly OpenCondition[];
  /** Newest-first. */
  readonly snapshots: readonly DiagnosisSnapshot[];
  /**
   * A funnel re-derived against the exchange during this run, when the operator
   * asked for one and it succeeded. Preferred over the stored snapshots for the
   * ladder, but deliberately kept OUT of `snapshots`: the history strip is the
   * bot's own scan record, and splicing a probe into it would show a scan that
   * never happened.
   */
  readonly liveFunnel?: NonNullable<DiagnosisSnapshot['funnel']>;
  readonly reasonAttribution: ReasonAttributionMap;
  readonly discoveryHealthWindow: number;
  readonly timeline: ProfileDiagnosis['timeline'];
}

export interface DiagnosisStepResult {
  readonly status: Exclude<DiagnosisStepStatus, 'pending' | 'running'>;
  readonly line: string;
  readonly items: readonly DiagnosisItem[];
}

const MS_PER = { day: 86_400_000, hour: 3_600_000, minute: 60_000 } as const;

/** Plain-language duration. Approximate on purpose — "19 days" reads, "19d 4h 12m" does not. */
export const humanizeDuration = (ms: number): string => {
  if (ms < MS_PER.minute) return 'less than a minute';
  if (ms < MS_PER.hour) {
    const m = Math.round(ms / MS_PER.minute);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms < MS_PER.day) {
    const h = Math.round(ms / MS_PER.hour);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(ms / MS_PER.day);
  return `${d} day${d === 1 ? '' : 's'}`;
};

/** Config paths are owned by one settings page; the prefix decides which. */
const surfaceForPath = (path: string): DiagnosisSurface => {
  if (path.startsWith('discovery.')) return 'discovery';
  if (path.startsWith('risk.')) return 'risk';
  return 'config';
};

const severityOf = (condition: string): ConditionSeverity =>
  CONDITION_SEVERITY[condition as Condition] ?? 'degraded';

/**
 * Discovery's own reason-code → settings-field map, in the same shape a strategy
 * declares. Owned here rather than by a strategy because discovery IS
 * platform-owned: it lives in its own config column and its own settings page,
 * and no strategy's attribution map names a funnel stage or the breadth guard.
 * Without this every discovery finding renders with no "Fix this" link at all,
 * which is the one thing those findings exist to offer.
 *
 * Paths are relative to the discovery config, matching the ids the discovery
 * form renders (its AutoForm is rooted at that schema), so the deep link lands
 * on the field rather than merely on the page.
 *
 * Stages with no entry are deliberate, not omissions: `universe` and `probed`
 * are denominators, `quote` follows the profile's quote asset rather than a
 * discovery setting, and `eligible` is the outcome of every filter above it.
 */
const DISCOVERY_LEVERS: ReasonAttributionMap = {
  'discovery-breadth': { setting: 'Market breadth floor', paths: ['marketBreadthMinPercent'] },
  maxAutoSymbols: { setting: 'Auto-held symbol cap', paths: ['maxAutoSymbols'] },
  blacklist: { setting: 'Blocklist', paths: ['blacklist'] },
  liquidity: { setting: 'Pair volume floor', paths: ['min24hPairVolumeUsd'] },
  activity: { setting: 'Coin volume floor', paths: ['min24hAssetVolumeUsd'] },
  spread: { setting: 'Spread ceiling', paths: ['maxSpreadRatio'] },
  // Three settings gate this band. Ordered as `withinChangeBand` evaluates them,
  // and the first ARMED one wins, so a band left at its defaults names the knob
  // the operator actually moved.
  changeBand: {
    setting: 'Gainers band',
    paths: ['changeMinPercent', 'rankExcludeTopPercent', 'rankTopPercent'],
  },
  age: { setting: 'Minimum listing age', paths: ['minAgeDays'] },
  trend: {
    setting: 'Trend confirmation',
    paths: ['trendConfirm.adxMin', 'trendConfirm.volMultiple', 'trendConfirm.emaPeriod'],
  },
};

/**
 * Resolve a reason code to the settings field that armed it. Discovery's own map
 * is consulted first: its codes are disjoint from any strategy's, and the
 * surface is fixed rather than inferred from the path, because discovery paths
 * are rooted at the discovery config and carry no prefix to infer from.
 *
 * Returns null when neither map declares a lever for the code — "nothing to
 * change here" is a real answer, and inventing a field for it would send the
 * operator to a page that cannot help them.
 */
const leverFor = (input: ProfileDiagnosisInput, code: string): DiagnosisLever | null => {
  const discoveryConfig = input.profile.discoveryConfig;
  const discovery = attributeBlocker(code, DISCOVERY_LEVERS, discoveryConfig ?? {});
  if (discovery?.path != null) {
    // An unreadable config still has the right destination, but not a value:
    // `displayConfigValue` renders an absent one as "off", which the operator
    // would read as a setting they made.
    return toLever(discovery.path, discoveryConfig === null ? null : discovery.value, 'discovery');
  }

  const attr = attributeBlocker(code, input.reasonAttribution, input.profile.config);
  if (!attr || attr.path === null) return null;
  return toLever(attr.path, attr.value, surfaceForPath(attr.path));
};

const toLever = (
  path: string,
  value: string | null,
  surface: DiagnosisSurface,
): DiagnosisLever => ({
  // Derived, never hand-written: the operator has to find this field on a
  // page, and a label that drifts from the form's is worse than a raw path.
  label: labelForPath(path),
  path,
  value,
  surface,
});

const openOf = (input: ProfileDiagnosisInput, condition: Condition): readonly OpenCondition[] =>
  input.conditions.filter((c) => c.condition === condition);

/**
 * Group open conditions by reason code, first-seen order. One item per REASON,
 * not per symbol: fifteen coins held by the same guard is one thing to
 * understand, and fifteen rows of it buries everything else on the page.
 */
const byCode = (open: readonly OpenCondition[]): Map<string, OpenCondition[]> => {
  const groups = new Map<string, OpenCondition[]>();
  for (const c of open) {
    const list = groups.get(c.code);
    if (list) list.push(c);
    else groups.set(c.code, [c]);
  }
  return groups;
};

/**
 * Each coin keeps its OWN start. The item's `sinceMs` is the group's oldest,
 * which is the right headline and the wrong span for every younger coin's lane.
 */
const symbolRefs = (group: readonly OpenCondition[]): DiagnosisSymbolRef[] =>
  group
    .map((g) => ({ symbol: g.symbol, sinceMs: g.sinceMs }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

// ---------------------------------------------------------------------------
// The ladder. Each rung is a total function of the input and decides only its
// own question, so the caller can run them one at a time and persist as it goes.
// ---------------------------------------------------------------------------

const stepWorkerAlive = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  if (!input.worker.heartbeatPresent) {
    // Not "unknown": the heartbeat self-expires, so its absence is positive
    // evidence that the engine stopped writing one, not a gap in the reading.
    // That expiry is also why there is no separate "stale" verdict — a stuck
    // engine stops refreshing and the key is gone within its TTL.
    return {
      status: 'finding',
      line: 'The trading engine is not reporting a heartbeat.',
      items: [
        {
          id: 'worker-alive',
          condition: 'worker-down',
          code: 'no-heartbeat',
          severity: 'blocking',
          title: 'The trading engine is not running',
          detail: 'While it is down, no profile trades, whatever its settings say.',
          sinceMs: null,
          evidence: [
            'No heartbeat is present. It expires on its own, so a running engine would have rewritten it.',
          ],
          symbols: [],
          lever: null,
        },
      ],
    };
  }
  return { status: 'ok', line: 'The trading engine is running.', items: [] };
};

const stepProfileActive = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const items: DiagnosisItem[] = [];
  if (!input.profile.enabled) {
    items.push({
      id: 'profile-disabled',
      condition: 'profile-disabled',
      code: 'disabled',
      // `degraded`, not `blocking`, and that choice sets the verdict: a
      // blocking item renders as "something is blocking it", which is the
      // wrong word for the state the operator asked for. Off is
      // idle-by-design, and calling it a block would train them to ignore
      // the one word reserved for a real fault.
      severity: 'degraded',
      title: 'This profile is switched off',
      // Deliberately not phrased as a fault: resting orders stay live by design.
      detail: 'It will not open new positions until you enable it.',
      sinceMs: null,
      evidence: ['The profile is disabled.'],
      symbols: [],
      lever: null,
    });
  }
  for (const halt of input.halts ?? []) {
    items.push({
      id: `halt:${halt.label}`,
      condition: 'halted',
      code: halt.label,
      severity: 'blocking',
      title: `Trading is halted: ${halt.label}`,
      detail: null,
      sinceMs: halt.sinceMs,
      evidence: [
        halt.sinceMs === null
          ? 'A halt is in force.'
          : `In force for ${humanizeDuration(input.nowMs - halt.sinceMs)}.`,
      ],
      symbols: [],
      lever: null,
    });
  }
  if (items.length > 0) {
    // The line is built from the items, so it makes no claim about a halt state
    // that may be unreadable. What is proven is still reported.
    return { status: 'finding', line: items.map((i) => i.title).join('; '), items };
  }
  return input.halts === null
    ? {
        status: 'unknown',
        line: 'The profile is switched on. Whether a halt is in force could not be read.',
        items: [],
      }
    : { status: 'ok', line: 'The profile is switched on and not halted.', items: [] };
};

const stepConfigValid = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const open = openOf(input, 'config-invalid');
  if (open.length === 0) {
    return { status: 'ok', line: 'The stored settings parse.', items: [] };
  }
  const items = open.map((c) => ({
    id: `config-invalid:${c.symbol}`,
    condition: c.condition,
    code: c.code,
    severity: severityOf(c.condition),
    title: 'The stored settings are not valid',
    detail: 'Discovery cannot run against settings that fail their own schema.',
    sinceMs: c.sinceMs,
    evidence: [`Invalid for ${humanizeDuration(input.nowMs - c.sinceMs)}.`, ...issuesOf(c.detail)],
    symbols: [],
    lever: null,
  }));
  return { status: 'finding', line: 'The stored settings fail validation.', items };
};

interface OrderRefusalDetail {
  readonly request: {
    readonly symbol: string;
    readonly side: string;
    readonly type: string;
    readonly quantity: string;
  };
  readonly rejection: { readonly msg: string };
  readonly threshold: number;
  readonly probeEveryMs: number;
}

const readOrderRefusalDetail = (detail: unknown): OrderRefusalDetail | null => {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  const request =
    typeof d['request'] === 'object' && d['request'] !== null
      ? (d['request'] as Record<string, unknown>)
      : null;
  const rejection =
    typeof d['rejection'] === 'object' && d['rejection'] !== null
      ? (d['rejection'] as Record<string, unknown>)
      : null;
  if (
    request === null ||
    rejection === null ||
    typeof request['symbol'] !== 'string' ||
    typeof request['side'] !== 'string' ||
    typeof request['type'] !== 'string' ||
    typeof request['quantity'] !== 'string' ||
    typeof rejection['msg'] !== 'string' ||
    // Finite, not merely numeric: both values are printed and one is divided.
    // A JSON number too large for a double parses back as Infinity, which would
    // reach the operator as "once every Infinity seconds" instead of falling to
    // the generic evidence branch below. `typeof` stays for the narrowing;
    // `Number.isFinite` is not a type guard.
    typeof d['threshold'] !== 'number' ||
    !Number.isFinite(d['threshold']) ||
    typeof d['probeEveryMs'] !== 'number' ||
    !Number.isFinite(d['probeEveryMs'])
  ) {
    return null;
  }
  return {
    request: {
      symbol: request['symbol'],
      side: request['side'],
      type: request['type'],
      quantity: request['quantity'],
    },
    rejection: { msg: rejection['msg'] },
    threshold: d['threshold'],
    probeEveryMs: d['probeEveryMs'],
  };
};

const stepOrderExecution = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const open = openOf(input, 'order-refusal-loop');
  if (open.length === 0) {
    return {
      status: 'ok',
      line: 'No repeated Binance order refusal is currently recorded.',
      items: [],
    };
  }
  const items = open.map((condition): DiagnosisItem => {
    const detail = readOrderRefusalDetail(condition.detail);
    return {
      id: `order-refusal-loop:${condition.symbol}`,
      condition: 'order-refusal-loop',
      code: condition.code,
      severity: severityOf('order-refusal-loop'),
      title: `Binance keeps refusing ${condition.symbol} orders`,
      detail:
        'The bot slowed this exact request to one probe per minute after repeated exchange refusals.',
      sinceMs: condition.sinceMs,
      evidence:
        detail === null
          ? [
              `Binance error code: ${condition.code}.`,
              'The exact request and Binance message were not recorded.',
            ]
          : [
              `Action: ${detail.request.side} ${detail.request.type} ${detail.request.quantity} ${detail.request.symbol}.`,
              `Binance ${condition.code}: ${detail.rejection.msg}`,
              `Binance refused this exact order ${detail.threshold} times. The bot now probes it once every ${Math.round(detail.probeEveryMs / 1000)} seconds.`,
            ],
      symbols: [{ symbol: condition.symbol, sinceMs: condition.sinceMs }],
      lever: null,
    };
  });
  return {
    status: 'finding',
    line: `${items.length} order refusal loop${items.length === 1 ? ' is' : 's are'} open.`,
    items,
  };
};

/** Pull the producer's `{ issues: string[] }` payload back out, tolerantly. */
const issuesOf = (detail: unknown): string[] => {
  if (typeof detail !== 'object' || detail === null) return [];
  const issues = (detail as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string') : [];
};

/**
 * Shared entry guard for the three discovery rungs. Returns the rung's result
 * when discovery cannot be assessed, or null to continue.
 *
 * `null` is not `false`: it means the stored discovery config did not parse, and
 * answering "switched off by design" there states as deliberate a setting the
 * operator never made. Unreadable degrades to `unknown`, like every other read
 * in this ladder that cannot prove its answer.
 */
const discoveryUnavailable = (
  input: ProfileDiagnosisInput,
  offLine: string,
): DiagnosisStepResult | null => {
  if (input.profile.discoveryEnabled === null) {
    return {
      status: 'unknown',
      line: 'Your auto-discovery settings could not be read, so this check was skipped.',
      items: [],
    };
  }
  return input.profile.discoveryEnabled ? null : { status: 'skipped', line: offLine, items: [] };
};

const stepDiscoveryRunning = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const unavailable = discoveryUnavailable(
    input,
    'Auto-discovery is switched off for this profile, so it adds no coins by design.',
  );
  if (unavailable) return unavailable;
  const open = openOf(input, 'discovery-stale');
  if (open.length > 0) {
    const c = open[0] as OpenCondition;
    return {
      status: 'finding',
      line: `Auto-discovery has not completed a scan for ${humanizeDuration(input.nowMs - c.sinceMs)}.`,
      items: [
        {
          id: 'discovery-stale',
          condition: c.condition,
          code: c.code,
          severity: severityOf(c.condition),
          title: 'Auto-discovery has stopped scanning',
          detail: 'No new coins can be added while it is not producing scans.',
          sinceMs: c.sinceMs,
          evidence: [`Stale for ${humanizeDuration(input.nowMs - c.sinceMs)}.`],
          symbols: [],
          lever: null,
        },
      ],
    };
  }
  // Fall back to the snapshots themselves when no condition row exists — the
  // condition is only written once the monitor has run, and a brand-new profile
  // must not read as healthy purely because nothing has looked at it yet.
  if (input.profile.refreshPeriodMs === null) {
    return { status: 'unknown', line: 'The discovery refresh interval is not known.', items: [] };
  }
  const { stale } = assessDiscoveryHealth(
    input.snapshots,
    input.profile.refreshPeriodMs,
    input.nowMs,
    input.discoveryHealthWindow,
  );
  return stale
    ? {
        status: 'finding',
        line: 'Auto-discovery has produced no recent scan.',
        items: [
          {
            id: 'discovery-stale',
            condition: 'discovery-stale',
            code: 'no-recent-scan',
            severity: 'degraded',
            title: 'Auto-discovery has stopped scanning',
            detail: null,
            sinceMs: null,
            evidence:
              input.snapshots.length === 0
                ? ['No discovery scan has ever been recorded for this profile.']
                : [
                    `Newest scan is ${humanizeDuration(
                      input.nowMs - Math.max(...input.snapshots.map((s) => s.capturedAtMs)),
                    )} old.`,
                  ],
            symbols: [],
            lever: null,
          },
        ],
      }
    : { status: 'ok', line: 'Auto-discovery is scanning on schedule.', items: [] };
};

const stepMarketBreadth = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const unavailable = discoveryUnavailable(input, 'Auto-discovery is switched off.');
  if (unavailable) return unavailable;
  const open = openOf(input, 'discovery-breadth-blocked');
  // The refresh period only feeds the staleness verdict, which this rung does
  // not read: `discovery-running` owns that answer and reports unknown without a
  // period rather than judging against a stand-in. Destructured to one field so
  // a later reader cannot pick up a `stale` computed from that stand-in.
  const { breadthBlocked } = assessDiscoveryHealth(
    input.snapshots,
    input.profile.refreshPeriodMs ?? 0,
    input.nowMs,
    input.discoveryHealthWindow,
  );
  const blocked = open.length > 0 || breadthBlocked;
  if (!blocked) {
    return { status: 'ok', line: 'The market-breadth floor is being cleared.', items: [] };
  }
  const c = open[0];
  return {
    status: 'finding',
    line: 'Every add has been blocked by the market-breadth floor.',
    items: [
      {
        id: 'discovery-breadth-blocked',
        condition: 'discovery-breadth-blocked',
        code: c?.code ?? 'breadth-floor',
        severity: 'degraded',
        title: 'The market-breadth floor is blocking every add',
        detail: `Discovery only adds coins when enough of the ${input.profile.quoteAsset} market is rising. That bar has not been met.`,
        sinceMs: c?.sinceMs ?? null,
        evidence: [
          c === undefined
            ? `The last ${input.discoveryHealthWindow} scans were all breadth-blocked.`
            : `Blocked for ${humanizeDuration(input.nowMs - c.sinceMs)}.`,
        ],
        symbols: [],
        lever: leverFor(input, 'discovery-breadth'),
      },
    ],
  };
};

/** The ticker ladder's stages, in evaluation order. */
const TICKER_STAGES = [
  'universe',
  'quote',
  'blacklist',
  'liquidity',
  'activity',
  'spread',
  'changeBand',
] as const;
/**
 * The candidate ladder's stages. A different denominator — never merged with the
 * above. `probed` leads it because {@link largestDrop} scores each stage against
 * the one before it: without a denominator of its own, `age` could never be
 * named the choke, and a funnel that collapses AT the age filter would be
 * blamed on whichever ticker filter happened to cut the most.
 */
const CANDIDATE_STAGES = ['probed', 'age', 'trend', 'eligible'] as const;

const STAGE_LABELS: Record<string, string> = {
  universe: 'All coins on the exchange',
  quote: 'Priced in your quote coin',
  blacklist: 'Not on your blocklist',
  liquidity: 'Enough trading volume',
  activity: 'Moving enough to trade',
  spread: 'Tight enough bid/ask spread',
  changeBand: 'In your chosen gainers band',
  probed: 'Price history checked',
  age: 'Listed long enough',
  trend: 'Trend confirmed',
  eligible: 'Eligible to add',
};

/**
 * Human name for a funnel stage. Exported so the chart and the finding that
 * names the choke read the same words: two spellings of "Moving enough to
 * trade" would look like two different filters to the operator.
 */
export const funnelStageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

/**
 * The counts the ladder should be read from: the live re-probe when this run
 * made one, otherwise the newest stored scan that carries funnel counts.
 * Returns null when neither exists — rows predating the funnel field carry no
 * counts, and absent data must read as unknown rather than as zero survivors.
 */
const latestFunnel = (
  input: DiagnosisFunnelInput,
): {
  readonly f: NonNullable<DiagnosisSnapshot['funnel']>;
  readonly atMs: number;
  readonly source: 'stored' | 'live';
} | null => {
  if (input.liveFunnel) return { f: input.liveFunnel, atMs: input.nowMs, source: 'live' };
  const latest = input.snapshots.find((s) => s.funnel !== undefined);
  return latest?.funnel ? { f: latest.funnel, atMs: latest.capturedAtMs, source: 'stored' } : null;
};

/**
 * One ladder's `[stage, survivors]` pairs, dropping any stage the scan did not
 * record. A missing count is not a zero: drawing it as one would show a rung
 * where every candidate died, and would let the choke search name a filter that
 * was never measured.
 */
const ladder = (
  f: NonNullable<DiagnosisSnapshot['funnel']>,
  stages: readonly (keyof NonNullable<DiagnosisSnapshot['funnel']>)[],
): (readonly [string, number])[] =>
  stages.flatMap((s) => {
    const survivors = f[s];
    return typeof survivors === 'number' ? [[s, survivors] as const] : [];
  });

const stepCandidateFunnel = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const unavailable = discoveryUnavailable(input, 'Auto-discovery is switched off.');
  if (unavailable) return unavailable;
  const source = latestFunnel(input);
  if (!source) {
    return {
      status: 'unknown',
      line: 'No scan with funnel counts has been recorded yet.',
      items: [],
    };
  }
  const f = source.f;
  const asOf =
    source.source === 'live'
      ? 'checked against the exchange just now'
      : `from the last scan, ${humanizeDuration(input.nowMs - source.atMs)} ago`;
  // Each ladder is searched on its own. The step from `changeBand` to `age` is a
  // change of denominator, not a filter rejecting anything, so a search spanning
  // both would name that seam the choke on almost every scan.
  const choke = worstChoke(
    largestDrop(ladder(f, TICKER_STAGES)),
    largestDrop(ladder(f, CANDIDATE_STAGES)),
  );
  if (f.eligible > 0) {
    return {
      status: 'ok',
      line: `${f.eligible} eligible coin${f.eligible === 1 ? '' : 's'} (${asOf}).`,
      items: [],
    };
  }
  if (!choke) {
    return {
      status: 'unknown',
      line: 'The funnel counts do not identify a choke point.',
      items: [],
    };
  }
  return {
    status: 'finding',
    line: `Candidates run out at "${funnelStageLabel(choke.stage)}" (${asOf}).`,
    items: [
      {
        id: `funnel-choke:${choke.stage}`,
        condition: 'discovery-no-candidates',
        code: choke.stage,
        severity: 'degraded',
        title: `No coin gets past "${funnelStageLabel(choke.stage)}"`,
        detail:
          'This is the filter that removes the most candidates. Loosening it is the most direct way to widen the funnel.',
        sinceMs: null,
        evidence: [
          `${choke.before} coin${choke.before === 1 ? '' : 's'} reached this filter, ${choke.after} got past it.`,
          `0 coins came out eligible (${asOf}).`,
        ],
        symbols: [],
        lever: leverFor(input, choke.stage),
      },
    ],
  };
};

/**
 * The stage that removed the largest share of what reached it. Proportional, not
 * absolute: a filter cutting 400 of 480 is the story, not one cutting 12 of 12
 * further down a ladder that was already empty. Confined to one ladder segment
 * by the caller, since a drop across the seam is a change of denominator, not a
 * filter doing work.
 */
export interface FunnelChoke {
  readonly stage: string;
  readonly before: number;
  readonly after: number;
  readonly share: number;
}

export const largestDrop = (stages: readonly (readonly [string, number])[]): FunnelChoke | null => {
  let worst: FunnelChoke | null = null;
  for (let i = 1; i < stages.length; i++) {
    const [, before] = stages[i - 1] as readonly [string, number];
    const [stage, after] = stages[i] as readonly [string, number];
    if (before <= 0 || after >= before) continue;
    const share = (before - after) / before;
    if (worst === null || share > worst.share) worst = { stage, before, after, share };
  }
  return worst;
};

/**
 * The bigger of the two ladders' chokes; each was found within its own
 * denominator. Exported so the funnel chart highlights the same rung the report
 * names: two implementations of this rule could drift, and the operator would
 * see a chart and a finding pointing at different filters.
 */
export const worstChoke = (a: FunnelChoke | null, b: FunnelChoke | null): FunnelChoke | null => {
  if (a === null) return b;
  if (b === null) return a;
  return b.share > a.share ? b : a;
};

const stepSymbolSlots = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const max = input.profile.maxAutoSymbols;
  if (max === null) {
    return { status: 'unknown', line: 'The auto-symbol limit is not known.', items: [] };
  }
  const used = input.profile.autoSymbolCount;
  if (used < max) {
    return { status: 'ok', line: `${used} of ${max} auto slots in use.`, items: [] };
  }
  return {
    status: 'finding',
    line: `All ${max} auto slots are in use, so nothing new can be added.`,
    items: [
      {
        id: 'symbol-slots-full',
        condition: 'symbol-slots-full',
        code: 'at-limit',
        severity: 'degraded',
        title: 'Every auto-discovery slot is taken',
        detail: 'A new coin can only be added once one is released or the limit is raised.',
        sinceMs: null,
        evidence: [`${used} of ${max} slots in use.`],
        symbols: [],
        lever: leverFor(input, 'maxAutoSymbols'),
      },
    ],
  };
};

const stepEntryBlockers = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const open = openOf(input, 'entry-blocked');
  if (open.length === 0) {
    return { status: 'ok', line: 'Nothing is currently blocking entries.', items: [] };
  }
  const items = [...byCode(open).entries()]
    .map(([code, group]) => {
      const oldest = Math.min(...group.map((g) => g.sinceMs));
      const symbols = symbolRefs(group);
      const gloss = input.reasonAttribution[code]?.gloss ?? code;
      return {
        id: `entry-blocked:${code}`,
        condition: 'entry-blocked',
        code,
        severity: severityOf('entry-blocked'),
        title: gloss,
        detail: input.reasonAttribution[code]?.note ?? null,
        sinceMs: oldest,
        evidence: [
          `${symbols.length} coin${symbols.length === 1 ? '' : 's'} held back by this.`,
          // The duration is the point of the condition store: the log row that
          // opened a long span is pruned well before anyone asks about it.
          `Longest-running for ${humanizeDuration(input.nowMs - oldest)}.`,
        ],
        symbols,
        lever: leverFor(input, code),
      };
    })
    .sort((a, b) => b.symbols.length - a.symbols.length);
  return {
    status: 'finding',
    line: `${open.length} coin${open.length === 1 ? '' : 's'} currently held back from buying.`,
    items,
  };
};

/**
 * Keys an exit blocker carries that are NOT the rung's own threshold.
 * `currentPrice` is the live comparand and `hasDownsideExit` is a flag the
 * protection rung owns; everything else in `detail` is, by the convention the
 * producer follows, the level this rung is waiting for.
 */
const EXIT_DETAIL_RESERVED = new Set(['currentPrice', 'hasDownsideExit']);

const detailRecord = (detail: unknown): Record<string, unknown> =>
  typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};

/**
 * The rung's thresholds in plain words, straight off the producer's own record.
 * Generic by design: a strategy that adds an exit rung gets a readable line here
 * without an edit, and a threshold re-derived in this file could disagree with
 * the one the bot actually trades on — which is the whole failure this rung
 * exists to end.
 */
const thresholdText = (detail: unknown): string =>
  Object.entries(detailRecord(detail))
    .filter(
      ([k, v]) => !EXIT_DETAIL_RESERVED.has(k) && (typeof v === 'string' || typeof v === 'number'),
    )
    .map(([k, v]) => `${titleCase(k).toLowerCase()} ${String(v)}`)
    .join(', ');

/** One held coin, its rung, and the numbers behind it — the operator's whole question in a line. */
const exitPhrase = (c: OpenCondition, input: ProfileDiagnosisInput): string => {
  const gloss = input.reasonAttribution[c.code]?.gloss ?? c.code;
  const price = detailRecord(c.detail)['currentPrice'];
  const facts = [
    thresholdText(c.detail),
    typeof price === 'string' || typeof price === 'number' ? `price ${String(price)}` : '',
  ]
    .filter((s) => s !== '')
    .join(', ');
  return facts === '' ? `${c.symbol}: ${gloss}` : `${c.symbol}: ${gloss} (${facts})`;
};

/** Coins named in the step line before it collapses to a count. */
const EXIT_LINE_SYMBOL_CAP = 3;

/**
 * Exit rungs that are a FAULT rather than a position doing its job.
 *
 * A coin waiting for its sell trigger is the normal, correct state of a held
 * position, and raising a finding for it would flip the verdict of every healthy
 * profile that happens to hold something to "idle on purpose" and hand it a
 * headline about selling. Those rungs are still reported — in this step's line,
 * with their levels — but only a rung the operator must act on becomes an item.
 * `no-exit-configured` is deliberately absent: the protection rung owns it, and
 * catches it on every reason rather than only on that one.
 */
const EXIT_FAULT_CODES = new Set(['sell-disabled', 'exit-unsellable', 'exit-config-invalid']);

const stepExitBlockers = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const open = openOf(input, 'exit-blocked');
  if (open.length === 0) {
    return { status: 'ok', line: 'No held coin is waiting on an exit.', items: [] };
  }
  const named = open.slice(0, EXIT_LINE_SYMBOL_CAP).map((c) => exitPhrase(c, input));
  const rest = open.length - named.length;
  const line = `${named.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}.`;

  const items = [...byCode(open).entries()]
    .filter(([code]) => EXIT_FAULT_CODES.has(code))
    .map(([code, group]) => {
      const oldest = Math.min(...group.map((g) => g.sinceMs));
      return {
        id: `exit-blocked:${code}`,
        condition: 'exit-blocked',
        code,
        severity: severityOf('exit-blocked'),
        title: input.reasonAttribution[code]?.gloss ?? code,
        detail: input.reasonAttribution[code]?.note ?? null,
        sinceMs: oldest,
        evidence: [
          `${group.length} held coin${group.length === 1 ? '' : 's'} affected.`,
          `Longest-running for ${humanizeDuration(input.nowMs - oldest)}.`,
        ],
        symbols: symbolRefs(group),
        lever: leverFor(input, code),
      };
    })
    .sort((a, b) => b.symbols.length - a.symbols.length);

  return { status: items.length === 0 ? 'ok' : 'finding', line, items };
};

/**
 * Coins whose protective stop the exchange refuses. Not an `exit-blocked`
 * record: the strategy did decide to guard the position, so nothing on the exit
 * side ever reported it, and the order is deferred rather than placed and
 * rejected. It belongs on this rung regardless, because this is the rung the
 * operator reads to find out what is actually guarding a held coin.
 */
const protectiveStopItems = (input: ProfileDiagnosisInput): DiagnosisItem[] =>
  [...byCode(openOf(input, 'protective-stop-blocked')).entries()].map(([code, group]) => {
    const oldest = Math.min(...group.map((g) => g.sinceMs));
    return {
      id: `protective-stop-blocked:${code}`,
      condition: 'protective-stop-blocked',
      code,
      severity: severityOf('protective-stop-blocked'),
      title: input.reasonAttribution[code]?.gloss ?? 'A protective stop could not be placed',
      detail:
        input.reasonAttribution[code]?.note ??
        'The exchange will not accept the stop at the price the strategy wants, so the position may be sitting with nothing below it.',
      sinceMs: oldest,
      evidence: [
        `${group.length} coin${group.length === 1 ? '' : 's'} affected.`,
        `Longest-running for ${humanizeDuration(input.nowMs - oldest)}.`,
      ],
      symbols: symbolRefs(group),
      lever: leverFor(input, code),
    };
  });

const stepExitProtection = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const stopItems = protectiveStopItems(input);
  const base = stepHeldCoinDownsideExit(input);
  if (stopItems.length === 0) return base;
  const coins = stopItems.reduce((n, item) => n + item.symbols.length, 0);
  const line = `${coins} coin${coins === 1 ? '' : 's'} ${coins === 1 ? 'does' : 'do'} not have the protective stop the bot wants on the exchange. An earlier stop may still be resting on some of them; others may have nothing below them.`;
  // Always a finding when one is open, whatever the held coins' own exits say: a
  // stop the exchange never accepted is not protecting at the level the strategy
  // chose, and on the coins with nothing resting it is not protecting at all.
  // Rows where a working stop still covers the position are deliberately NOT
  // filtered out — they are the amber reading of this rung, and dropping them
  // would hide a position drifting away from the stop that guards it.
  return {
    status: 'finding',
    line: base.status === 'finding' ? `${line} ${base.line}` : line,
    items: [...stopItems, ...base.items],
  };
};

const stepHeldCoinDownsideExit = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  const open = openOf(input, 'exit-blocked');
  if (open.length === 0) {
    return { status: 'skipped', line: 'No held coin was reported.', items: [] };
  }
  const flagOf = (c: OpenCondition): unknown => detailRecord(c.detail)['hasDownsideExit'];
  const unprotected = open.filter((c) => flagOf(c) === false);
  if (unprotected.length === 0) {
    // A record that never says either way cannot be read as protection: this
    // rung's only value is that its "ok" means something was checked.
    return open.every((c) => typeof flagOf(c) !== 'boolean')
      ? { status: 'unknown', line: 'The held coins carry no record of their exits.', items: [] }
      : { status: 'ok', line: 'Every held coin has an exit below its entry price.', items: [] };
  }
  const oldest = Math.min(...unprotected.map((c) => c.sinceMs));
  return {
    status: 'finding',
    line: `${unprotected.length} held coin${unprotected.length === 1 ? '' : 's'} can only be closed at a profit or by you.`,
    items: [
      {
        id: 'exit-blocked:no-downside-exit',
        condition: 'exit-blocked',
        code: 'no-exit-configured',
        severity: severityOf('exit-blocked'),
        title: 'A held coin has no exit below its entry price',
        detail:
          'No stop loss, break-even stop, ATR trail or time stop is switched on, so a falling position is held indefinitely. That can be the right choice — it should be a deliberate one.',
        sinceMs: oldest,
        evidence: [
          `${unprotected.length} of ${open.length} held coin${open.length === 1 ? '' : 's'} have no exit below their entry.`,
          `Longest-running for ${humanizeDuration(input.nowMs - oldest)}.`,
        ],
        symbols: symbolRefs(unprotected),
        lever: leverFor(input, 'no-exit-configured'),
      },
    ],
  };
};

const stepConfigLevers = (input: ProfileDiagnosisInput): DiagnosisStepResult => {
  // Both sides: a sell trigger the position cannot reach is as much a setting
  // answer as an entry guard, and the operator asked one question about a bot
  // that is not doing what they expect.
  const open = [...openOf(input, 'entry-blocked'), ...openOf(input, 'exit-blocked')];
  if (open.length === 0) {
    return {
      status: 'skipped',
      line: 'Nothing is blocking buys or sells, so no setting to name.',
      items: [],
    };
  }
  const withLever = new Set(
    open.map((c) => leverFor(input, c.code)?.path).filter((p): p is string => p !== undefined),
  );
  if (withLever.size === 0) {
    // The honest bottom rung. Not every block traces to a setting — a market
    // read or an exchange minimum is nobody's misconfiguration, and naming a
    // field anyway would be a guess dressed as a cause.
    return {
      status: 'ok',
      line: 'Nothing is misconfigured — the current blocks are market conditions, not settings.',
      items: [],
    };
  }
  return {
    status: 'finding',
    line:
      withLever.size === 1
        ? '1 setting is behind the current blocks.'
        : `${withLever.size} settings are behind the current blocks.`,
    items: [],
  };
};

/** The ladder itself, in ranking order. */
const DIAGNOSIS_LADDER: readonly {
  readonly id: DiagnosisStepId;
  readonly run: (input: ProfileDiagnosisInput) => DiagnosisStepResult;
}[] = [
  { id: 'worker-alive', run: stepWorkerAlive },
  { id: 'profile-active', run: stepProfileActive },
  { id: 'config-valid', run: stepConfigValid },
  { id: 'order-execution', run: stepOrderExecution },
  { id: 'discovery-running', run: stepDiscoveryRunning },
  { id: 'market-breadth', run: stepMarketBreadth },
  { id: 'candidate-funnel', run: stepCandidateFunnel },
  { id: 'symbol-slots', run: stepSymbolSlots },
  { id: 'entry-blockers', run: stepEntryBlockers },
  { id: 'exit-blockers', run: stepExitBlockers },
  { id: 'exit-protection', run: stepExitProtection },
  { id: 'config-levers', run: stepConfigLevers },
];

/**
 * Run one rung, converting a throw into an `unknown` step rather than failing
 * the whole run. A rung that breaks must not be able to claim health it never
 * established, and it must not take the rest of the ladder down with it.
 */
export const runDiagnosisStep = (
  id: DiagnosisStepId,
  input: ProfileDiagnosisInput,
): DiagnosisStepResult => {
  const rung = DIAGNOSIS_LADDER.find((s) => s.id === id);
  if (!rung) return { status: 'unknown', line: 'Unknown check.', items: [] };
  try {
    return rung.run(input);
  } catch {
    // A fixed sentence, not the throw's message. This line is persisted into the
    // run row and served by the GETs that stay open under LIVE_DEMO, and it is
    // read by an operator who cannot act on a stack-shaped string anyway.
    return { status: 'unknown', line: 'This check could not be completed.', items: [] };
  }
};

/**
 * What the funnel view needs, which is strictly less than a whole diagnosis.
 * The always-visible funnel panel is a view over the stored scans; the
 * investigation is an action. Keeping the projection callable from the smaller
 * input is what lets both read the ladder through the same code.
 */
export type DiagnosisFunnelInput = Pick<ProfileDiagnosisInput, 'nowMs' | 'snapshots'> & {
  readonly liveFunnel?: NonNullable<DiagnosisSnapshot['funnel']>;
};

export const projectDiagnosisFunnel = (input: DiagnosisFunnelInput): DiagnosisFunnel | null => {
  const source = latestFunnel(input);
  if (!source) return null;
  const f = source.f;
  return {
    latestAtMs: source.atMs,
    ticker: ladder(f, TICKER_STAGES).map(([stage, survivors]) => ({ stage, survivors })),
    candidate: ladder(f, CANDIDATE_STAGES).map(([stage, survivors]) => ({ stage, survivors })),
    breadthOk: f.breadthOk,
    source: source.source,
    // Always the bot's OWN scans, never the probe: this strip answers "does it
    // choke every scan or was this one unlucky", which a one-off probe cannot.
    history: input.snapshots
      .map((s) => ({
        atMs: s.capturedAtMs,
        eligible: s.funnel?.eligible ?? null,
        added: s.funnel?.added ?? null,
        breadthOk: s.breadthOk ?? null,
      }))
      .reverse(),
  };
};

/**
 * The four verdicts, in the order they are ruled out. `trading` is last and
 * strictly earned: every rung ran, none returned `unknown`, and none found
 * anything. A ladder that did not finish reads as `unknown`, because "we found
 * no problem" and "we did not finish looking" must never render as the same
 * answer.
 */
const verdictFor = (
  items: readonly DiagnosisItem[],
  steps: readonly DiagnosisStep[],
  results: ReadonlyMap<DiagnosisStepId, DiagnosisStepResult>,
): DiagnosisVerdict => {
  if (items.some((i) => i.severity === 'blocking')) return 'blocked';
  if (items.length > 0) return 'idle-by-design';
  if (!DIAGNOSIS_STEPS.every((id) => results.has(id))) return 'unknown';
  if (steps.some((s) => s.status === 'unknown')) return 'unknown';
  return 'trading';
};

/**
 * Assemble the report from the rungs' results. Takes the results rather than
 * recomputing them so the persisted per-step progress and the final report can
 * never disagree: what the operator watched happen is what they end up reading.
 */
export const buildProfileDiagnosis = (
  input: ProfileDiagnosisInput,
  results: ReadonlyMap<DiagnosisStepId, DiagnosisStepResult>,
): ProfileDiagnosis => {
  const steps: DiagnosisStep[] = DIAGNOSIS_STEPS.map((id) => {
    const r = results.get(id);
    return {
      id,
      label: DIAGNOSIS_STEP_LABELS[id],
      status: r?.status ?? 'pending',
      line: r?.line ?? '',
    };
  });
  const items = DIAGNOSIS_STEPS.flatMap((id) => results.get(id)?.items ?? []);
  const verdict = verdictFor(items, steps, results);

  const headline =
    items[0]?.title ??
    (verdict === 'trading'
      ? 'Nothing is stopping this profile from trading.'
      : 'Not enough information to say why this profile is idle.');

  return {
    asOfMs: input.nowMs,
    verdict,
    headline,
    steps,
    items,
    funnel: projectDiagnosisFunnel(input),
    timeline: [...input.timeline],
  };
};
