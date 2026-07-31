import type { ScopedRedis } from '@app/db';
import { decodeWsEventStreamFields } from '@app/contracts';
import type { Logger } from 'pino';

// Replay window from `events:<u>:<p>:stream` (capped 1000 / 1h, see plan-04
// §"Topology"). Entries are XADD-ed by the worker via
// `encodeWsEventStreamFields`; this reader decodes through the matching
// `decodeWsEventStreamFields`, which validates each entry against `WsEvent`
// so a reconnecting client never receives a hand-reconstructed, unvalidated
// envelope.
export interface ReplayResult {
  envelopes: string[];
  resyncRequired: boolean;
}

export const replayMissed = async (
  redis: ScopedRedis,
  streamKey: string,
  sinceSeq: number,
  logger?: Pick<Logger, 'warn'>,
): Promise<ReplayResult> => {
  const r = redis.raw();
  const entries = await r.xrange(streamKey, '-', '+', 'COUNT', 1000);
  if (entries.length === 0) {
    return { envelopes: [], resyncRequired: false };
  }
  const first = entries[0];
  if (!first) return { envelopes: [], resyncRequired: false };
  const firstSeq = readSeq(first[1]);
  if (firstSeq !== null && firstSeq > sinceSeq + 1) {
    // Gap: oldest stream entry is past the consumer's position.
    return { envelopes: [], resyncRequired: true };
  }
  const out: string[] = [];
  for (const [id, fields] of entries) {
    const seq = readSeq(fields);
    if (seq === null || seq <= sinceSeq) continue;
    const event = decodeWsEventStreamFields(fields);
    if (event === null) {
      // A stored entry that fails the `WsEvent` contract (field drift or a
      // corrupt payload) is skipped, not forwarded as garbage to the client.
      logger?.warn({ streamKey, id }, 'ws_replay_dropped_invalid_entry');
      continue;
    }
    out.push(JSON.stringify(event));
  }
  return { envelopes: out, resyncRequired: false };
};

// Lightweight `seq` pre-read for the gap check and the per-entry skip filter,
// before the full decode. Reads only the `seq` field.
const readSeq = (fields: readonly string[]): number | null => {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === 'seq') {
      const v = fields[i + 1];
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
};
