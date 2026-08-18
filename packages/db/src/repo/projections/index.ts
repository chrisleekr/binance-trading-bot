/**
 * Read-projection layer. Each function composes a fully-shaped response
 * payload from Postgres + Redis so API route handlers stay thin: declare
 * the OpenAPI route, resolve a `ProfileScope`, call a projection, return
 * it. Payloads are `@app/contracts` DTOs, except the NDJSON audit export
 * (`getProfileAuditLogExport`), which has no Zod contract and returns the
 * projection-owned `AuditLogExportRow`. Projections never import HTTP
 * types — the dependency runs routes -> projections, never the reverse.
 */
export type { ProjectionRedis } from './redis-port.js';
export {
  getProfileDashboard,
  invalidateProfileDashboard,
  PROFILE_DASHBOARD_TTL_S,
} from './profile-dashboard.js';
export {
  getAggregateForAccount,
  invalidateDashboardCaches,
  rollupRealizedByProfileForAccount,
  type RealizedByProfile,
} from './profile-aggregate.js';
export { countOpenExposure } from './profile-exposure.js';
export { countAccountOpenExposure } from './account-exposure.js';
export { getClosedTradesForPeriod } from './closed-trades.js';
export {
  getSymbolState,
  getSymbolOrderHistory,
  getSymbolArchive,
  readEntryBlocker,
  readProtectiveStopBlocker,
} from './orders-view.js';
export { getSymbolLogs, getProfileAuditLogExport, type AuditLogExportRow } from './logs.js';
export { getDiscoveryFunnelView, toDiagnosisSnapshots } from './diagnosis-view.js';
