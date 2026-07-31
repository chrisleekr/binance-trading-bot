import type { Logger } from 'pino';
import { Redis } from 'ioredis';
import { EVENTS_CHANNEL_PATTERN } from '@app/db';

// Bun's ServerWebSocket pub/sub surface; only the bits we need so this
// module compiles without a Bun-typed environment.
export interface PublisherServer {
  publish(topic: string, data: string): number;
}

export interface WsRegistry {
  stop(): Promise<void>;
}

// Boots a dedicated ioredis subscriber connection (separate from the BullMQ
// pool, since ioredis blocks the connection in subscribe mode) and pattern-
// subscribes to `events:*:*`. Every Pub/Sub message is forwarded to the Bun
// WS server's topic of the same name via server.publish().
export const startWsRegistry = (
  redisUrl: string,
  server: PublisherServer,
  logger: Logger,
): WsRegistry => {
  const sub = new Redis(redisUrl);
  void sub.psubscribe(EVENTS_CHANNEL_PATTERN).then(
    () => logger.info('ws_registry_subscribed'),
    (err: unknown) => logger.error({ err }, 'ws_registry_psubscribe_failed'),
  );
  sub.on('pmessage', (_pattern, channel, message) => {
    server.publish(channel, message);
  });
  sub.on('error', (err: unknown) => logger.warn({ err }, 'ws_registry_redis_error'));
  return {
    stop: async () => {
      try {
        await sub.punsubscribe(EVENTS_CHANNEL_PATTERN);
      } catch (err) {
        logger.warn({ err }, 'ws_registry_punsubscribe_failed');
      }
      await sub.quit();
    },
  };
};
