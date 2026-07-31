// The operator-visible half of the account-event idle watchdog.
//
// The pool's watchdog reconnects and resyncs on its own; the operator sees none
// of that. This writes the durable `action_logs` row that tells them their stream
// went quiet and the bot went to check — the whole point of the feature is to
// BREAK a silence, so a failure here silently defeats it.
//
// Throttled per (profile, topic): the watchdog re-fires every sweep for as long
// as the account stays idle, and an idle account is the NORMAL state for a
// profile holding a position through a quiet market. Without the window one quiet
// weekend would bury the feed.

import type { Logger } from 'pino';
import { profileRepo, type Database } from '@app/db';
import type { AccountId, ProfileId, UserId } from '@app/contracts';

import type { NotifierGapThrottle } from 'executor/notifier-gap-throttle.js';

export interface StreamSilenceTraceDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly notifierGapThrottle: NotifierGapThrottle;
}

export interface StreamSilenceHandlerDeps extends StreamSilenceTraceDeps {
  /** Resolves the profile's current symbol set; empty when it is no longer active. */
  readonly symbolsOf: (profileId: ProfileId) => readonly string[];
  readonly enqueueSymbolReconcile: (input: {
    accountId: AccountId;
    profileId: ProfileId;
    symbol: string;
    cause: 'stream-silent';
  }) => Promise<void>;
}

/**
 * Durable operator-visible trace for a user-data stream that answered its
 * heartbeats but delivered no account event for a long window.
 *
 * The wording is load-bearing. Silence is not a fault — Binance emits an account
 * event only when a balance changes — so calling this "the stream is broken"
 * would train the operator to ignore a row that, on the day it matters, is the
 * only warning that a fill went missing. It says what actually happened: quiet
 * stream, reconnected to check.
 *
 * Best-effort: resolves even when the trace cannot be written. The caller is the
 * watchdog's own callback, and the reconnect + reconcile it goes on to do is the
 * part that protects money. Losing the visibility row must not abort them.
 */
export const recordStreamSilence = async (
  deps: StreamSilenceTraceDeps,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
  ageMs: number,
): Promise<void> => {
  const minutes = Math.round(ageMs / 60_000);
  deps.logger.warn(
    { operatorId, accountId, profileId, ageMs },
    'user-stream: no account event for the idle window; reconnected and scheduled a reconcile',
  );
  try {
    if (!(await deps.notifierGapThrottle.allow(`${profileId}:stream-silent`))) return;
    const scoped = await profileRepo(deps.db, operatorId, accountId, profileId);
    await scoped.actionLogs.append({
      time: new Date(),
      symbol: null,
      level: 'warn',
      msg: `No account activity on this profile's Binance stream for ${minutes} minutes — reconnecting to verify it is still live.`,
      ctx: { topic: 'stream-silent', ageMs },
    });
  } catch (err) {
    deps.logger.warn({ profileId, err: err }, 'user-stream: stream-silence trace failed');
  }
};

/**
 * The pool's `onStreamSilent` callback: trace the silence for the operator, then
 * converge every symbol on the profile.
 *
 * The stream answered its pings but delivered no account event for the idle
 * window, which is exactly the shape of a silently half-dead stream — so a fill
 * may have been missed on ANY of the profile's symbols, not a knowable one. Fan
 * out one reconcile per symbol and let each converge pass decide there was
 * nothing to do.
 *
 * A failed enqueue is logged, not thrown: the pool has already reconnected, and
 * the 15-minute backstop cron converges anything dropped here.
 */
export const createStreamSilenceHandler =
  (deps: StreamSilenceHandlerDeps) =>
  async (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    ageMs: number,
  ): Promise<void> => {
    await recordStreamSilence(deps, operatorId, accountId, profileId, ageMs);
    for (const symbol of deps.symbolsOf(profileId)) {
      await deps
        .enqueueSymbolReconcile({ accountId, profileId, symbol, cause: 'stream-silent' })
        .catch((err: unknown) => {
          deps.logger.error(
            { profileId, symbol, err: err },
            'user-stream: could not enqueue the post-silence reconcile',
          );
        });
    }
  };
