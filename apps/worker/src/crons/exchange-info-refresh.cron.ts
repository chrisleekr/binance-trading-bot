// exchange-info-refresh cron.
//
// Refreshes Redis symbol-info keys from Binance's public `exchangeInfo`
// endpoint. The tick handler reads these on every tick; without this cron the
// very first tick on a fresh worker boot would DLQ. `ctx.exchangeInfoRefresh`
// refreshes BOTH the live (production) and test (testnet) keyspaces — their
// tickSize / lot filters differ, so a test-mode profile must read testnet's.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import type { ExchangeInfoRefreshJobData } from 'queues/job-payloads.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';

export interface ExchangeInfoRefreshDeps {
  readonly logger: Logger;
  readonly run: () => Promise<unknown>;
}

export const exchangeInfoRefreshHandler =
  (deps: ExchangeInfoRefreshDeps) =>
  async (_job: Job<ExchangeInfoRefreshJobData>): Promise<void> => {
    await deps.run();
  };

export const buildExchangeInfoRefreshCron = (ctx: BootContext): CronDef =>
  defineCron({
    name: 'exchange-info-refresh',
    queue: QUEUE_NAMES.exchangeInfoRefresh,
    pattern: '0 */5 * * * *',
    handler: exchangeInfoRefreshHandler({ logger: ctx.logger, run: ctx.exchangeInfoRefresh }),
  });
