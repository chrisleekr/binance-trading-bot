// Cross-profile symbol fan-out, shared by the overview symbol table and the
// workspace rail. Both surfaces show the same flat, held-first symbol list
// across every visible profile, so the per-profile dashboard queries, the merge
// and the sort live here once.

import { useCallback } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { isManagedPosition } from '@/features/profile/lib/unrealised-pnl';

import type { DashboardAggregateRow, ProfileDashboardSymbol } from '@app/contracts';

/** One flattened row: a profile's symbol plus the profile context it needs. */
export interface SymbolRow {
  readonly profileId: string;
  readonly profileName: string;
  readonly binanceMode: 'test' | 'live';
  readonly sym: ProfileDashboardSymbol;
}

export interface MergedSymbolRows {
  readonly items: readonly SymbolRow[];
  /** True only while nothing has arrived yet (a partial result renders early). */
  readonly isLoading: boolean;
  /** True only when every profile query failed. */
  readonly isError: boolean;
  /** True when some — but not all — profiles failed (no silent failures). */
  readonly isPartial: boolean;
}

/**
 * Fan out one dashboard query per visible profile (each Redis-cached, so cheap)
 * and merge their symbols into a single held-first, alphabetical list. A single
 * profile failing flags a partial load rather than vanishing the whole list.
 */
export function useSymbolRows(rows: readonly DashboardAggregateRow[]): MergedSymbolRows {
  // Memoized so useQueries re-runs combine only when `rows` or a query result
  // changes — not on every render. With a stable combine, TanStack structurally
  // shares the result, so `items` keeps its reference while the data is
  // unchanged and SymbolTable's `useMemo([merged.items, filter])` actually hits.
  const combine = useCallback(
    (
      queries: UseQueryResult<Awaited<ReturnType<typeof fetchProfileDashboard>>>[],
    ): MergedSymbolRows => {
      const items: SymbolRow[] = [];
      queries.forEach((q, i) => {
        const row = rows[i];
        if (!row) return;
        for (const sym of q.data?.symbols ?? []) {
          items.push({
            profileId: row.profileId,
            profileName: row.name,
            binanceMode: row.binanceMode,
            sym,
          });
        }
      });
      // Open positions first — the operator opens the app to see what their
      // money is doing, so a held symbol must never sort below the flat ones.
      // Within each group, alphabetical by symbol then profile for a stable order.
      items.sort(
        (a, b) =>
          Number(isManagedPosition(b.sym)) - Number(isManagedPosition(a.sym)) ||
          a.sym.symbol.localeCompare(b.sym.symbol) ||
          a.profileName.localeCompare(b.profileName),
      );
      const allError = queries.length > 0 && queries.every((q) => q.isError);
      return {
        items,
        // Only show the loading placeholder while nothing has arrived yet. Once
        // any profile resolves, render its symbols immediately rather than
        // blanking the whole list behind one slow/retrying profile.
        isLoading: items.length === 0 && queries.some((q) => q.isLoading),
        isError: allError,
        isPartial: !allError && queries.some((q) => q.isError),
      };
    },
    [rows],
  );

  return useQueries({
    queries: rows.map((r) => ({
      queryKey: profileDashboardQueryKey(r.profileId),
      queryFn: () => fetchProfileDashboard(r.profileId),
      // Match the server's 5s Redis TTL so the table and the (global) ticker stay
      // live app-wide, even on a screen with no profile socket handler mounted.
      refetchInterval: 5000,
      staleTime: 5000,
    })),
    combine,
  });
}
