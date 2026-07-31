// Gate the worker's destructive teardown on a CLEAN drain.
//
// SIGTERM starts a bounded drain: stop the lifecycle components and the BullMQ
// queueSet, capped at a deadline. The cap only bounds the AWAIT — it does not
// cancel the work. If the drain outruns the cap, a tick can still be mid-flight
// against the pg pool and Redis. Tearing those down (`pool.end()` flips the pool
// to `ending` immediately) would then poison that in-flight tick's state commit:
// the commit throws, BullMQ retries the tick on the next pod, and a re-derived
// MARKET entry fills a SECOND time (the durable placement-dedup mirror is the
// cross-process backstop for exactly this).
//
// So teardown runs ONLY on a clean drain. A timed-out drain skips pool/redis
// teardown entirely and exits non-zero — the process (and any in-flight tick)
// dies with the pod, but against a HEALTHY pool, so nothing is poisoned into a
// retry-triggering throw.

import type { Logger } from 'pino';

export interface TeardownDeps {
  /** Did the drain finish within its deadline? False ⇒ a tick may be mid-flight. */
  readonly drained: boolean;
  /** Names of components whose stop() threw; non-empty ⇒ non-zero exit. */
  readonly stopFailures: string[];
  readonly adminServer: { stop(): Promise<void> };
  readonly pool: { end(): Promise<void> };
  readonly redis: { quit(): Promise<unknown> };
  readonly auditDrainerRedis: { quit(): Promise<unknown> };
  readonly logger: Pick<Logger, 'error'>;
  /** Records the desired process exit code. */
  readonly exit: (code: number) => void;
}

/**
 * Pure decision: whether destructive teardown may run, and the process exit code.
 *
 *  - not drained cleanly (timed out OR a subsystem close failed) ⇒ skip teardown,
 *    exit 1 (a tick may be mid-flight).
 *  - drained cleanly ⇒ run teardown; exit 0, or 1 if any component stop failed.
 */
export const decideTeardown = (
  drained: boolean,
  stopFailures: string[],
): { runTeardown: boolean; exitCode: number } =>
  drained
    ? { runTeardown: true, exitCode: stopFailures.length > 0 ? 1 : 0 }
    : { runTeardown: false, exitCode: 1 };

/**
 * Run (or deliberately skip) destructive teardown per {@link decideTeardown},
 * then signal the exit code. On a clean drain: stop taking traffic
 * (adminServer.stop), then close the pg pool, then Redis. On a timed-out drain:
 * log why teardown is skipped and exit non-zero WITHOUT touching pool/redis.
 */
export const runTeardown = async (deps: TeardownDeps): Promise<void> => {
  const { runTeardown: run, exitCode } = decideTeardown(deps.drained, deps.stopFailures);

  if (!run) {
    deps.logger.error(
      { stopFailures: deps.stopFailures },
      'worker drain did not complete cleanly (timed out or a subsystem close failed); skipping pool/redis teardown so an in-flight tick is not poisoned into a retry (a duplicate MARKET fill)',
    );
    deps.exit(1);
    return;
  }

  // Stop taking traffic first, then close backends in dependency order.
  await deps.adminServer.stop();
  await deps.pool.end().catch((err: unknown) => {
    deps.logger.error({ err: err }, 'worker teardown: pg pool close failed');
  });
  await deps.redis.quit().catch(() => undefined);
  await deps.auditDrainerRedis.quit().catch(() => undefined);

  if (deps.stopFailures.length > 0) {
    deps.logger.error({ failed: deps.stopFailures }, 'worker drained with stop failures');
  }
  deps.exit(exitCode);
};
