// The ticket is the release half of the bundle-builder's destructive override
// DEL. Its whole job is to run exactly once, on the paths nobody remembered to
// handle, without ever throwing into the error already unwinding the tick.
//
// Asserted against the REAL `settleOverride` (only Redis and the row writer are
// stubbed) so "the compensation re-arms" cannot pass while the re-arm shape has
// silently forked from the one the defer path uses.

import { describe, expect, it, vi } from 'vitest';
import { profileKey, type ProfileScope } from '@app/db';
import { asAccountId, asProfileId, asUserId, type ManualOverridePayload } from '@app/contracts';

import { createOverrideTicket, type OverrideTicketDeps } from '../../src/tick/override-ticket.js';

const OPERATOR = asUserId('00000000-0000-0000-0000-0000000000a1');
const ACCOUNT = asAccountId('00000000-0000-0000-0000-000000000abc');
const PROFILE = asProfileId('00000000-0000-0000-0000-000000000def');
const SYMBOL = 'BTCUSDT';
const OVERRIDE_ACTION_ID = '01234567-89ab-4cde-89ab-cdef01234567';

const SCOPE = {
  operatorId: OPERATOR,
  accountId: ACCOUNT,
  profileId: PROFILE,
} as unknown as ProfileScope;

const OVERRIDE: ManualOverridePayload = {
  kind: 'trigger-sell',
  overrideActionId: OVERRIDE_ACTION_ID,
};

const OVERRIDE_KEY = profileKey({ accountId: ACCOUNT, profileId: PROFILE }, 'override', SYMBOL);
/** The injected clock reading the claim is stamped with, and the release fenced on. */
const CLAIM_NOW_MS = 1_700_000_000_000;

interface Harness {
  readonly ticket: ReturnType<typeof createOverrideTicket>;
  readonly setCalls: unknown[][];
  readonly settleOverrideAction: ReturnType<typeof vi.fn>;
  readonly notifyOverrideOutcome: ReturnType<typeof vi.fn>;
  readonly claimOverrideAction: ReturnType<typeof vi.fn>;
  readonly warnings: string[];
}

