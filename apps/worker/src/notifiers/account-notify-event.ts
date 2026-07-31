// Account-scoped ops notification helper: the fan-out chokepoint for events that
// belong to a whole account, not one profile (a dead-lettered background job, an
// untracked order on the exchange).
//
// It reads the singleton ops_notify_config, drops the event when the operator has
// muted that category (default: on), resolves the notifiers to fan out to, and
// hands them to the shared dispatcher. Never throws (mirrors the tick-path
// contract).
//
// An event may name the ACCOUNT it concerns. An untracked order sits on exactly
// one order book, owned by exactly one key pair, so it must reach that account's
// channels and no others — a second account's Slack learning about the first's
// orders is precisely the cross-account bleed the isolation model exists to
// prevent. Narrowing by Binance environment instead would still bleed between two
// accounts on the same env; the account is the real axis, and it subsumes the
// environment (an account has exactly one). With no account named (a worker-wide
// failure concerns every account), the resolve is the union of everything enabled.
//
// The caller gets an outcome rather than void, because "the operator did not see
// this" is three situations with three different correct responses: muted (they
// chose silence — do not retry, do not trace), no-notifier (a real gap — the
// caller records a durable trace), failed (every transport errored — the caller
// retries). Collapsing them either spams the operator or silently drops the only
// warning they had. The trace itself stays with the caller: `action_logs` rows are
// profile-scoped, and only the caller knows which profile (if any) owns the event.
//
// The batch entry point exists for callers that raise MANY events of one category
// for one account in a single pass (the orphan detector). The subscription gate
// and the notifier resolve are the same answer for all of them, so they are read
// ONCE; only the sends repeat — and they stay serialized, deliberately, to be
// gentle on Slack/Telegram rate limits.

import type { Logger } from 'pino';
import type { NotifyProviderRegistry, NotifyMessage, NotifyField } from '@app/notify';
import {
  OpsNotifyConfig,
  accountNotifyEventMeta,
  type AccountId,
  type AccountNotifyEventCategory,
} from '@app/contracts';
import { repo, type Database } from '@app/db';
import { resolveNotifiersFromRows, type NotifierRowInput } from './lookup.js';
import { dispatchNotify } from './dispatch.js';

export interface AccountNotifyEventDeps {
  readonly db: Database;
  readonly notifyProviders: NotifyProviderRegistry;
  readonly logger: Logger;
  /**
   * Public "Live demo" mode. When true the batch notifier is a total no-op: it
   * never reads the ops config from the DB and never dispatches, so a seed
   * snapshot's real webhooks can never leak from the demo box.
   */
  readonly liveDemo?: boolean;
}

/** One message's payload: what happened, on what, with what detail and tap-through. */
export interface AccountNotifyMessageInput {
  /** The human sentence: what happened, what it means, what to do. */
  readonly body: string;
  /** The symbol the event concerns, when it concerns exactly one. */
  readonly symbol?: string;
  /** Display-ready detail lines; the caller formats values (it owns the Decimals). */
  readonly fields?: readonly NotifyField[];
  /** Absolute tap-through URL, when a public base URL is configured. */
  readonly link?: string;
}

export interface AccountNotifyEventInput extends AccountNotifyMessageInput {
  readonly category: AccountNotifyEventCategory;
  /** Narrows the notifier resolve to one account's channels. Omit for worker-wide events. */
  readonly accountId?: AccountId;
}

/** Many messages of one category for one account, gated and resolved once. */
export interface AccountNotifyBatchInput {
  readonly category: AccountNotifyEventCategory;
  readonly accountId?: AccountId;
  readonly events: readonly AccountNotifyMessageInput[];
}

/**
 * What happened to one account event. `muted` is a success (the operator asked
 * for silence); `no-notifier` is a gap the caller should record durably; `failed`
 * means every configured transport errored and the caller should retry.
 */
export type AccountNotifyOutcome = 'delivered' | 'muted' | 'no-notifier' | 'failed';

/** Parse the stored ops config, falling back to the all-on defaults. */
const parseOps = (raw: unknown): OpsNotifyConfig => {
  const parsed = OpsNotifyConfig.safeParse(raw ?? {});
  return parsed.success ? parsed.data : OpsNotifyConfig.parse({});
};

