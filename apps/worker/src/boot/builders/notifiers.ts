// Notifier fan-outs and the DLQ alert path.
//
// One `accountNotifyDeps` bag backs both the single- and batch-account
// notifiers so they resolve the same DB gate and registry. The DLQ watcher is
// registered here because its only job is to fold dead-lettered jobs into an
// account alert, which is the same notifier surface.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { Database } from '@app/db';

import { notifyProviders as notifyProvidersRegistry } from 'notifiers.js';
import { createNotifyEvent, type NotifyEvent } from 'notifiers/notify-event.js';
import {
  createNotifierGapThrottle,
  createOrderFailedThrottle,
  createOrderRefusalLoopThrottle,
  createProtectiveStopBlockedThrottle,
  type NotifierGapThrottle,
} from 'executor/notifier-gap-throttle.js';
import {
  createAccountNotifyEvent,
  createAccountNotifyEventBatch,
} from 'notifiers/account-notify-event.js';
import { registerDlqWorker } from 'queues/dlq-watcher.js';
import { createDlqNotifyAggregator } from 'queues/dlq-notify-aggregator.js';
import type { QueueSet } from 'queues/queue-set.js';

export interface NotifiersDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly liveDemo: boolean;
  readonly queueSet: QueueSet;
}

export interface Notifiers {
  readonly accountNotify: ReturnType<typeof createAccountNotifyEvent>;
  readonly accountNotifyBatch: ReturnType<typeof createAccountNotifyEventBatch>;
  readonly notifierGapThrottle: NotifierGapThrottle;
  readonly orderFailedThrottle: ReturnType<typeof createOrderFailedThrottle>;
  readonly orderRefusalLoopThrottle: ReturnType<typeof createOrderRefusalLoopThrottle>;
  readonly protectiveStopBlockedThrottle: ReturnType<typeof createProtectiveStopBlockedThrottle>;
  readonly notifyEvent: NotifyEvent;
}

export const buildNotifiers = ({
  db,
  redis,
  logger,
  liveDemo,
  queueSet,
}: NotifiersDeps): Notifiers => {
  // Account-level ops notifier; db + the notifier registry are available here,
  // and resolving notifiers is a db-only query (no profileManager), so the DLQ
  // watcher can alert even though it registers before the profile manager exists.
  // Under LIVE_DEMO the notifiers are total no-ops (no dispatch, DB gate unread).
  const accountNotifyDeps = {
    db,
    notifyProviders: notifyProvidersRegistry,
    logger,
    liveDemo,
  };
  const accountNotify = createAccountNotifyEvent(accountNotifyDeps);
  const accountNotifyBatch = createAccountNotifyEventBatch(accountNotifyDeps);
  // Profile-scoped operator alerts (daily-loss halt, edge-decay, order-filled).
  // Built once so the fill-adopter and the ctx surface share one notifier. The
  // gap throttle bounds the durable trace an undelivered warn/error alert
  // writes, per (profile, category), fleet-wide.
  const notifierGapThrottle = createNotifierGapThrottle({ redis, logger });
  // Its own key namespace and its own (shorter) window: the notifier-gap trace is
  // a once-an-hour visibility record, an order failure is an operator emergency.
  const orderFailedThrottle = createOrderFailedThrottle({ redis, logger });
  // The loop escalation must not be muted by the ordinary failure that precedes it.
  const orderRefusalLoopThrottle = createOrderRefusalLoopThrottle({ redis, logger });
  // A third namespace, not the order-failed one: the refused stop is never sent,
  // so it raises no placement failure, and sharing that key would let one cause
  // mute the other for the whole window.
  const protectiveStopBlockedThrottle = createProtectiveStopBlockedThrottle({ redis, logger });
  const notifyEvent = createNotifyEvent({
    db,
    notifyProviders: notifyProvidersRegistry,
    logger,
    notifierGapThrottle,
    liveDemo,
  });
  // Group DLQ alerts by ERROR CLASS and debounce a burst into one notification.
  // A systemic failure (Postgres/Redis briefly unreachable) dead-letters the
  // tick job for every (profile, symbol) at once; the old per-message throttle
  // fragmented on the ORM error's per-symbol params, so the operator got one
  // Slack message per symbol — a storm. The aggregator folds the burst into a
  // single "N jobs failed: <class>" alert, then a per-class cooldown suppresses
  // repeats. persist/publish above stay per-job (no DLQ data dropped).
  const DLQ_NOTIFY_COOLDOWN_MS = 900_000; // 15 min between alerts for the same class
  const DLQ_NOTIFY_DEBOUNCE_MS = 15_000; // collect a burst this long before the first alert
  const dlqAggregator = createDlqNotifyAggregator({
    debounceMs: DLQ_NOTIFY_DEBOUNCE_MS,
    cooldownMs: DLQ_NOTIFY_COOLDOWN_MS,
    nowMs: () => Date.now(),
    // Timers are unref'd, so a pending debounce/catch-up flush never holds the
    // process open at shutdown or across a `bun --watch` restart — the
    // aggregator needs no explicit lifecycle stop() wiring (the method exists for
    // tests and future longer-lived timers).
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as unknown as { unref?: () => void }).unref?.();
      return { clear: () => clearTimeout(t) };
    },
    emit: (group) => {
      const s = group.sample;
      const raw = s.errorName ? `${s.errorName} — ${s.errorMessage}` : s.errorMessage;
      // Trim a huge ORM error so the Slack message stays readable.
      const error = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
      const grouped = group.count > 1;
      void accountNotify({
        category: 'job-failed',
        body: grouped
          ? `${group.count} background jobs failed the same way and were dropped after their retries. They will not retry automatically.`
          : 'A background job was dropped after its retries. It will not retry automatically.',
        fields: [
          { label: 'Job', value: s.fromQueue },
          { label: 'Error', value: error },
          ...(grouped
            ? [
                { label: 'Occurrences', value: `${group.count} in the last ~15 min` },
                { label: 'Example', value: s.fromJobId },
              ]
            : [{ label: 'Job ID', value: s.fromJobId }]),
        ],
      });
    },
  });
  registerDlqWorker(queueSet, {
    redis,
    logger,
    persist: async (data) => {
      logger.warn({ fromQueue: data.fromQueue, fromJobId: data.fromJobId }, 'DLQ entry');
    },
    onEntry: dlqAggregator.record,
  });

  return {
    accountNotify,
    accountNotifyBatch,
    notifierGapThrottle,
    orderFailedThrottle,
    orderRefusalLoopThrottle,
    protectiveStopBlockedThrottle,
    notifyEvent,
  };
};
