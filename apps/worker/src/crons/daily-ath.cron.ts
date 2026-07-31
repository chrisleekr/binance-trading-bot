// daily-ath cron.
//
// Once-daily REST refresh of `ath:<symbol>` keys, for the case where the
// live 1d-close path missed an update. Distinct symbols across every
// active profile — a symbol shared by two profiles is refreshed once.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { createDailyAthRefresh } from './daily-ath.js';

/**
 * REST `klines` is a flat weight 2; 4 concurrent calls fit well inside
 * Binance's per-IP budget at the once-daily cron cadence.
 */
const DAILY_ATH_CONCURRENCY = 4;

export interface DailyAthDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  readonly refreshAth: (symbol: string) => Promise<void>;
}

export const dailyAthHandler =
  (deps: DailyAthDeps) =>
  async (_job: Job): Promise<void> => {
    const symbols = [...new Set(deps.listActive().flatMap((p) => p.symbols))];
    const { ok, errors } = await fanOutBounded(symbols, (symbol) => deps.refreshAth(symbol), {
      concurrency: DAILY_ATH_CONCURRENCY,
      onError: 'collect',
    });
    for (const { item, error } of errors) {
      deps.logger.warn({ symbol: item, err: error }, 'cron daily-ath: symbol refresh failed');
    }
    // A total failure on this once-a-day cron must escalate — throw so
    // BullMQ retries rather than leaving the ATH stale for 24h. A
    // partial failure stays isolated.
    if (ok.length === 0 && symbols.length > 0) {
      throw new Error(`cron daily-ath: all ${symbols.length} symbol refreshes failed`);
    }
    deps.logger.info(
      { symbols: symbols.length, ok: ok.length, failed: errors.length },
      'cron daily-ath: complete',
    );
  };

export const buildDailyAthCron = (ctx: BootContext): CronDef => {
  const refreshAth = createDailyAthRefresh({ redis: ctx.redis, logger: ctx.logger });
  return defineCron({
    name: 'daily-ath',
    queue: QUEUE_NAMES.dailyAth,
    pattern: '0 0 0 * * *',
    handler: dailyAthHandler({ logger: ctx.logger, listActive: ctx.listActive, refreshAth }),
  });
};