/** Whether the account is subscribed to a given ops category (defaults to on). */
export const isAccountEventEnabled = async (
  db: Database,
  category: AccountNotifyEventCategory,
): Promise<boolean> => parseOps((await repo.opsNotifyConfig.get(db)).events)[category];

/**
 * The notifiers an event fans out to, deduped by transport. Dedup runs WITHIN the
 * resolved set only: the same webhook configured on two accounts is two distinct
 * subscriptions, each resolved by its own call, so one account's event can never
 * suppress the other's.
 */
const resolveAccountNotifiers = async (db: Database, accountId: AccountId | undefined) => {
  const enabled = accountId
    ? await repo.profileNotifiers.listEnabledForAccount(db, accountId)
    : await repo.profileNotifiers.listAllEnabled(db);
  const seen = new Set<string>();
  const rows: NotifierRowInput[] = [];
  for (const row of enabled) {
    const key = `${row.provider}|${JSON.stringify(row.config)}|${JSON.stringify(row.secrets)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return resolveNotifiersFromRows(rows);
};

/**
 * Build the batch account-event notifier: gate on the subscription ONCE, resolve
 * the account's notifiers ONCE, then send each message in turn. Returns one
 * outcome per input event, in order. Never throws — a failure is logged and every
 * event of the batch reports `failed`.
 */
export const createAccountNotifyEventBatch = (deps: AccountNotifyEventDeps) => {
  return async (input: AccountNotifyBatchInput): Promise<readonly AccountNotifyOutcome[]> => {
    const same = (outcome: AccountNotifyOutcome): AccountNotifyOutcome[] =>
      input.events.map(() => outcome);
    // Live demo: suppress every dispatch, before any DB read. Reported as muted
    // (a success — the demo asked for silence), never retried.
    if (deps.liveDemo) return same('muted');
    const meta = accountNotifyEventMeta(input.category);
    // An unknown category cannot be labelled or gated, so it is unsendable.
    // Reported as muted rather than failed: a retry would never succeed.
    if (!meta) return same('muted');
    if (input.events.length === 0) return [];
    try {
      if (!(await isAccountEventEnabled(deps.db, input.category))) return same('muted');

      const resolved = await resolveAccountNotifiers(deps.db, input.accountId);
      // Checked BEFORE dispatch: the dispatcher folds "nobody configured" and
      // "everybody errored" into one undelivered count, but only the second is
      // worth retrying.
      if (resolved.length === 0) return same('no-notifier');

      const outcomes: AccountNotifyOutcome[] = [];
      for (const event of input.events) {
        const message: NotifyMessage = {
          severity: meta.severity,
          topic: input.category,
          title: meta.label,
          ...(event.symbol ? { symbol: event.symbol } : {}),
          body: event.body,
          ...(event.fields && event.fields.length > 0 ? { fields: event.fields } : {}),
          ...(event.link ? { link: event.link } : {}),
        };
        const delivered = await dispatchNotify(
          {
            registry: deps.notifyProviders,
            logger: deps.logger,
            ...(deps.liveDemo ? { liveDemo: true } : {}),
          },
          resolved,
          message,
        );
        outcomes.push(delivered > 0 ? 'delivered' : 'failed');
      }
      return outcomes;
    } catch (err: unknown) {
      deps.logger.error(
        { category: input.category, accountId: input.accountId, err },
        'account-notify-event: fan-out failed',
      );
      return same('failed');
    }
  };
};

/** Single-event convenience over the batch: one message, one outcome. */
export const createAccountNotifyEvent = (deps: AccountNotifyEventDeps) => {
  const batch = createAccountNotifyEventBatch(deps);
  return async (input: AccountNotifyEventInput): Promise<AccountNotifyOutcome> => {
    const { category, accountId, ...event } = input;
    const [outcome] = await batch({
      category,
      ...(accountId ? { accountId } : {}),
      events: [event],
    });
    return outcome ?? 'failed';
  };
};

/** The fan-out function shape, for wiring into cron deps. */
export type AccountNotifyEventBatch = ReturnType<typeof createAccountNotifyEventBatch>;
