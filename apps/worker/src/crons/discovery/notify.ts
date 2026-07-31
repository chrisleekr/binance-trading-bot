// Provider-agnostic discovery rotation notifications.
//
// Fans an add/remove/re-add line out to every enabled notifier for the profile,
// mirroring the alive-digest path: a missing provider or a send failure is
// swallowed so a notifier never churns or aborts the cycle.

import type { NotifyMessage, NotifyProviderRegistry } from '@app/notify';
import type { Logger } from 'pino';
import { resolveNotifiersFromRows } from 'notifiers/lookup.js';
import { dispatchNotify } from 'notifiers/dispatch.js';

/** Resolved-notifier list shape (provider name + merged config). */
export type ResolvedNotifiers = ReturnType<typeof resolveNotifiersFromRows>;

/** How discovery changed a symbol's membership; drives the notification wording. */
export type DiscoveryNotifyAction = 'added' | 're-added' | 'removed';

/** Build the operator-facing discovery message for one symbol rotation. */
export const discoveryMessage = (
  action: DiscoveryNotifyAction,
  symbol: string,
  profile: string,
): NotifyMessage => ({
  severity: 'info',
  topic: 'discovery',
  title: `Discovery: symbol ${action}`,
  profile,
  symbol,
  body:
    action === 'removed'
      ? `Auto-discovery stopped trading ${symbol}.`
      : `Auto-discovery ${action === 're-added' ? 'resumed' : 'started'} trading ${symbol}.`,
});

export const notifyDiscovery = async (
  providers: NotifyProviderRegistry,
  resolved: ResolvedNotifiers,
  message: NotifyMessage,
  logger: Logger,
  liveDemo?: boolean,
): Promise<void> => {
  // Informational: an undelivered rotation notice gets the dispatcher's warn
  // log, not a durable action_log row.
  await dispatchNotify(
    { registry: providers, logger, ...(liveDemo ? { liveDemo } : {}) },
    resolved,
    message,
  );
};
