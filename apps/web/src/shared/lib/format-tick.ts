import { t } from '@/shared/lib/i18n';

/**
 * Human-readable "time since last tick". Seconds for the first minute, then
 * minutes / hours / days. Shared between the dashboard profile cards and the
 * symbol-detail price strip so tier boundaries stay consistent.
 */
export function formatLastTick(iso: string | null, now: () => number = Date.now): string {
  if (!iso) return t('home.card.last_tick.never');
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return t('home.card.last_tick.never');
  // Floor, not round: a tier must not roll over before its full unit has
  // elapsed (round would show "1m ago" at 59.5s).
  const seconds = Math.max(0, Math.floor((now() - ts) / 1000));
  if (seconds < 60) return t('home.card.last_tick.ago.seconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('home.card.last_tick.ago.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('home.card.last_tick.ago.hours', { hours });
  return t('home.card.last_tick.ago.days', { days: Math.floor(hours / 24) });
}

/** Formats the per-profile tick latency. Null renders as the placeholder dash. */
export function formatTickLatency(ms: number | null): string {
  if (ms === null) return t('home.card.latency.unknown');
  return t('home.card.latency.ms', { ms });
}
