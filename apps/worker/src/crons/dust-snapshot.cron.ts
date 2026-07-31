// dust-snapshot cron.
//
// Per active profile: runs any operator-queued dust transfers, then
// refreshes the `dust-eligible` Redis key from Binance's `dust-btc` set.
// SAPI dust endpoints are live-only, so a test-mode profile fails per
// tick — caught and logged, never aborting the batch.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BinanceMode, BinanceRestClient, DustBtcDto } from '@app/binance';
import {
  OVERRIDE_CLAIM_STALE_MS,
  OVERRIDE_OUTCOME_WINDOW_MS,
  type AccountId,
  type DecimalString,
  type DustSnapshot,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { accountRepo, profileRepo, type ReapExpiredResult } from '@app/db';
import type { BootContext } from 'boot/boot-context.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { createDustSnapshotStore } from './dust-snapshot.js';

export interface ResolvedDustBinance {
  readonly rest: BinanceRestClient;
  readonly mode: BinanceMode;
}

export interface DustSnapshotDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  /**
   * Resolves the per-profile REST client AND the Binance mode. Mode is
   * load-bearing here because the SAPI dust endpoints are live-only —
   * calling them on a test-mode profile returns non-JSON and lights up
   * the `Failed to parse JSON` warn on every 5-minute tick.
   */
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<ResolvedDustBinance | null>;
  readonly persistDust: (
    accountId: AccountId,
    profileId: ProfileId,
    snapshot: DustSnapshot,
  ) => Promise<void>;
  /** Pending operator-queued dust transfers for the profile (override actions not yet consumed). */
  readonly listPendingDustTransfers: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
  ) => Promise<readonly { id: string; assets: readonly string[] }[]>;
  /**
   * CAS claim pending->processing; `false` when already claimed or consumed. `at` is
   * the stamp written into `processing_at`, and the caller keeps it so its
   * {@link DustSnapshotDeps.releaseClaim} can be fenced on it.
   */
  readonly claimAction: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    id: string,
    at: Date,
  ) => Promise<boolean>;
  /**
   * Finalise a claimed action processing->consumed after the side-effect
   * succeeded, storing the conversion `result` as durable history. Resolves
   * `false` when the row was no longer `processing`.
   */
  readonly finalize: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    id: string,
    result: unknown,
  ) => Promise<boolean>;
  /**
   * Notify the operator that dust was converted to BNB — a money-path action,
   * so it always surfaces. Best-effort: never throws. Optional so unit tests
   * can omit it.
   */
  readonly notifyDustConversion?: (input: {
    readonly converted: readonly string[];
    readonly requested: number;
    readonly bnbReceived: string;
    readonly partial: boolean;
  }) => Promise<void>;
  /**
   * Release a claim processing->pending so the next tick retries after a failed
   * side-effect. Fenced on `at`: it clears only the claim made with that stamp, so a
   * release that outlives its own attempt cannot strip a later holder's claim.
   */
  readonly releaseClaim: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    id: string,
    at: Date,
  ) => Promise<void>;
  /** Reset `processing` rows claimed before `staleBefore` back to pending; returns the count. */
  readonly reapStaleProcessing: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    staleBefore: Date,
  ) => Promise<number>;
  /**
   * Settle symbol overrides still pending long after their Redis key expired, for
   * every named profile of one account. Rides this sweep because it already walks
   * every active profile on a 5-minute beat — a stranded row is not urgent enough
   * to earn a cron of its own. Splits its result by branch: rows nothing ever ran
   * are a count, rows a tick took and never came back are returned individually
   * because each one needs an operator told which symbol to go look at.
   */
  readonly reapExpiredOverrides: (
    operatorId: UserId,
    accountId: AccountId,
    profileIds: readonly ProfileId[],
    staleBefore: Date,
  ) => Promise<ReapExpiredResult>;
  /**
   * Tell the operator an override may have executed without the bot noticing. The
   * one outcome nothing automated can resolve: the tick that owned it died, so the
   * exchange is the only source of truth. Optional / no-op when unwired, same
   * pattern as {@link DustSnapshotDeps.notifyDustConversion}.
   */
  readonly notifyOverrideUnresolved?: (input: {
    readonly operatorId: UserId;
    readonly accountId: AccountId;
    readonly profileId: ProfileId;
    readonly symbol: string;
    readonly overrideActionId: string;
  }) => Promise<void>;
  readonly clock?: { nowMs(): number };
  /** A claim older than this is treated as abandoned by a dead worker. Default 10 min. */
  readonly staleProcessingMs?: number;
}

/**
 * Default stale-claim horizon, two missed 5-min dust-snapshot ticks. Shared with
 * the cancel route so the API can never declare a claim dead while this reaper
 * still considers it live.
 */
