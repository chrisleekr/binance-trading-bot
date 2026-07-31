import type { BacktestResult, MarketRegime } from '@app/contracts';

import { formatFixed2, formatPercent } from '@/shared/lib/format';

/** The run's strategy config as plain JSON, for naming which setting armed a blocker. */
export type ConfigShape = Record<string, unknown>;

/** Sign of a nullable percentage/number for MetricCard tinting; 0 reads neutral
 *  to match the on-screen legend (green = positive, red = negative). */
export const tone = (n: number | null | undefined): 'up' | 'down' | undefined =>
  n === null || n === undefined || n === 0 ? undefined : n < 0 ? 'down' : 'up';

/** Tailwind text-tone class for a sign tone. */
export const toneClass = (t: 'up' | 'down' | undefined): string =>
  t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : 'text-fg';

/** Plain-language label for a market regime row. */
export const regimeLabel = (regime: MarketRegime): string =>
  regime === 'bull' ? 'Bull · uptrend' : regime === 'bear' ? 'Bear · downtrend' : 'Neutral · chop';

export const pct = formatPercent;
export const num = formatFixed2;
export const numN = (n: number | null): string => (n === null ? '—' : formatFixed2(n));
export const pctN = (n: number | null): string => (n === null ? '—' : formatPercent(n));

/** "30%" from a holdout fraction (0.3), rounded without Math import dependence. */
export const oosPctLabel = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/**
 * Plain-language gloss for a strategy's dominant entry-block reason code, shown
 * on the zero-trade banner. Falls back to the raw code for unmapped reasons so
 * the banner stays informative as strategies add new codes.
 */
export const blockReasonLabel = (message: string): string => {
  switch (message) {
    case 'tt-regime-require-uptrend-blocked':
      return 'the market was in a downtrend, so the trend filter blocked every entry';
    case 'tt-technicals-gate-veto':
      return 'the technical-rating gate blocked entries';
    case 'tt-indicator-gate-veto':
      return 'indicators were still warming up, so entries were blocked';
    default:
      return message;
  }
};

/** The single most-frequent decision-breakdown log, or null when there are none. */
export const dominantLog = (
  logs: BacktestResult['decisionBreakdown']['logs'],
): BacktestResult['decisionBreakdown']['logs'][number] | null =>
  logs.reduce<BacktestResult['decisionBreakdown']['logs'][number] | null>(
    (top, l) => (top === null || l.count > top.count ? l : top),
    null,
  );

/**
 * Resolve a theme token (e.g. `--primary`) to its rendered `[r, g, b]`. The
 * browser normalizes any CSS color syntax — hex (dark) or oklch (light) — to
 * `rgb(...)` when read back from a computed style, so this survives both themes
 * and keeps app.css the single source of truth. Returns null when no document
 * is available (SSR / non-DOM test env), letting the caller fall back.
 */
const resolveTokenRgb = (token: string): [number, number, number] | null => {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const rendered = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rendered);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** lineColor + the two-step area-fill alpha ramp for one token, with a fallback. */
export const chartColors = (
  token: string,
  fallback: { readonly line: string; readonly top: string; readonly bottom: string },
  topAlpha: number,
  bottomAlpha: number,
): { line: string; top: string; bottom: string } => {
  const rgb = resolveTokenRgb(token);
  if (!rgb) return { line: fallback.line, top: fallback.top, bottom: fallback.bottom };
  const [r, g, b] = rgb;
  return {
    line: `rgb(${r},${g},${b})`,
    top: `rgba(${r},${g},${b},${topAlpha})`,
    bottom: `rgba(${r},${g},${b},${bottomAlpha})`,
  };
};

/** Render a metric's tag map as a compact `k=v` list, or an em dash when empty. */
export const formatTags = (tags: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(tags);
  return entries.length === 0 ? '—' : entries.map(([k, v]) => `${k}=${v}`).join(' ');
};
