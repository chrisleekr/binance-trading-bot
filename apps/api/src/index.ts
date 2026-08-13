import { bootstrapEnv } from '@app/core/env';

bootstrapEnv(import.meta.url);

import { repo } from '@app/db';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { assertLiveDemoInvariant, createDI } from './di.js';
import { loadEnv, publicListenerHostname, type Env } from './env.js';
import { startWsRegistry, type WsRegistry } from './ws/registry.js';
import { installGracefulShutdown } from '@app/core/shutdown';

export interface ApiHandle {
  shutdown: () => Promise<void>;
}

// Start the api listeners and return a shutdown handle. Registers NO signal
// handlers and never exits the process — the caller (the standalone entry
// below, or apps/server composing this with the worker in ROLE=all) owns
// signal wiring via installGracefulShutdown, so two boots in one process cannot
// each race a process.exit.
export const boot = async (env: Env): Promise<ApiHandle> => {
  const di = createDI(env);
  // A LIVE_DEMO box holds testnet keys only — refuse to start on a live key.
  await assertLiveDemoInvariant(di.db, { liveDemo: env.LIVE_DEMO });
  // Resolve the demo operator once so sessionResolver can inject it for every
  // anonymous request. Null before onboarding, which keeps /onboarding working.
  if (env.LIVE_DEMO) di.demoOperatorId = await repo.users.findSingleId(di.db);
  const { app, health, websocket } = createApp(di);

  const hostname = publicListenerHostname();
  const server = Bun.serve({
    port: env.PORT,
    ...(hostname ? { hostname } : {}),
    // Keep-alive sockets sit idle between the SPA's requests. Bun's short default
    // HTTP idleTimeout closes those mid-flight, surfacing as `ECONNRESET`/"socket
    // hang up". 120s (matching the websocket idleTimeout) is a deliberate
    // keep-alive window, not a workaround. Max is 255s.
    idleTimeout: 120,
    fetch: app.fetch,
    websocket: { ...websocket, idleTimeout: 120, sendPings: true, perMessageDeflate: false },
  });

  // Admin server on ADMIN_PORT — exposes /healthz, /readyz, /metrics with NO
  // auth. Binds ADMIN_HOST, default 127.0.0.1 so under compose it is never
  // reachable from the LAN (HEALTHCHECK + Prometheus use in-container DNS); k8s
  // sets 0.0.0.0 because the kubelet probes the pod IP; restrict the exposed
  // port with a default-deny ingress NetworkPolicy (a Service is not a
  // firewall, and pod IPs are reachable cluster-wide by default). Sharing
  // health.router with the main app means markShutdown() flips both surfaces
  // in one call.
  const adminServer = Bun.serve({
    port: env.ADMIN_PORT,
    hostname: env.ADMIN_HOST,
    fetch: health.router.fetch,
  });

  let registry: WsRegistry | null = null;
  try {
    registry = startWsRegistry(env.REDIS_URL, server, di.logger);
  } catch (err) {
    di.logger.error({ err }, 'ws_registry_start_failed');
  }

  const shutdown = async (): Promise<void> => {
    health.markShutdown();
    server.stop();
    adminServer.stop();
    if (registry) await registry.stop();
    await di.shutdown();
  };

  di.logger.info(
    {
      port: env.PORT,
      adminPort: env.ADMIN_PORT,
      sha: di.gitSha,
    },
    'api_listening',
  );

  return { shutdown };
};

if (import.meta.main) {
  const { shutdown } = await boot(loadEnv());
  installGracefulShutdown([shutdown]);
}

// `createAuth` is exported for out-of-band operator tooling (the dev seeder
// creates the first operator through it) so a password hash is never written by
// anything other than Better Auth itself.
export { createApp, createAuth, createDI, loadEnv };
