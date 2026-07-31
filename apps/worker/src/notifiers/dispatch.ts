// The single fan-out chokepoint: given already-resolved notifiers and a built
// message, deliver it and account for the case where nothing reached the
// operator.
//
// WHY this module exists: the fan-out loop (registry lookup + safeNotify) was
// reimplemented at every notify site, and each one decided independently what
// "nobody was alerted" meant. Only the emergency path recorded it; the rest
// returned quietly. CLAUDE.md's "no silent failures" is a property of the
// dispatch, not of one call site, so the accounting lives here with the loop it
// describes.
//
// Undelivered means `delivered === 0`: either no notifier resolved, or every
// resolved one named a provider absent from the registry, or every send failed.
// All three leave the operator uninformed and are indistinguishable to them.

import type { Logger } from 'pino';
import type { NotifyMessage, NotifyProviderRegistry } from '@app/notify';
import { safeNotify } from 'executor/safe-notify.js';
import type { ResolvedNotifier } from './lookup.js';

export interface DispatchDeps {
  readonly registry: NotifyProviderRegistry;
  readonly logger: Logger;
  /**
   * Public "Live demo" mode. The single dispatch chokepoint: when true this
   * function is a total no-op (no provider send, no undelivered trace), so every
   * caller — the factories AND the direct callers (emergency-notify, profile
   * disposal, the alive + discovery crons) — is suppressed regardless of whether
   * it routes through a demo-gated factory. A seed snapshot's real webhooks can
   * never leak from a demo box.
   */
  readonly liveDemo?: boolean;
}

/**
 * Fan `message` out to every resolved notifier and return how many actually
 * delivered. Never throws: `safeNotify` swallows each provider failure so one
 * broken webhook cannot mask the others, and `onUndelivered` is guarded too.
 *
 * `onUndelivered` records the durable operator-visible trace when nothing was
 * delivered. Callers with a profile to attach the trace to (an `action_logs`
 * row) supply it; account-scoped and informational callers omit it and rely on
 * the warn log below. Delivery is counted from `safeNotify`'s own result, so a
 * profile whose only provider throws is treated as un-alerted, which it is.
 */
export const dispatchNotify = async (
  deps: DispatchDeps,
  resolved: readonly ResolvedNotifier[],
  message: NotifyMessage,
  onUndelivered?: () => Promise<void>,
): Promise<number> => {
  // Live-demo chokepoint: suppress before any provider send or undelivered
  // trace, so suppression is total no matter which caller reached here.
  if (deps.liveDemo) return 0;
  let delivered = 0;
  for (const n of resolved) {
    const provider = deps.registry.get(n.providerName);
    if (!provider) continue;
    if (await safeNotify(provider, message, n.config, deps.logger)) delivered++;
  }
  if (delivered > 0) return delivered;

  deps.logger.warn(
    { topic: message.topic, severity: message.severity, resolved: resolved.length },
    'notify: nothing delivered — the operator was not alerted',
  );
  if (onUndelivered) {
    try {
      await onUndelivered();
    } catch (err: unknown) {
      // The trace is best-effort: a DB blip must not turn an undelivered
      // notification into a thrown error on the caller's path (the emergency
      // caller is a post-accept catch block that must not throw).
      deps.logger.error({ topic: message.topic, err: err }, 'notify: undelivered trace failed');
    }
  }
  return 0;
};
