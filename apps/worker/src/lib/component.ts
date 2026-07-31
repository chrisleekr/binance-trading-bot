// Uniform lifecycle component contract.
//
// `Component` is the smallest possible interface that lets the worker
// boot orchestrate heterogeneous long-lived subsystems through a single
// loop. Each implementation owns whatever start/stop semantics it
// needs; this layer only sequences them.
//
// Stateless registrations (`registerTickWorker`, `registerPipelineWorker`,
// `registerCrons`) intentionally do NOT implement `Component` — they are
// imperative function calls because wrapping them adds no lifecycle and
// would mean 4× the boilerplate for zero behavioural gain. CLAUDE.md
// "no speculative abstraction".

import type { Logger } from 'pino';

export interface Component {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start each component sequentially. A throw aborts the boot — no fallthrough
 * to a half-started worker. The caller is expected to surface the failure
 * to the orchestrator (process.exit non-zero) so K8s / docker reschedules.
 * Sequential rather than parallel because boot-time component A may publish
 * state that component B reads at start (e.g. ProfileManager → MarketSubscriber).
 */
export const startAll = async (components: readonly Component[], logger: Logger): Promise<void> => {
  for (const c of components) {
    logger.info({ component: c.name }, 'component: starting');
    await c.start();
    logger.info({ component: c.name }, 'component: started');
  }
};

/**
 * Stop each component sequentially in REVERSE start order. A stop that
 * throws does NOT abort the loop — a stuck subsystem cannot prevent the
 * rest of the worker from draining. Each failure is logged at error and
 * the loop continues. Returns the failed component names so the caller
 * can surface non-zero exit to the orchestrator (K8s / docker) — a log
 * line alone is too easy to lose in a shutdown stream. The outer SIGTERM
 * handler still enforces the 10s drain budget.
 */
export const stopAll = async (
  components: readonly Component[],
  logger: Logger,
): Promise<readonly string[]> => {
  const failed: string[] = [];
  for (const c of [...components].reverse()) {
    try {
      logger.info({ component: c.name }, 'component: stopping');
      await c.stop();
      logger.info({ component: c.name }, 'component: stopped');
    } catch (err) {
      failed.push(c.name);
      logger.error({ component: c.name, err }, 'component: stop threw, continuing drain');
    }
  }
  return failed;
};