const build = (
  opts: {
    elapsedMs?: number;
    /**
     * Throw from `elapsedMs()`, which the compensation calls while building the
     * settle args. The only cheap way to raise inside compensate's own `try`
     * without reaching through `settleOverride`, which swallows its own faults.
     */
    elapsedMsThrows?: boolean;
    settleThrows?: boolean;
    /** ioredis resolves SET..NX to null when a newer override already holds the key. */
    setReply?: 'OK' | null;
    /**
     * Present = wire the liveness dep and answer with this row (`null` = the
     * operator cancelled). Absent = leave the dep unwired.
     */
    activeRowId?: string | null;
    /** Wire the liveness dep but have the read fail, so nothing can be confirmed. */
    activeRowRejects?: boolean;
    /**
     * Present = wire the claim dep and answer with this verdict. Absent = leave it
     * unwired, which must read as claimed.
     */
    claimWon?: boolean;
    /** Wire the claim dep but have it fail, so the win cannot be confirmed. */
    claimRejects?: boolean;
    /** Wire the claim dep but never settle it, so only the deadline ends the wait. */
    claimStalls?: boolean;
    persistTimeoutMs?: number;
    releaseOverrideClaim?: (...args: unknown[]) => Promise<void>;
    /** Shared ordering log, so claim-versus-release sequencing is observable. */
    calls?: string[];
  } = {},
): Harness => {
  const setCalls: unknown[][] = [];
  const warnings: string[] = [];
  const settleOverrideAction = vi.fn((..._args: unknown[]) => {
    // A synchronous throw, not a rejection: this is the shape that used to escape
    // the settle's deadline race, which only ever guards a returned promise. The
    // fake keeps throwing this way so the swallow stays pinned to a real failure
    // mode rather than a rejection the race already covered.
    if (opts.settleThrows === true) throw new Error('row writer exploded');
    return Promise.resolve();
  });
  const notifyOverrideOutcome = vi.fn(async (..._args: unknown[]) => undefined);
  const claimOverrideAction = vi.fn((..._args: unknown[]): Promise<boolean> => {
    opts.calls?.push('claim');
    if (opts.claimRejects === true) return Promise.reject(new Error('postgres unreachable'));
    if (opts.claimStalls === true) return new Promise<boolean>(() => undefined);
    return Promise.resolve(opts.claimWon === true);
  });
  const claimWired =
    opts.claimWon !== undefined || opts.claimRejects === true || opts.claimStalls === true;
  const deps = {
    redis: {
      set: (...argv: unknown[]) => {
        setCalls.push(argv);
        // Not `??`: `null` IS the reply under test, and nullish-coalescing would
        // silently substitute 'OK' for it.
        return Promise.resolve(opts.setReply === undefined ? 'OK' : opts.setReply);
      },
    },
    logger: {
      warn: (_ctx: unknown, msg: string) => {
        warnings.push(msg);
      },
    },
    settleOverrideAction,
    notifyOverrideOutcome,
    symbol: SYMBOL,
    // Fixed: the claim stamp is asserted by identity against what the release is
    // fenced on, so it must not drift between the two reads.
    nowMs: () => CLAIM_NOW_MS,
    elapsedMs: () => {
      if (opts.elapsedMsThrows === true) throw new Error('clock exploded');
      return opts.elapsedMs ?? 0;
    },
    // Keyed on PRESENCE, not truthiness: `null` is the cancelled case under test.
    ...(opts.activeRowRejects === true
      ? {
          findActiveOverride: () => Promise.reject(new Error('postgres unreachable')),
        }
      : 'activeRowId' in opts
        ? {
            findActiveOverride: () =>
              Promise.resolve(opts.activeRowId === null ? null : { id: opts.activeRowId }),
          }
        : {}),
    ...(claimWired ? { claimOverrideAction } : {}),
    ...(opts.releaseOverrideClaim ? { releaseOverrideClaim: opts.releaseOverrideClaim } : {}),
    ...(opts.persistTimeoutMs === undefined ? {} : { persistTimeoutMs: opts.persistTimeoutMs }),
  } as unknown as OverrideTicketDeps;
  return {
    ticket: createOverrideTicket(deps),
    setCalls,
    settleOverrideAction,
    notifyOverrideOutcome,
    claimOverrideAction,
    warnings,
  };
};

const armed = { scope: SCOPE, override: OVERRIDE, ttlMs: 120_000 };

