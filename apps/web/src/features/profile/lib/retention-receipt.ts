// Operator-facing sentence for one retention-prune receipt.

import type { RetentionStatusResponse } from '@app/contracts';

/** Either receipt on the retention-status response; both share one shape. */
type Receipt = RetentionStatusResponse['auditPrune'];

/** "3s ago" / "12m ago" / "5h ago". Coarse on purpose: the crons run daily. */
const ageText = (ranAtMs: number, nowMs: number): string => {
  const s = Math.max(0, Math.floor((nowMs - ranAtMs) / 1_000));
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3_600)}h ago`;
};

/**
 * One prune cron's last receipt, as the operator reads it.
 *
 * A failed sweep throws into the dead-letter queue, which no operator surface
 * shows, so if this line reported only the counts the previous success would sit
 * on the page claiming a horizon that has stopped being applied. A failure
 * therefore replaces the counts outright and names what broke.
 *
 * Dropped chunks are reported beside deleted rows rather than folded into them:
 * the age rule unlinks whole expired chunks without reading their rows, so the
 * sweep that discarded the most history has the smaller row count of the two.
 */
export const describeReceipt = (label: string, r: Receipt, nowMs: number): string => {
  if (r === null) return `${label}: never run`;
  const age = ageText(r.ranAtMs, nowMs);
  if (!r.ok) return `${label}: FAILED ${age} — ${r.error ?? 'reason not recorded'}`;
  const chunks = r.byRule?.ageChunks ?? 0;
  const pruned = chunks > 0 ? `${r.deleted} rows + ${chunks} chunks` : `${r.deleted} pruned`;
  const retain = r.retentionDays === null ? '' : ` (retain ${r.retentionDays}d)`;
  return `${label}: ${pruned} ${age}${retain}`;
};
