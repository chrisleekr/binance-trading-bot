// Profile-event notification helper: the fan-out entry point for the worker's
// profile-scoped operator alerts (daily-loss halt, edge-decay warning, and the
// existing discovery / alive paths via the gate below).
//
// It reads the profile's `notify_events` subscription map, drops the event when
// the operator has muted that category (default: every category on), resolves
// the profile's enabled notifiers, and hands them to the shared dispatcher.
// Notify must never fail the caller (mirrors the tick-path contract).
//
// When a warn/error alert reaches nobody, a durable action_log gap is recorded,
// matching the emergency path. Informational categories settle for the
// dispatcher's warn log: one durable row per muted digest would bury the traces
// that matter.

import type { Logger } from 'pino';
import type { NotifyProviderRegistry, NotifyMessage, NotifyField } from '@app/notify';
import {
  ProfileNotifyEvents,
  notifyEventMeta,
  type AccountId,
  type ProfileNotifyEventCategory,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { profileRepo, type Database } from '@app/db';
import { resolveNotifiersFromRows } from './lookup.js';
import { dispatchNotify } from './dispatch.js';
import type { NotifierGapThrottle } from 'executor/notifier-gap-throttle.js';

export interface NotifyEventDeps {
  readonly db: Database;
  readonly notifyProviders: NotifyProviderRegistry;
  readonly logger: Logger;
  /**
   * Bounds the durable gap-trace volume per (profile, category). Omit and every
   * undelivered warn/error alert writes a row.
   */
  readonly notifierGapThrottle?: NotifierGapThrottle;
  /**
   * Public "Live demo" mode. When true the notifier is a total no-op: it never
   * reads the profile from the DB and never dispatches, so a seed snapshot's
   * real webhooks can never leak from the demo box.
   */
  readonly liveDemo?: boolean;
}

export interface NotifyEventInput {
  readonly category: ProfileNotifyEventCategory;
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  /** The human sentence: what happened, what it means, what to do. */
  readonly body: string;
  /** The symbol the event concerns, when it concerns exactly one. */
  readonly symbol?: string;
  /** Display-ready detail lines; the caller formats values (it owns the Decimals). */
  readonly fields?: readonly NotifyField[];
  /** Absolute tap-through URL, when a public base URL is configured. */
  readonly link?: string;
}

/** Parse a stored `notify_events` column, falling back to the all-on defaults. */
const parseEvents = (raw: unknown): ProfileNotifyEvents => {
  const parsed = ProfileNotifyEvents.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ProfileNotifyEvents.parse({});
};

/**
 * Whether a profile is subscribed to a category. Used by the discovery / alive
 * paths to gate their existing sends without rerouting their payloads through
 * the fan-out below (those events already format their own structured payload).
 * A missing profile reads as "not subscribed" so a deleted profile goes quiet.
 */
export const isProfileEventEnabled = async (
  db: Database,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
  category: ProfileNotifyEventCategory,
): Promise<boolean> => {
  const repo = await profileRepo(db, operatorId, accountId, profileId);
  const row = await repo.profile.findById();
  if (!row) return false;
  return parseEvents((row as { notifyEvents?: unknown }).notifyEvents)[category];
};

/**
 * Build the profile-event notifier. The returned function fires one event:
 * gate on the subscription, resolve the profile's notifiers, fan out. It never
 * throws — a resolve or send failure is logged, not propagated.
 */
export const createNotifyEvent = (
  deps: NotifyEventDeps,
): ((input: NotifyEventInput) => Promise<void>) => {
  // Live demo: suppress every dispatch, before any DB read. Same signature as
  // the live path so the returned NotifyEvent type does not fork.
  if (deps.liveDemo) return async (_input: NotifyEventInput): Promise<void> => undefined;
  return async (input: NotifyEventInput): Promise<void> => {
    const meta = notifyEventMeta(input.category);
    if (!meta) return;
    try {
      const repo = await profileRepo(deps.db, input.operatorId, input.accountId, input.profileId);
      const row = await repo.profile.findById();
      if (!row) return;
      if (!parseEvents((row as { notifyEvents?: unknown }).notifyEvents)[input.category]) return;

      const resolved = resolveNotifiersFromRows(await repo.profileNotifiers.listForProfile());

      const message: NotifyMessage = {
        severity: meta.severity,
        topic: input.category,
        title: meta.label,
        profile: row.name,
        ...(input.symbol ? { symbol: input.symbol } : {}),
        body: input.body,
        ...(input.fields && input.fields.length > 0 ? { fields: input.fields } : {}),
        ...(input.link ? { link: input.link } : {}),
      };

      const recordGap = async (): Promise<void> => {
        const allow =
          (await deps.notifierGapThrottle?.allow(`${input.profileId}:${input.category}`)) ?? true;
        if (!allow) return;
        await repo.actionLogs.append({
          time: new Date(),
          symbol: input.symbol ?? null,
          level: 'warn',
          msg: `${meta.label} fired but this profile has no reachable notifier — you were not alerted`,
          ctx: { topic: input.category },
        });
      };

      // An undelivered `info` digest is not worth a durable row; an undelivered
      // halt or edge-decay warning is exactly what the operator needs to see.
      const durable = meta.severity !== 'info';
      await dispatchNotify(
        {
          registry: deps.notifyProviders,
          logger: deps.logger,
          ...(deps.liveDemo ? { liveDemo: true } : {}),
        },
        resolved,
        message,
        durable ? recordGap : undefined,
      );
    } catch (err: unknown) {
      deps.logger.error(
        { category: input.category, profileId: input.profileId, err },
        'notify-event: fan-out failed',
      );
    }
  };
};

/** The fan-out function shape, for wiring into cron deps. */
export type NotifyEvent = ReturnType<typeof createNotifyEvent>;
