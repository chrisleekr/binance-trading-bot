// Graceful-shutdown signal wiring, shared by every process entrypoint.
//
// A boot() returns its own `shutdown` and does NOT touch signals or exit the
// process. The caller (a standalone app entry, or apps/server composing several
// boots in one process) installs ONE set of handlers here. This matters for
// ROLE=all: two boots in one process must not each register a handler that
// calls process.exit — the first to fire would kill the process mid-drain.
//
// On SIGTERM/SIGINT every shutdown runs (allSettled, so one stuck drain cannot
// starve the others), then the process exits honouring any process.exitCode a
// shutdown set (e.g. the worker sets 1 on stop failures) — so process.exit()
// with no argument, never process.exit(0).

export const installGracefulShutdown = (shutdowns: ReadonlyArray<() => Promise<void>>): void => {
  let started = false;
  const run = async (): Promise<void> => {
    if (started) return;
    started = true;
    await Promise.allSettled(shutdowns.map((s) => s()));
    process.exit();
  };
  process.once('SIGTERM', () => void run());
  process.once('SIGINT', () => void run());
};
