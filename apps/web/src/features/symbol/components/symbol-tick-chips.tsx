import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { formatLastTick, formatTickLatency } from '@/shared/lib/format-tick';
import { t } from '@/shared/lib/i18n';

/**
 * Compact two-chip row showing per-profile tick health on the symbol-detail
 * price strip. Mirrors the dashboard card's `Last tick` / `Latency` readout
 * so the operator can tell at a glance whether the strategy is currently
 * ticking for this symbol's profile without bouncing back to the dashboard.
 *
 * Reads from `dashboardAggregateQueryOptions` so the cache is shared with the
 * dashboard route — no extra fetch, and the values move in lockstep.
 */
export function SymbolTickChips({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const accountId = useActiveAccountId() ?? '';
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const row = data?.profiles.find((p) => p.profileId === profileId);

  // Hold the chips' vertical space while the aggregate loads so the strip
  // does not collapse then re-expand when data arrives.
  if (data === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-6 w-16 animate-pulse rounded-full bg-surface-alt" />
        <span className="h-6 w-16 animate-pulse rounded-full bg-surface-alt" />
      </div>
    );
  }

  // Aggregate landed but this profile isn't in it — nothing to show.
  if (!row) return null;

  const awaitingFirstTick = row.lastTickAt === null;
  // The "Set API key" link must track the actual key state, not the tick
  // state — a profile with a bound key but no ticks yet should not surface
  // a stale "Configure API key" prompt (the key is already there).
  const needsApiKey = !row.apiKeyConfigured;

  return (
    <div
      // flex-wrap so the two chips reflow on a 375px viewport instead of
      // overflowing the strip; gap-2 keeps them comfortable on desktop.
      className="flex flex-wrap items-center gap-2"
      data-testid="symbol-tick-chips"
    >
      <TickChip
        label={t('symbol.tick.last_tick')}
        value={awaitingFirstTick ? t('symbol.tick.awaiting') : formatLastTick(row.lastTickAt)}
        testId="symbol-tick-chip-last-tick"
      />
      {needsApiKey ? (
        // Sibling of the chip span — nesting it would make a screen reader
        // concatenate the link copy into the chip's accessible name.
        <Link
          to="/accounts/$accountId/api-key"
          params={{ accountId }}
          aria-label={t('symbol.tick.configure_key.aria', { profileName: row.name })}
          className="text-xs text-accent underline"
          data-testid="symbol-tick-chip-api-key-link"
        >
          {t('symbol.tick.configure_key')}
        </Link>
      ) : (
        <TickChip
          label={t('symbol.tick.latency')}
          value={formatTickLatency(row.lastTickLatencyMs)}
          testId="symbol-tick-chip-latency"
        />
      )}
    </div>
  );
}

function TickChip({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-xs text-muted-fg"
      data-testid={testId}
    >
      <span>{label}</span>
      <span className="font-medium text-fg tabular-nums">{value}</span>
    </span>
  );
}
