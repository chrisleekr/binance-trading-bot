// Typed ordering gate between cron registration and tick-worker start.
//
// The boot invariant: a tick that fires before `exchangeInfo` is in Redis
// lands in the cold-load fallback path, which works but adds ~500ms to
// the first tick per symbol. `primeBeforeTicks` is the named phase that
// makes that ordering explicit at the call site — Phase A registers
// crons, Phase B primes, Phase C registers tick + pipeline workers.
//
// Tolerant of upstream failure: a permanent prime-time failure is logged
// at error and we continue. The exchange-info-refresh cron will retry on
// its next tick, and the cold-load fallback still produces a correct
// (if slower) tick. Crashing the worker here would gain nothing — the
// strategy can run without primed exchangeInfo.

import type { Logger } from 'pino';

export interface PrimeBeforeTicksDeps {
  readonly logger: Logger;
  readonly exchangeInfoRefresh: () => Promise<unknown>;
}

export const primeBeforeTicks = async (deps: PrimeBeforeTicksDeps): Promise<void> => {
  try {
    await deps.exchangeInfoRefresh();
  } catch (err) {
    // Full err object via pino's serializer so a permanent bug (typo'd
    // host, schema drift) shows the stack — not just `.message` — and
    // can be told apart from a transient network blip the cron will
    // recover from.
    deps.logger.error(
      { err },
      'primeBeforeTicks: exchange-info refresh failed, falling back to cron + cold-load',
    );
  }
};