const DEFAULT_STALE_PROCESSING_MS = OVERRIDE_CLAIM_STALE_MS;

/** One account's active profiles, as the account-wide override sweep consumes them. */
interface AccountGroup {
  readonly operatorId: UserId;
  readonly accountId: AccountId;
  readonly profileIds: ProfileId[];
}

/**
 * Bucket the active profiles by their owning account. The stranded-override
 * sweep is one statement per ACCOUNT (its repo function is account-scoped, and
 * ownership is proven once per account), so it needs the profiles grouped, not
 * walked.
 */
const groupByAccount = (profiles: readonly ActiveProfile[]): Map<AccountId, AccountGroup> => {
  const groups = new Map<AccountId, AccountGroup>();
  for (const p of profiles) {
    const existing = groups.get(p.accountId);
    if (existing) existing.profileIds.push(p.profileId);
    else
      groups.set(p.accountId, {
        operatorId: p.operatorId,
        accountId: p.accountId,
        profileIds: [p.profileId],
      });
  }
  return groups;
};

/**
 * Maps Binance's `dust-btc` payload to the cached {@link DustSnapshot}.
 * `dust-btc` only ever returns assets Binance currently allows converting,
 * so every row is `canDustTransfer: true`; `toBTC` is the BTC valuation and
 * `locked` is `0` because dust conversion acts on free balance only.
 */
export const mapDustSnapshot = (dust: DustBtcDto, nowMs: number): DustSnapshot => ({
  assets: dust.details.map((d) => ({
    asset: d.asset,
    free: d.amountFree as DecimalString,
    locked: '0' as DecimalString,
    estimatedBTC: d.toBTC as DecimalString,
    canDustTransfer: true,
  })),
  fetchedAt: new Date(nowMs).toISOString(),
});

