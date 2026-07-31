// Emergency-notify helper shared by the place-order failure paths.
//
// WHY: on a real-money order failure the operator must be alerted out-of-band.
// Resolve the profile's own enabled notifiers (config + secrets) and hand them
// to the shared dispatcher, which owns the fan-out and the undelivered
// accounting. When nothing reaches the operator, record a durable warn-level
// action_log gap so they can see they were not alerted (CLAUDE.md invariant: no
// silent failures). A boot-wired throttle bounds the gap-trace volume per
// (profile, topic).

import type { ProfileId } from '@app/contracts';
import type { NotifyField } from '@app/notify';
import type { ProfileExecutorBindings } from 'executor/live-executor.js';
import { dispatchNotify } from 'notifiers/dispatch.js';
import { resolveNotifiersFromRows } from 'notifiers/lookup.js';
import type { DecisionDeps } from './_types.js';

type Severity = 'warn' | 'error';

export const emergencyNotify = async (
  deps: DecisionDeps,
  bindings: ProfileExecutorBindings,
  profileId: ProfileId,
  args: {
    severity: Severity;
    topic: string;
    title: string;
    symbol?: string;
    body: string;
    fields?: readonly NotifyField[];
  },
): Promise<void> => {
  const { severity, topic, title, symbol, body, fields } = args;

  // Best-effort and must NEVER throw into the place-order path: one call site
  // is the post-accept bookkeeping catch block whose contract is a non-retryable
  // RETURN, not a throw (a throw there would replay the BullMQ job and place a
  // duplicate live order). Swallow and log, mirroring safeNotify, so a DB blip
  // can't change the order result.
  try {
    const resolved = resolveNotifiersFromRows(await bindings.persistence.listEnabledNotifiers());
    await dispatchNotify(
      {
        registry: deps.notifyRegistry,
        logger: deps.logger,
        ...(deps.liveDemo ? { liveDemo: true } : {}),
      },
      resolved,
      {
        severity,
        topic,
        title,
        ...(symbol !== undefined ? { symbol } : {}),
        body,
        ...(fields && fields.length > 0 ? { fields } : {}),
      },
      // Nothing reached the operator — record the gap. Throttled per
      // (profile, topic) so a recurring real-money emergency on a
      // notifier-less profile emits one trace per window, fleet-wide.
      async () => {
        const allow = (await deps.notifierGapThrottle?.allow(`${profileId}:${topic}`)) ?? true;
        if (allow) {
          await bindings.persistence.recordNotifierGap({
            topic,
            ...(symbol !== undefined ? { symbol } : {}),
          });
        }
      },
    );
  } catch (err: unknown) {
    deps.logger.error({ topic, err: err }, 'emergency-notify failed');
  }
};
