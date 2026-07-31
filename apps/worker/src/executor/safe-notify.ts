import type { Logger } from 'pino';
import type { AnyNotifyProvider, NotifyMessage } from '@app/notify';

/**
 * Send a notify payload through a single provider, swallow provider
 * failures, and log them at error level. Returns true on success so
 * callers can aggregate fan-out outcomes without leaking provider
 * exceptions into the tick path — CLAUDE.md requires notify failures to
 * never fail a tick. The `config` parameter is the per-row provider
 * config (e.g. Slack webhook URL) and is passed through to the provider
 * unchanged.
 */
export const safeNotify = async (
  provider: AnyNotifyProvider,
  message: NotifyMessage,
  config: unknown,
  logger: Logger,
): Promise<boolean> => {
  try {
    await provider.send({ config, message });
    return true;
  } catch (err) {
    // Log the raw caught value under the `err` key: pino's `err` serializer
    // emits type, message, and stack, and narrows non-Error throws (primitives,
    // null) safely, so the swallow contract holds without a property access here.
    logger.error({ provider: provider.name, err }, 'notify provider failed');
    return false;
  }
};
