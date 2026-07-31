// Unified process entrypoint. One image, one entry; ROLE selects behaviour.
//
//   ROLE=api    -> api listeners only (also serves the built SPA)
//   ROLE=worker -> live trading consumers only
//   ROLE=study  -> backtest + advisor consumers only
//   ROLE=all    -> all of the above in ONE process (single-box default)
//
// Each boot() returns a shutdown handle and registers no signal handlers; this
// entry installs one graceful-shutdown handler over every started component, so
// ROLE=all cannot race two process.exit calls on a single SIGTERM.

import { bootstrapEnv } from '@app/core/env';

bootstrapEnv(import.meta.url);

import { parseRole, runsApi, runsLive, runsStudy } from '@app/core/role';
import { installGracefulShutdown } from '@app/core/shutdown';
import { boot as apiBoot, loadEnv as loadApiEnv } from '@app/api';
import { boot as workerBoot, toBootEnv, loadWorkerEnv } from '@app/worker';
import { assertDistinctPorts } from './ports.js';

const role = parseRole(process.env['ROLE']);

// Load only the env each selected role needs, so ROLE=study never demands the
// api's AUTH_SECRET / WEB_ORIGIN (validation is role-conditional by dispatch,
// not by a merged schema).
const apiEnv = runsApi(role) ? loadApiEnv() : null;
const workerEnv = runsLive(role) || runsStudy(role) ? loadWorkerEnv() : null;

if (apiEnv && workerEnv) {
  assertDistinctPorts([apiEnv.PORT, apiEnv.ADMIN_PORT, workerEnv.WORKER_ADMIN_PORT]);
}

// Install the signal handler over the (mutable) shutdowns array BEFORE booting,
// so a SIGTERM arriving mid-boot (api already listening while the worker is
// still opening streams/pools) still drains whatever has started rather than
// hard-exiting with no drain. The handler reads the array at signal time.
const shutdowns: Array<() => Promise<void>> = [];
installGracefulShutdown(shutdowns);

if (apiEnv) {
  const { shutdown } = await apiBoot(apiEnv);
  shutdowns.push(shutdown);
}
if (workerEnv) {
  const { shutdown } = await workerBoot(toBootEnv(workerEnv));
  shutdowns.push(shutdown);
}
