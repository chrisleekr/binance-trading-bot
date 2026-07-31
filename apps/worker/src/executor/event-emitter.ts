import type { Redis } from 'ioredis';
import { encodeWsEventStreamFields } from '@app/contracts';
import type { AccountId, ProfileId, WsPayloadFor, WsTopic } from '@app/contracts';
import { buildEventsChannel, buildEventsSeqKey, buildEventsStreamKey } from './redis-namespace.js';

export interface EventEmitterDeps {
  readonly redis: Redis;
  readonly clock: { nowMs(): number };
}

/**
 * Publish one server→client event onto the per-profile pub/sub channel AND
 * append it to the bounded replay stream. The envelope is the `WsEvent`
 * contract shape `{ seq, topic, ts, payload }`: the API forwards the pub/sub
 * body verbatim to live WS subscribers and reconstructs the same envelope
 * from the stream's `seq/topic/ts/payload` fields on `?since=` reconnect, so
 * both paths MUST stay byte-identical.
 *
 * `seq` is monotonic per (userId, profileId): an INCR before the MULTI. The
 * worker is single-replica and per-profile decisions run serially, so the
 * INCR-then-MULTI pair cannot interleave for one profile. The MULTI keeps
 * publish + xadd atomic from any concurrent reader's perspective; MAXLEN ~
 * 1000 bounds the stream without a separate trimmer cron.
 */
export const emitEvent = async <T extends WsTopic>(
  deps: EventEmitterDeps,
  accountId: AccountId,
  profileId: ProfileId,
  topic: T,
  payload: WsPayloadFor<T>,
): Promise<void> => {
  const channel = buildEventsChannel(accountId, profileId);
  const stream = buildEventsStreamKey(accountId, profileId);
  const seq = await deps.redis.incr(buildEventsSeqKey(accountId, profileId));
  const ts = new Date(deps.clock.nowMs()).toISOString();
  const body = JSON.stringify({ seq, topic, ts, payload });
  const pipeline = deps.redis.multi();
  pipeline.publish(channel, body);
  // Field layout is the single `encodeWsEventStreamFields` source the api
  // replay reader decodes through, so the two cannot drift.
  pipeline.xadd(
    stream,
    'MAXLEN',
    '~',
    '1000',
    '*',
    ...encodeWsEventStreamFields({ seq, topic, ts, payload }),
  );
  await pipeline.exec();
};
