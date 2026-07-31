// In ROLE=all the api and the worker run in one process, and each binds its own
// admin server. Their three ports (api PORT, api ADMIN_PORT, worker
// WORKER_ADMIN_PORT) must be distinct or the second bind crashes at runtime
// with EADDRINUSE. The api env refine already guarantees PORT !== ADMIN_PORT
// inside the api; this covers the collapsed cross-service case, surfaced at
// startup as a clear message rather than a mid-boot bind failure.
export const assertDistinctPorts = (ports: readonly number[]): void => {
  if (new Set(ports).size !== ports.length) {
    throw new Error(
      `ROLE=all requires distinct ports; got PORT/ADMIN_PORT/WORKER_ADMIN_PORT = ${ports.join(', ')}`,
    );
  }
};
