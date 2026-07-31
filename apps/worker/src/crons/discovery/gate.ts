// Per-profile refresh gate.
//
// One atomic `EVAL` decides whether a profile runs this wake, so competing
// consumers cannot both pass the gate the same period. The script self-heals a
// TTL-less wedge that a plain `SET NX PX` would skip forever.

import { GLOBAL_KEYS } from '@app/db';
import type { Logger } from 'pino';

/** Minimal Redis surface the refresh gate needs, so it can be unit-tested with a fake. */
export interface DiscoveryRedisGate {
  /**
   * ioredis `EVAL` — one atomic script call. Declared structurally so the gate
   * logic stays server-side; the worker injects its real ioredis client.
   */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic per-profile refresh gate. A plain `SET NX PX` cannot heal a key that
// exists with no expiry (PTTL == -1): the NX fails every period and the profile
// wedges forever. This branches on the current TTL so a TTL-less key is
// reclaimed instead of skipped.
//   KEYS[1] = discovery:lastrun:<pid>
//   ARGV    = nowMs, refreshPeriodMs
//   returns = 1 (absent → acquired), 2 (no-TTL wedge → reclaimed), 0 (within window → skip)
// The stored value (nowMs) is a last-run stamp for observability only; the gate
// branches solely on PTTL and never GETs it back.
const GATE_LUA = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 1
end
if ttl == -1 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 2
end
return 0
`;

/**
 * Per-profile refresh gate: returns true for exactly one caller per
 * `refreshPeriodMs` window. A single server-atomic `EVAL` (not a get-then-set),
 * so under competing consumers two pods cannot both pass the gate the same
 * period (which would double-rotate symbols and double-enqueue reconfigure
 * jobs). The first caller stamps the key with a period-length TTL and runs;
 * callers within the period see a live TTL and skip; the TTL expiring is the
 * next period opening. Not a lock: no owner, no release — the key self-expires;
 * a dead runner just delays the next rotation by up to one period.
 *
 * Self-heals a wedge: a `discovery:lastrun:<pid>` key present with no expiry
 * (PTTL == -1, e.g. from an older writer) would fail a plain `SET NX` every
 * period and skip the profile forever. The script reclaims it — re-stamps the
 * TTL and returns — and we log the auto-heal once so the offending writer is
 * still visible.
 */
export const shouldRunProfile = async (
  redis: DiscoveryRedisGate,
  profileId: string,
  refreshPeriodMs: number,
  nowMs: number,
  logger: Logger,
): Promise<boolean> => {
  const key = GLOBAL_KEYS.discoveryLastRun(profileId);
  const result = Number(await redis.eval(GATE_LUA, 1, key, String(nowMs), refreshPeriodMs));
  if (result === 2) {
    logger.warn(
      { profileId, key },
      'discovery: reclaimed a lastrun key with no TTL — a wedge was auto-healed; investigate the writer',
    );
  }
  return result !== 0;
};
