// alive cron.
//
// Per-profile daily balance digest sent to the profile's notifiers.
// Entity fan-out producer: enumerates active profiles inline and loops
// the per-profile send. A per-profile failure stays isolated; a total
// failure (zero sends out of N attempted) throws so BullMQ retries
// rather than waiting 24h for the next tick.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { profileRepo } from '@app/db';
import { fanOutBounded } from '@app/core/fan-out';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { createAliveDigest } from './alive-digest.js';
import { isProfileEventEnabled } from 'notifiers/notify-event.js';

/**
 * Bounded I/O against notifier providers. 4 is conservative — most digests
 * post to a single Slack channel per profile, and concurrent posts share
 * one outbound socket without backpressure.
 */
const ALIVE_CONCURRENCY = 4;

export interface AliveDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /** Send one profile's daily balance digest to its notifiers. */
  readonly sendDigest: (profile: ActiveProfile) => Promise<void>;
}

export const aliveHandler =
  (deps: AliveDeps) =>
  async (_job: Job): Promise<void> => {
    const profiles = deps.listActive();
    const { ok, errors } = await fanOutBounded(profiles, (profile) => deps.sendDigest(profile), {
      concurrency: ALIVE_CONCURRENCY,
      onError: 'collect',
    });
    for (const { item, error } of errors) {
      deps.logger.warn(
        { profileId: item.profileId, err: error },
        'cron alive: digest failed for profile',
      );
    }
    // A total failure on this once-a-day cron must escalate, not just
    // warn — throw so BullMQ retries rather than waiting 24h. A partial
    // failure stays isolated (the succeeded profiles already sent).
    if (ok.length === 0 && profiles.length > 0) {
      throw new Error(`cron alive: all ${profiles.length} profile digests failed`);
    }
    deps.logger.info(
      { profiles: profiles.length, sent: ok.length, failed: errors.length },
      'cron alive: complete',
    );
  };

export const buildAliveCron = (ctx: BootContext): CronDef => {
  const sendDigest = createAliveDigest({
    logger: ctx.logger,
    resolveBinance: ctx.resolveBinanceClient,
    listNotifiers: async (operatorId, accountId, profileId) => {
      const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
      return p.profileNotifiers.listForProfile();
    },
    isEventEnabled: (operatorId, accountId, profileId) =>
      isProfileEventEnabled(ctx.db, operatorId, accountId, profileId, 'alive'),
    resolveProfileName: async (operatorId, accountId, profileId) => {
      const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
      return (await p.profile.findById())?.name ?? null;
    },
    notifyRegistry: ctx.notifyProviders,
    liveDemo: ctx.liveDemo,
  });
  return defineCron({
    name: 'alive',
    queue: QUEUE_NAMES.alive,
    pattern: '0 0 9 * * *',
    handler: aliveHandler({ logger: ctx.logger, listActive: ctx.listActive, sendDigest }),
  });
};