describe('createOverrideTicket', () => {
  it('does nothing when the tick never consumed an override', async () => {
    const h = build();
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).not.toHaveBeenCalled();
  });

  it('re-arms a consumed override the tick never dispatched', async () => {
    const h = build();
    h.ticket.arm(armed);
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(1);
    // The defer path's exact shape, because it IS the defer path: same key, same
    // serialised payload, PX for the remaining window, NX to yield to a newer one.
    expect(h.setCalls[0]).toEqual([OVERRIDE_KEY, JSON.stringify(OVERRIDE), 'PX', 120_000, 'NX']);
    // Nothing executed, so the row stays pending for the next tick to claim.
    expect(h.settleOverrideAction).not.toHaveBeenCalled();
  });

  it('charges the tick latency against the re-armed window', async () => {
    const h = build({ elapsedMs: 450 });
    h.ticket.arm(armed);
    await h.ticket.compensate();

    expect(h.setCalls[0]?.[3]).toBe(119_550);
  });

  it('refuses to re-arm once the tick reached the executor with an order', async () => {
    // The order may be live on Binance. Re-arming would hand the same override to
    // the next tick, which would place a second one under a fresh clientOrderId.
    const h = build();
    h.ticket.arm(armed);
    h.ticket.markOrderAttempted();
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
    // `unknown` is the one status that escalates: only a human can check the book.
    expect(h.settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'unknown',
      reason: expect.any(String) as unknown as string,
    });
    // The escalation is the whole point of `unknown`: an order may be live on
    // Binance, and the settled row alone is a badge nobody is watching.
    expect(h.notifyOverrideOutcome).toHaveBeenCalledTimes(1);
    expect(h.notifyOverrideOutcome.mock.calls[0]?.[0]).toMatchObject({
      overrideActionId: OVERRIDE_ACTION_ID,
      symbol: SYMBOL,
      outcome: { status: 'unknown' },
    });
  });

  it('settles rejected without re-arming when the override is what killed the tick', async () => {
    // `strategy.tick` is pure, so the next tick fails identically. Re-arming would
    // loop the poison payload to the TTL and the symbol would commit no state at
    // all meanwhile — a wedged symbol on a live position.
    const h = build();
    h.ticket.arm(armed);
    h.ticket.markDeterministicAbort();
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(h.settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'rejected',
      reason: expect.any(String) as unknown as string,
    });
  });

  it('settles instead of re-arming when the builder surfaced no TTL to restore', async () => {
    // `parseTtlReply` yields undefined for a PTTL of -1 / -2 or an errored slot.
    // With no window to put the override back into, a re-arm would invent one.
    const h = build();
    h.ticket.arm({ scope: SCOPE, override: OVERRIDE });
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
  });

  it('settles superseded when NX refuses because a newer override holds the key', async () => {
    // The branch only `settleOverride` implements: a shape-identical inline `set`
    // would write the same argv and then leave the stale row pending forever.
    const h = build({ setReply: null });
    h.ticket.arm(armed);
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(1);
    expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(h.settleOverrideAction.mock.calls[0]?.[2]).toEqual({ status: 'superseded' });
  });

  it('settles expired, not pending, when the window closed before the tick died', async () => {
    const h = build({ elapsedMs: 120_000 });
    h.ticket.arm(armed);
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
    expect(h.settleOverrideAction.mock.calls[0]?.[2]).toEqual({
      status: 'expired',
      // Says what actually happened, not the sweep's "no tick ever ran".
      reason: 'a tick consumed this override and failed before it could be dispatched',
    });
  });

  it('does nothing once the normal path has settled the override', async () => {
    const h = build();
    h.ticket.arm(armed);
    h.ticket.markSettled();
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(0);
    expect(h.settleOverrideAction).not.toHaveBeenCalled();
  });

  it('compensates at most once however many times it is called', async () => {
    const h = build();
    h.ticket.arm(armed);
    await h.ticket.compensate();
    await h.ticket.compensate();

    expect(h.setCalls).toHaveLength(1);
  });

  // The claim is what closes the race between the tick and the operator's cancel: the
  // cancel deletes an UNCLAIMED row only, so until the claim lands the row can vanish
  // mid-tick while the order still reaches Binance. It is fired from `arm`, the earliest
  // moment the override is known to be consumed, and read at the dispatch gate.
  describe('claim', () => {
    it('reads as claimed when the dep is not wired', async () => {
      // An unwired dep must not disable the dispatch: a stub harness (or a boot path
      // that forgets the dep) would otherwise silently stop every override tick.
      const h = build();
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(true);
    });

    it('reads as claimed when the tick armed no override', async () => {
      // Nothing was consumed, so there is no row to claim and nothing to gate on.
      const h = build({ claimWon: true });

      await expect(h.ticket.whenClaimed()).resolves.toBe(true);
      expect(h.claimOverrideAction).not.toHaveBeenCalled();
    });

    it('claims the armed row with the scope the tick already proved, stamped from its own clock', async () => {
      const h = build({ claimWon: true });
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(true);
      expect(h.claimOverrideAction).toHaveBeenCalledTimes(1);
      // The stamp is the CALLER's: the release is fenced on it, and a database-side
      // `now()` would leave the tick unable to name the value it needs to match, which
      // is precisely the state a lost reply puts it in.
      expect(h.claimOverrideAction).toHaveBeenCalledWith(
        SCOPE,
        OVERRIDE_ACTION_ID,
        new Date(CLAIM_NOW_MS),
      );
      expect(h.ticket.claimAt()).toEqual(new Date(CLAIM_NOW_MS));
    });

    it('reports a lost claim', async () => {
      const h = build({ claimWon: false });
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(false);
    });

    it('does not spend the deadline on work between arming and the gate', async () => {
      // The bound belongs to the WAIT, not to the round-trip's start. Measured from
      // `arm`, the budget would be consumed by the tick body that runs in between
      // (candle windows can fall back to a weight-governed REST call), and a tick
      // slower than the budget would throw away a claim it already held. Here the claim
      // resolves well after the deadline's worth of time has passed since `arm`, and it
      // must still be honoured.
      const h = build({ claimWon: true, persistTimeoutMs: 30 });
      h.ticket.arm(armed);
      await new Promise((resolve) => setTimeout(resolve, 60));

      await expect(h.ticket.whenClaimed()).resolves.toBe(true);
    });

    it('answers the gate and the compensation with one verdict', async () => {
      // Two callers, one CAS reply. Re-deriving it per caller would hand the second a
      // fresh deadline and could answer differently for the same tick.
      const h = build({ claimWon: true });
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(true);
      await h.ticket.compensate();

      expect(h.claimOverrideAction).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the claim throws', async () => {
      // An unproven claim leaves the cancel route's delete guard open, so dispatching
      // under it can place an order for an action the operator was told was cancelled.
      // The verdict is the boolean and never a rejection: a caller must not be able to
      // mistake a fault for permission by forgetting a `.catch`.
      const h = build({ claimRejects: true });
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(false);
      expect(h.warnings.some((w) => /could not claim the override row/.test(w))).toBe(true);
    });

    it('fails closed when the claim stalls past its deadline', async () => {
      // The gate awaits this while holding the per-(profile, symbol) chain lock, so an
      // unbounded wait would stall the next tick for the symbol too.
      const h = build({ claimStalls: true, persistTimeoutMs: 20 });
      h.ticket.arm(armed);

      await expect(h.ticket.whenClaimed()).resolves.toBe(false);
      expect(h.warnings.some((w) => /exceeded its deadline/.test(w))).toBe(true);
    });

    it('releases the claim when the compensation re-arms the override, fenced on its own stamp', async () => {
      // The compensation hands the override to a later tick, which has to be able to
      // claim it. The ticket does not re-implement that: it forwards the release into
      // the same settle that owns the re-arm. The stamp travels with it so the UPDATE
      // can only clear THIS tick's claim.
      const releaseOverrideClaim = vi.fn(async () => undefined);
      const h = build({ claimWon: true, releaseOverrideClaim });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(1);
      expect(releaseOverrideClaim).toHaveBeenCalledWith(
        SCOPE,
        OVERRIDE_ACTION_ID,
        new Date(CLAIM_NOW_MS),
      );
    });

    it('releases on a re-arm even though it knows it did NOT win the row', async () => {
      // The release is not gated on believing the claim is held. That belief is exactly
      // what a lost acknowledgement breaks, and gating on it is what would livelock the
      // retry: a row whose claim landed but whose reply did not would be re-armed with
      // the claim still on, so no later tick could take it. Fencing is what makes firing
      // it regardless safe — with the stamp unmatched the UPDATE touches nothing.
      const releaseOverrideClaim = vi.fn(async () => undefined);
      const h = build({ claimWon: false, activeRowId: OVERRIDE_ACTION_ID, releaseOverrideClaim });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(1);
      expect(releaseOverrideClaim).toHaveBeenCalledTimes(1);
    });

    it('waits for the in-flight claim before releasing it', async () => {
      // Ordering under a fast abort. Issue the release while the claim UPDATE is still
      // on the wire and it matches nothing, then the claim lands: the key ends up
      // re-armed AND the row claimed, so the next tick cannot take the override and an
      // operator cancel is told the bot is acting on something nothing is acting on.
      const calls: string[] = [];
      const releaseOverrideClaim = vi.fn(async () => {
        calls.push('release');
      });
      const h = build({
        claimWon: true,
        activeRowId: OVERRIDE_ACTION_ID,
        releaseOverrideClaim,
        calls,
      });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(calls).toEqual(['claim', 'release']);
    });

    it('settles rather than re-arms an override whose ownership it could not confirm', async () => {
      // `lost` and `unresolved` must not collapse. Re-arming an unconfirmable claim
      // loops it: a Postgres that misses the budget once will miss the retry's too, so
      // the override would consume and re-arm every tick until its window drained, and
      // the symbol would commit no state and place no orders throughout — no trailing
      // sell, no protective stop, on a live position. The operator gets a verdict and
      // can re-press instead.
      const h = build({ claimRejects: true, activeRowId: OVERRIDE_ACTION_ID });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(0);
      expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
      expect(h.settleOverrideAction.mock.calls[0]?.[2]).toEqual({
        status: 'rejected',
        reason: 'the bot could not confirm it owned this override; nothing was run, re-issue it',
      });
    });

    it('settles rather than re-arms when the claim never answered at all', async () => {
      // The timeout arm of the same rule. Both non-answers reach it, and with only the
      // rejection asserted a regression on the deadline path hides behind it.
      const h = build({ claimStalls: true, persistTimeoutMs: 20, activeRowId: OVERRIDE_ACTION_ID });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(0);
      expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
      expect(h.settleOverrideAction.mock.calls[0]?.[2]).toMatchObject({ status: 'rejected' });
    });
  });

  // The cancel route's `processing_at is null` guard protects a row this tick has
  // claimed, but the operator can still revoke one in the gap before that claim lands
  // or after it is released for a re-arm. A blind re-arm would then put the revoked
  // action back into Redis for the next tick to execute for real.
  describe('cancel race', () => {
    it('re-arms when the operator has not cancelled', async () => {
      const h = build({ activeRowId: OVERRIDE_ACTION_ID });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(1);
      expect(h.settleOverrideAction).not.toHaveBeenCalled();
    });

    it('does not re-arm or settle an override the operator cancelled', async () => {
      const h = build({ activeRowId: null });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(0);
      // Settling would be writing to a row that no longer exists; the operator has
      // already been told it was cancelled.
      expect(h.settleOverrideAction).not.toHaveBeenCalled();
      expect(h.warnings.some((w) => /cancelled/.test(w))).toBe(true);
    });

    it('does not restore a stale override the operator replaced with a newer one', async () => {
      // Cancel-then-push: a different row is live now, and re-arming the old payload
      // would execute an intent the operator has already moved on from.
      const h = build({ activeRowId: 'ffffffff-89ab-4cde-89ab-cdef01234567' });
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(0);
      expect(h.settleOverrideAction).not.toHaveBeenCalled();
    });

    it('stands down when the liveness read cannot be confirmed', async () => {
      // Fail CLOSED. Un-settled, the row is swept `expired` and the operator can
      // re-press; re-armed against a row nobody could verify, a cancelled force-sell
      // executes for real.
      const h = build({ activeRowRejects: true });
      h.ticket.arm(armed);

      await expect(h.ticket.compensate()).resolves.toBeUndefined();
      expect(h.setCalls).toHaveLength(0);
      expect(h.settleOverrideAction).not.toHaveBeenCalled();
    });

    it('still settles a dispatched abort without consulting the row', async () => {
      // A dispatched abort can never re-arm, so there is nothing to veto — and its
      // `unknown` escalation must still fire: cancelling the row does not un-place
      // an order that may already be live on Binance.
      const h = build({ activeRowId: null });
      h.ticket.arm(armed);
      h.ticket.markOrderAttempted();
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(0);
      expect(h.settleOverrideAction).toHaveBeenCalledTimes(1);
      expect(h.notifyOverrideOutcome).toHaveBeenCalledTimes(1);
    });

    it('re-arms as before when the liveness dep is not wired', async () => {
      // A caller that cannot check keeps the pre-existing behaviour rather than
      // losing every override to a check it has no way to perform.
      const h = build();
      h.ticket.arm(armed);
      await h.ticket.compensate();

      expect(h.setCalls).toHaveLength(1);
    });
  });

  it('swallows a settle failure so the tick error in flight is the one that propagates', async () => {
    // Compensation runs from a `finally` with a real error unwinding. Throwing
    // from there would replace the failure the operator needs to see with a
    // bookkeeping one.
    const h = build({ elapsedMs: 120_000, settleThrows: true });
    h.ticket.arm(armed);

    await expect(h.ticket.compensate()).resolves.toBeUndefined();
    expect(h.warnings.some((w) => /settleOverrideAction failed/.test(w))).toBe(true);
  });

  it('swallows a failure raised in the compensation itself, not in the settle', async () => {
    // The settle swallows its own faults, so it can never exercise compensate's
    // catch. A fault in the args the compensation assembles can, and that catch is
    // what keeps a bookkeeping error from replacing the tick error still unwinding.
    const h = build({ elapsedMsThrows: true });
    h.ticket.arm(armed);

    await expect(h.ticket.compensate()).resolves.toBeUndefined();
    expect(h.warnings.some((w) => /could not compensate/.test(w))).toBe(true);
  });
});