export const dustSnapshotHandler =
  (deps: DustSnapshotDeps) =>
  async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    const staleMs = deps.staleProcessingMs ?? DEFAULT_STALE_PROCESSING_MS;
    let refreshed = 0;
    let converted = 0;
    let failed = 0;
    const active = deps.listActive();

    // One statement per account, ahead of the per-profile loop and its test-mode
    // skip: an operator override is armed in test mode too, so a stranded row
    // there would sit "pending" on the symbol page forever.
    // Hoisted out of the loop because a per-profile reap is two Postgres
    // round-trips per profile every five minutes to almost always settle nothing.
    // Isolated from the loop's failures: a stranded-row sweep that throws must
    // not cost the operator their dust snapshot.
    for (const [, group] of groupByAccount(active)) {
      try {
        const { expired, unresolved } = await deps.reapExpiredOverrides(
          group.operatorId,
          group.accountId,
          group.profileIds,
          new Date(clock.nowMs() - OVERRIDE_OUTCOME_WINDOW_MS),
        );
        if (expired > 0) {
          deps.logger.warn(
            { accountId: group.accountId, expired },
            'cron dust-snapshot: settled overrides whose window closed with no recorded outcome',
          );
        }
        // The other branch is the one that costs money: a tick took these overrides
        // and never came back, so an order may be resting on the exchange right now,
        // and the operator has no reason to open a symbol page for an action they
        // believe already settled.
        //
        // Logged per row and UNCONDITIONALLY, before any notify. The notification is
        // the only surface that reaches the operator, but it is optional here and the
        // category is operator-mutable, so leaning on it alone would let a possibly-live
        // order pass with no trace anywhere: the row is outside the override read
        // window, and a muted category returns before recording anything.
        const notifyUnresolved = deps.notifyOverrideUnresolved;
        for (const row of unresolved) {
          deps.logger.warn(
            {
              accountId: group.accountId,
              profileId: row.profileId,
              symbol: row.symbol,
              overrideActionId: row.id,
            },
            'cron dust-snapshot: settled an override a tick consumed but never resolved — an order may be live on the exchange',
          );
          if (!notifyUnresolved) continue;
          // Per row, and per row isolated: one symbol whose notify blows up must not
          // swallow its siblings' alerts. The wired notifier already swallows its own
          // faults, so this is the cron refusing to DEPEND on that, not a live bug.
          try {
            await notifyUnresolved({
              operatorId: group.operatorId,
              accountId: group.accountId,
              profileId: row.profileId,
              symbol: row.symbol,
              overrideActionId: row.id,
            });
          } catch (err) {
            deps.logger.warn(
              {
                accountId: group.accountId,
                symbol: row.symbol,
                overrideActionId: row.id,
                err: err,
              },
              'cron dust-snapshot: could not notify the operator of an unresolved override',
            );
          }
        }
      } catch (err) {
        deps.logger.warn(
          { accountId: group.accountId, err: err },
          'cron dust-snapshot: stranded-override sweep failed (will retry next tick)',
        );
      }
    }

    for (const profile of active) {
      try {
        // ABOVE BOTH gates below, deliberately: credential resolution and the live-only
        // check. This reaper is no longer just the dust flow's: the tick claims
        // trade-override rows too, and those are armed on testnet exactly as they are on
        // live. It is pure Postgres and needs no REST client, so behind either gate a
        // worker that died holding an override claim would leave a row no cancel can
        // delete and no tick can claim, with nothing to ever clear it, including for a
        // profile whose Binance client cannot be built at all.
        const reaped = await deps.reapStaleProcessing(
          profile.operatorId,
          profile.accountId,
          profile.profileId,
          new Date(clock.nowMs() - staleMs),
        );
        if (reaped > 0) {
          deps.logger.warn(
            { profileId: profile.profileId, reaped },
            'cron dust-snapshot: reset stale override_actions claims',
          );
        }
        const resolved = await deps.resolveBinance(profile.operatorId, profile.accountId);
        if (!resolved) continue;
        const { rest, mode } = resolved;
        // SAPI `/asset/dust-btc` and `/asset/dust` are live-only — on the
        // Spot testnet the same URL returns an HTML error page that fails
        // JSON.parse and trips the warn on every 5-minute tick. Skip the
        // dust path entirely for test-mode profiles with a single
        // info-level line per tick rather than a recurring warn.
        if (mode !== 'live') {
          deps.logger.info(
            { profileId: profile.profileId },
            'cron dust-snapshot: SAPI dust endpoints are live-only; skipping test-mode profile',
          );
          continue;
        }
        // Run queued transfers first so the snapshot below reflects
        // balances after the conversion. Each action is isolated: a poison
        // action must not block its siblings or the snapshot refresh, so a
        // failed one is logged and left pending to retry next tick.
        const pending = await deps.listPendingDustTransfers(
          profile.operatorId,
          profile.accountId,
          profile.profileId,
        );
        for (const action of pending) {
          // `claimAction` is inside the per-action try so a DB error claiming
          // one action stays isolated — it must not abort the sibling actions
          // or the snapshot refresh below.
          let claimed = false;
          // Kept for the release below, which is fenced on it.
          const claimAt = new Date(clock.nowMs());
          try {
            // Claim before the non-idempotent `convertDust` write. If `finalize`
            // later fails, the row stays `processing` and the next tick's claim
            // is refused — so the conversion is not replayed until the reaper
            // ages the claim out, bounding replay to once instead of every tick.
            claimed = await deps.claimAction(
              profile.operatorId,
              profile.accountId,
              profile.profileId,
              action.id,
              claimAt,
            );
            if (!claimed) continue;
            const result = await rest.convertDust(action.assets);
            const finalized = await deps.finalize(
              profile.operatorId,
              profile.accountId,
              profile.profileId,
              action.id,
              result,
            );
            converted += 1;
            if (!finalized) {
              // The conversion succeeded but the row was no longer
              // `processing` — once the reaper resets it the action is
              // reclaimed and the (now no-op) conversion runs once more.
              deps.logger.warn(
                { profileId: profile.profileId, actionId: action.id },
                'cron dust-snapshot: dust transfer succeeded but the action was not finalised',
              );
            }
            // Binance can 200 with only part of the requested set converted
            // (an asset that is no longer dust-eligible drops out silently).
            // Match case-insensitively: Binance echoes `fromAsset` upper-case
            // while the operator-submitted asset list is not normalised.
            // Dedup by asset: Binance may return more than one transferResult
            // row for the same source asset (multiple lots), so a raw map would
            // overcount the operator-facing "N converted" list.
            const doneSet = new Set(result.transferResult.map((r) => r.fromAsset.toUpperCase()));
            const convertedAssets = [...doneSet];
            const missed = action.assets.filter((a) => !doneSet.has(a.toUpperCase()));
            if (missed.length > 0) {
              deps.logger.warn(
                { profileId: profile.profileId, actionId: action.id, missed },
                'cron dust-snapshot: dust transfer only partially applied',
              );
            }
            // Money moved: notify the operator. Only when something actually
            // converted (an all-empty result moved no funds — no alert).
            if (convertedAssets.length > 0) {
              await deps.notifyDustConversion?.({
                converted: convertedAssets,
                requested: action.assets.length,
                bnbReceived: result.totalTransfered,
                partial: missed.length > 0,
              });
            }
          } catch (err) {
            // Release the claim so the next tick retries promptly — only when
            // this pass actually won it (a `claimAction` that threw leaves the
            // row for the reaper). If the release itself fails the stale-
            // processing reaper recovers the row later.
            if (claimed) {
              try {
                await deps.releaseClaim(
                  profile.operatorId,
                  profile.accountId,
                  profile.profileId,
                  action.id,
                  claimAt,
                );
              } catch (releaseErr) {
                deps.logger.warn(
                  { profileId: profile.profileId, actionId: action.id, err: releaseErr },
                  'cron dust-snapshot: failed to release dust-transfer claim (reaper will recover)',
                );
              }
            }
            deps.logger.warn(
              { profileId: profile.profileId, actionId: action.id, err: err },
              'cron dust-snapshot: dust transfer failed (will retry next tick)',
            );
          }
        }
        const dust = await rest.getDustBtc();
        await deps.persistDust(
          profile.accountId,
          profile.profileId,
          mapDustSnapshot(dust, clock.nowMs()),
        );
        refreshed += 1;
      } catch (err) {
        failed += 1;
        deps.logger.warn(
          { profileId: profile.profileId, err: err },
          'cron dust-snapshot: profile refresh failed (will retry next tick)',
        );
      }
    }
    deps.logger.debug({ refreshed, converted, failed }, 'cron dust-snapshot: complete');
  };

