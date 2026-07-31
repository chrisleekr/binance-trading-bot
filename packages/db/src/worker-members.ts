// Worker-fleet membership registry — shared read side.
//
// Each live worker pod owns one `worker:members:<id>` Redis key with a short
// TTL, refreshed on a heartbeat. The key expiring is the pod leaving the fleet
// (crash-only, no lock: there is no owner to release). To keep the count off
// the hot path of the public /status route, each worker publishes the derived
// fleet count to `worker:fleet-count` on its own heartbeat; readers GET that
// O(1) key rather than running an O(keyspace) SCAN per request.

import type { Redis } from 'ioredis';

// Bare ioredis keys (no scope prefix): fleet-global, not account-scoped.
export const MEMBER_KEY_PREFIX = 'worker:members:';
// Deliberately NOT under the `worker:members:` prefix, so the member SCAN below
// never counts the published count as a member.
export const FLEET_COUNT_KEY = 'worker:fleet-count';

/** One worker pod's membership record (JSON value of its member key). */
export interface MemberRecord {
  readonly id: string;
  readonly sha: string;
  readonly bootedAt: string;
  // True once boot completed and the pod is not draining. Owner election over
  // the fleet considers only ready members.
  readonly ready: boolean;
}

/** Live fleet size and how many members are past their boot ready-gate. */
export interface FleetCount {
  readonly total: number;
  readonly ready: number;
}

/**
 * Live member-key JSON values, de-duplicated. SCAN may return the same key more
 * than once during a rehash, so keys are collected into a Set first; a key that
 * expires between the SCAN and the MGET is dropped (null). O(keyspace), so
 * callers run this on the worker heartbeat (bounded frequency), never on a
 * per-request public path.
 */
const scanMemberValues = async (redis: Redis): Promise<string[]> => {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${MEMBER_KEY_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  if (keys.size === 0) return [];
  const values = await redis.mget(...keys);
  return values.filter((v): v is string => v !== null);
};

/**
 * Count live members (present keys) and how many are ready. A malformed record
 * counts toward `total` (the pod is live) but not `ready`. The snapshot may
 * under-count a pod that left mid-scan, but never double-counts.
 *
 * The worker publishes the result via {@link FLEET_COUNT_KEY} so readers GET it
 * O(1) rather than each running this SCAN.
 */
export const countWorkerMembers = async (redis: Redis): Promise<FleetCount> => {
  const values = await scanMemberValues(redis);
  let ready = 0;
  for (const v of values) {
    try {
      if ((JSON.parse(v) as { ready?: unknown }).ready === true) ready += 1;
    } catch {
      // Malformed record: live but not ready.
    }
  }
  return { total: values.length, ready };
};

/**
 * Ids of the ready members — the set owner election (HRW) hashes over. Only
 * members past their boot ready-gate are eligible to own a subscription; a
 * malformed record or one missing an `id` is skipped (not eligible). Shares the
 * heartbeat SCAN with {@link countWorkerMembers}; same frequency bound applies.
 */
export const listReadyMembers = async (redis: Redis): Promise<readonly string[]> => {
  const values = await scanMemberValues(redis);
  const ids: string[] = [];
  for (const v of values) {
    try {
      const rec = JSON.parse(v) as { id?: unknown; ready?: unknown };
      if (rec.ready === true && typeof rec.id === 'string' && rec.id.length > 0) ids.push(rec.id);
    } catch {
      // Malformed record: not eligible to own.
    }
  }
  return ids;
};

/**
 * Parse the published fleet count ({@link FLEET_COUNT_KEY}). Absent (no worker
 * has published, or the last one died and it expired) or malformed both degrade
 * to a zeroed count so a reader renders "no fleet" rather than failing.
 */
export const parseFleetCount = (raw: string | null): FleetCount => {
  if (raw === null) return { total: 0, ready: 0 };
  try {
    const parsed = JSON.parse(raw) as { total?: unknown; ready?: unknown };
    const total = typeof parsed.total === 'number' ? parsed.total : 0;
    const ready = typeof parsed.ready === 'number' ? parsed.ready : 0;
    return { total, ready };
  } catch {
    return { total: 0, ready: 0 };
  }
};
