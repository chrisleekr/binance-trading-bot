// The single mount list for every `/api` router.
//
// Production (`createApp`) and the integration-test harness (`__tests__/_helpers.ts`)
// both call this, so a router can never be reachable in one and absent from the
// other. It previously could: the harness kept its own hand-maintained copy and
// drifted behind production. `risk.ts` was missing for long enough that all five
// risk route tests 404'd on an unmatched path, while a sixth ("denies cross-account")
// passed by expecting that very 404 — a green test standing guard over an unmounted
// router. Six more routers were still missing when this was written.
//
// `/api/auth`, `/healthz`, and the WS upgrade route stay out. Auth is mounted
// alongside its login-throttle middleware, whose ordering is a production concern;
// the WS router depends on the Bun global, which Vitest does not provide under Node.

import type { DI } from '../di.js';
import type { ApiHono } from '../types.js';

import { statusRouter } from './status.js';
import { accountsRouter } from './accounts.js';
import { strategiesRouter } from './strategies.js';
import { accountSettingsRouter } from './account-settings.js';
import { aiProviderRouter } from './ai-provider.js';
import { opsNotifyRouter } from './ops-notify.js';
import { workerCronsRouter } from './worker-crons.js';
import { exchangeInfoRouter } from './exchange-info.js';
import { marketTrendRouter } from './market-trend.js';
import { backupRouter } from './backup.js';
import { technicalsHealthRouter } from './technicals-health.js';
import { retentionStatusRouter } from './retention-status.js';
import { profilesRouter } from './profiles.js';
import { apiKeysRouter } from './api-keys.js';
import { accountHealthRouter } from './account-health.js';
import { backtestsRouter } from './backtests.js';
import { archiveRouter } from './archive.js';
import { auditLogsRouter } from './audit-logs.js';
import { actionLogsRouter } from './action-logs.js';
import { symbolsRouter } from './symbols.js';
import { discoveryRouter } from './discovery.js';
import { riskRouter } from './risk.js';
import { gateStatusRouter } from './gate-status.js';
import { ordersRouter } from './orders.js';
import { manualOrdersRouter } from './manual-orders.js';
import { overrideRouter } from './override.js';
import { killSwitchRouter } from './kill-switch.js';
import { dustTransferRouter } from './dust-transfer.js';
import { orphanOrdersRouter } from './orphan-orders.js';
import { dashboardRouter } from './dashboard.js';
import { technicalsRouter } from './technicals.js';

/**
 * Account-scoped mount prefix. The Binance account is always named in the URL;
 * `scopeOf` / `accountScopeOf` read `:accountId` from here, since Hono merges a
 * mount prefix's params into the sub-router's handlers.
 */
export const ACCOUNT_BASE = '/api/accounts/:accountId';

/**
 * Mount every `/api` router onto `app`.
 *
 * `statusRouter` is public (it leaks only SHAs and timestamps, and the operator
 * reads it before a session exists). The rest compose `requireUser()` internally.
 */
export const mountApiRouters = (app: ApiHono, di: DI): void => {
  app.route('/api', statusRouter(di));

  // Operator-global routers (no Binance-account context): account CRUD, the
  // strategy registry, operator-level settings, research, and admin.
  app.route('/api', accountsRouter(di));
  app.route('/api', strategiesRouter(di));
  app.route('/api', accountSettingsRouter(di));
  app.route('/api', aiProviderRouter(di));
  app.route('/api', opsNotifyRouter(di));
  app.route('/api', workerCronsRouter(di));
  app.route('/api', exchangeInfoRouter(di));
  app.route('/api', marketTrendRouter(di));
  app.route('/api', backupRouter(di));
  app.route('/api', technicalsHealthRouter(di));
  app.route('/api', retentionStatusRouter(di));

  // Account-scoped routers, nested under `/accounts/:accountId`.
  app.route(ACCOUNT_BASE, profilesRouter(di));
  app.route(ACCOUNT_BASE, apiKeysRouter(di));
  app.route(ACCOUNT_BASE, accountHealthRouter(di));
  app.route(ACCOUNT_BASE, backtestsRouter(di));
  app.route(ACCOUNT_BASE, archiveRouter(di));
  app.route(ACCOUNT_BASE, auditLogsRouter(di));
  app.route(ACCOUNT_BASE, actionLogsRouter(di));
  app.route(ACCOUNT_BASE, symbolsRouter(di));
  app.route(ACCOUNT_BASE, discoveryRouter(di));
  app.route(ACCOUNT_BASE, riskRouter(di));
  app.route(ACCOUNT_BASE, gateStatusRouter(di));
  app.route(ACCOUNT_BASE, ordersRouter(di));
  app.route(ACCOUNT_BASE, manualOrdersRouter(di));
  app.route(ACCOUNT_BASE, overrideRouter(di));
  app.route(ACCOUNT_BASE, killSwitchRouter(di));
  app.route(ACCOUNT_BASE, dustTransferRouter(di));
  app.route(ACCOUNT_BASE, orphanOrdersRouter(di));
  app.route(ACCOUNT_BASE, dashboardRouter(di));
  app.route(ACCOUNT_BASE, technicalsRouter(di));
};