export const buildDustSnapshotCron = (ctx: BootContext): CronDef => {
  const store = createDustSnapshotStore(ctx.redis);
  return defineCron({
    name: 'dust-snapshot',
    queue: QUEUE_NAMES.dustSnapshot,
    pattern: '0 */5 * * * *',
    handler: dustSnapshotHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      resolveBinance: ctx.resolveBinanceWithMode,
      persistDust: store.persistDust,
      listPendingDustTransfers: async (operatorId, accountId, profileId) => {
        const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
        const rows = await p.overrideActions.listPending();
        return (
          rows
            // `listPending` spans pending + processing (both have a null
            // `consumed_at`). Drop rows already `processing`: the reaper
            // resets a stale claim to pending before this runs, so a
            // still-`processing` row is genuinely mid-flight — claiming it
            // would only be refused.
            .filter((row) => row.action === 'dust-transfer' && row.processingAt === null)
            .map((row) => {
              // `payload` is jsonb — a null or non-object value would throw on
              // the `.assets` dereference and abort the whole profile pass.
              const rawAssets =
                row.payload && typeof row.payload === 'object'
                  ? (row.payload as { assets?: unknown }).assets
                  : undefined;
              const assets = Array.isArray(rawAssets)
                ? rawAssets.filter((a): a is string => typeof a === 'string')
                : [];
              return { id: row.id, assets };
            })
            .filter((action) => action.assets.length > 0)
        );
      },
      claimAction: async (operatorId, accountId, profileId, id, at) => {
        const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
        return p.overrideActions.claimAction(id, at);
      },
      finalize: async (operatorId, accountId, profileId, id, result) => {
        const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
        return p.overrideActions.finalize(id, result);
      },
      notifyDustConversion: async ({ converted, requested, bnbReceived, partial }) => {
        await ctx.accountNotify({
          category: 'dust-transfer',
          body: partial
            ? `Converted ${converted.length} of ${requested} requested dust asset(s) to BNB.`
            : `Converted ${converted.length} dust asset(s) to BNB.`,
          fields: [
            { label: 'Assets', value: converted.join(', ') },
            { label: 'BNB received', value: bnbReceived },
          ],
        });
      },
      // Same category the tick raises when it cannot resolve an override it ran:
      // from the operator's side the two are one problem — "a manual action may
      // have executed and the bot cannot confirm it" — and splitting them into two
      // categories would make muting one silently mute half the story.
      notifyOverrideUnresolved: (input) =>
        ctx.notifyEvent({
          category: 'override-unresolved',
          operatorId: input.operatorId,
          accountId: input.accountId,
          profileId: input.profileId,
          symbol: input.symbol,
          body: 'The bot started a manual action you triggered and then stopped before it could confirm the result. It may or may not have executed — check the exchange before re-issuing it.',
        }),
      releaseClaim: async (operatorId, accountId, profileId, id, at) => {
        const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
        await p.overrideActions.releaseClaim(id, at);
      },
      reapStaleProcessing: async (operatorId, accountId, profileId, staleBefore) => {
        const p = await profileRepo(ctx.db, operatorId, accountId, profileId);
        return p.overrideActions.reapStaleProcessing(staleBefore);
      },
      reapExpiredOverrides: async (operatorId, accountId, profileIds, staleBefore) => {
        const a = await accountRepo(ctx.db, operatorId, accountId);
        return a.overrideActions.reapExpiredForAccount(profileIds, staleBefore);
      },
    }),
  });
};
