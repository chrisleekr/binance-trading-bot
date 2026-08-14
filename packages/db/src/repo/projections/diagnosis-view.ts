import {
  projectDiagnosisFunnel,
  type DiagnosisFunnel,
  type DiagnosisSnapshot,
} from '@app/contracts';

import * as discoveryUniverseSnapshots from '../discovery-universe-snapshots.js';
import type { ProfileScope } from '../_scoped.js';

/**
 * Persisted scans in the shape the pure diagnosis reads. Shared by the API's
 * funnel panel and the worker's investigation so the two cannot disagree about
 * what a scan said.
 *
 * `funnel` is spread conditionally rather than defaulted: rows written before
 * the field existed carry no counts, and a zero there would render as "nothing
 * survived" when the truth is "not recorded".
 */
export const toDiagnosisSnapshots = (
  rows: readonly { capturedAt: Date; snapshot: unknown }[],
): DiagnosisSnapshot[] =>
  rows.map((r) => {
    // Optional chain, not a bare cast: `snapshot` is jsonb, so a null column or
    // a scalar row reaches here as something without properties, and this
    // projection must not be what takes the report down.
    const funnel = (r.snapshot as { funnel?: DiagnosisSnapshot['funnel'] } | null)?.funnel;
    return {
      capturedAtMs: r.capturedAt.getTime(),
      breadthOk: funnel?.breadthOk,
      ...(funnel ? { funnel } : {}),
    };
  });

/**
 * The always-visible funnel panel's payload: the newest scan carrying counts,
 * plus the per-scan history strip. Null when no scan carries counts at all.
 *
 * Stored scans only — a live re-probe belongs to an investigation, and splicing
 * one into this view would show a scan the bot never ran.
 */
export const getDiscoveryFunnelView = async (
  scope: ProfileScope,
  limit: number,
  nowMs: number,
): Promise<DiagnosisFunnel | null> => {
  const rows = await discoveryUniverseSnapshots.listForProfile(scope, limit);
  return projectDiagnosisFunnel({ nowMs, snapshots: toDiagnosisSnapshots(rows) });
};
