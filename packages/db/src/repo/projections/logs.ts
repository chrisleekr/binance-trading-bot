import type { SymbolLogList } from '@app/contracts';

import * as actionLogs from '../action-logs.js';
import * as auditLogs from '../audit-logs.js';
import type { ProfileScope } from '../_scoped.js';

/** One serialised `audit_logs` row for the NDJSON export stream. */
export interface AuditLogExportRow {
  id: string;
  event: string;
  actor: string | null;
  payload: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** Per-symbol action-log entries within a `[from, to]` window. */
export const getSymbolLogs = async (
  scope: ProfileScope,
  symbol: string,
  from: Date,
  to: Date,
): Promise<SymbolLogList> => {
  const rows = await actionLogs.listForSymbolRange(scope, symbol, from, to);
  return rows.map((r) => ({
    time: r.time.toISOString(),
    symbol: r.symbol,
    level: r.level,
    msg: r.msg,
    ctx: r.ctx,
  }));
};

/**
 * All `audit_logs` rows for a profile within a `[from, to]` window, shaped
 * for the NDJSON export. The route streams these line-by-line; the rows
 * are materialised here because the export has no pagination UI.
 */
export const getProfileAuditLogExport = async (
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<AuditLogExportRow[]> => {
  const rows = await auditLogs.listAllForProfile(scope, from, to);
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    actor: r.actor,
    payload: r.payload,
    ip: r.ip,
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
  }));
};
