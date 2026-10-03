import {
  createBullMQConnection,
  createDb,
  createPool,
  createRedis,
  repo,
  toAiProviderConfig,
  type Database,
  type ScopedRedis,
} from '@app/db';
import {
  createBinanceRest,
  type BinanceMode,
  type OrderBookDto,
  type ParsedKline,
  type RecentTradeDto,
  type Ticker24hrDto,
} from '@app/binance';
import type { UserId } from '@app/contracts';
import { Queue } from 'bullmq';
import type { Pool } from 'pg';
import type pino from 'pino';
import { createMetricsRegistry, type MetricsRegistry } from '@app/observability';
import { resolveGitSha } from '@app/core/git-sha';
import { createAuth, type Auth } from './auth.js';
import {
  createSecurityRedis,
  createSecurityServices,
  type SecurityServices,
} from './auth/security.js';
import { createWebSocketSessionWatch, type WebSocketSessionWatch } from './ws/session-watch.js';
import type { DiscoveryResult, SingleSignOnConfig } from './auth/single-sign-on.js';
import { createLlm, type LlmAssist } from '@app/llm';
import type { Env } from './env.js';
import { createLogger } from './middleware/logger.js';
import { type NotifyProviderRegistry } from '@app/notify';
import { notifyProviders } from './notifiers.js';
import { strategies } from './strategies.js';
import { type ApiStrategyRegistry } from './strategies/registry.js';

export type Logger = pino.Logger;

/**
 * Read-only Binance market data for the chart endpoint. `/api/v3/klines` is
 * an unsigned public endpoint, so the underlying client carries no
 * credentials; the call is routed to the testnet or live host by the
 * profile's `binanceMode`.
 */
export interface MarketData {
  getKlines(
    mode: BinanceMode,
    params: {
      symbol: string;
      interval: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
  ): Promise<ParsedKline[]>;
  getTicker24hr(mode: BinanceMode, symbol: string): Promise<Ticker24hrDto>;
  getRecentTrades(mode: BinanceMode, symbol: string, limit: number): Promise<RecentTradeDto[]>;
  getDepth(mode: BinanceMode, symbol: string, limit: number): Promise<OrderBookDto>;
}

export interface DI {
  env: Env;
  pool: Pool;
  db: Database;
  redis: ScopedRedis;
  // Control-plane fan-out queue. The pipeline worker consumes
  // {subscribe-profile, unsubscribe-profile, verify-key} jobs and
  // dispatches by `job.name`. NOT a catch-all — adding a job with an
  // unhandled name will route to the pipeline-worker's `default` case
  // and DLQ; producers that need a different queue (e.g. `tick`) MUST
  // use the dedicated Queue handle below.
  queue: Queue;
  // Per-symbol strategy tick queue. The api enqueues a `tick` job for
  // every operator action that should re-evaluate the strategy (manual
  // override, force-buy/sell, lbp put/delete) so the worker's strategy
  // path runs at the operator's chosen moment instead of waiting for
  // the next market-data WS event. Kept on its own Queue because the
  // worker registers a dedicated Worker against the `tick` queue with
  // per-symbol concurrency, separate from the pipeline fan-out worker.
  tickQueue: Queue;
  // Dedicated long-running backtest queue. The api enqueues a `backtest` job
  // (jobId = backtest:<runId>) so a duplicate submit of the same run
  // coalesces; the worker registers a concurrency-1 Worker against it.
  backtestQueue: Queue;
  // Background config-advisor queue, consumed by the worker's study role. The
  // api enqueues an `advisor` job only after the DB row's conditional upsert to
  // `running` succeeds, so that row is the single-flight guard — no jobId
  // coalescing (a stable jobId + retained completed job would silently no-op a
  // regenerate re-add).
  advisorQueue: Queue;
  // Profile-diagnosis queue, consumed by the worker's study role. Unlike the
  // advisor, a stable `jobId` IS correct here: it is the run id, so a duplicate
  // submit of the same run coalesces, and the id is unique per run so a retained
  // completed job can never swallow a later investigation.
  diagnosisQueue: Queue;
  logger: Logger;
  auth: Auth;
  strategies: ApiStrategyRegistry;
  notifyProviders: NotifyProviderRegistry;
  // Per-service Prometheus surface. The `/metrics` route serves its
  // exposition; subsystem middleware registers its own series on
  // `metrics.registry`.
  metrics: MetricsRegistry;
  marketData: MarketData;
  /**
   * Resolve the AI-assist client from the DB-stored provider config, per call.
   * The provider (Anthropic / OpenAI-compatible) is operator-configurable at
   * runtime, so this reads the singleton config row each time rather than binding
   * a client at boot — a provider change in the UI takes effect without a restart.
   */
  resolveLlm: () => Promise<LlmAssist>;
  /** Build SHA of this api process, resolved once at boot. Served on `/status`. */
  gitSha: string;
  /** ISO timestamp this api process booted. Served on `/status`. */
  bootedAt: string;
  /**
   * The sole operator id injected for anonymous requests under `LIVE_DEMO`.
   * Resolved once at boot (the single `users` row) and read by
   * `sessionResolver`; null off-demo or before onboarding. Never per-request.
   */
  demoOperatorId: UserId | null;
  /** The sign-in system: limits, security events, settings, single sign-on state. */
  security: SecurityServices;
  /** Builds a Better Auth instance for the current security state. The boot sequence calls it again after deciding which sign-in methods are usable; see {@link buildAuth}. */
  rebuildAuth: () => Auth;
  /** Open WebSockets and the sessions behind them, so an ended session closes its sockets. */
  websocketSessions: WebSocketSessionWatch;
  shutdown: () => Promise<void>;
}

/** Facts the boot sequence establishes before the DI container exists. */
export interface BootFacts {
  /** The identity provider check, present only when single sign-on is enabled. */
  readonly singleSignOnDiscovery?: DiscoveryResult;
}

/**
 * The single sign-on configuration from the environment, or null when it is off.
 *
 * @param env - Parsed environment.
 * @returns The provider settings the rest of the app reads.
 */
export const singleSignOnConfigFromEnv = (env: Env): SingleSignOnConfig | null =>
  env.SINGLE_SIGN_ON_ENABLED &&
  env.SINGLE_SIGN_ON_ISSUER_URL !== undefined &&
  env.SINGLE_SIGN_ON_CLIENT_ID !== undefined &&
  env.SINGLE_SIGN_ON_CLIENT_SECRET !== undefined
    ? {
        issuer: env.SINGLE_SIGN_ON_ISSUER_URL,
        clientId: env.SINGLE_SIGN_ON_CLIENT_ID,
        clientSecret: env.SINGLE_SIGN_ON_CLIENT_SECRET,
        buttonLabel: env.SINGLE_SIGN_ON_BUTTON_LABEL,
      }
    : null;

/**
 * Builds the Better Auth instance from the environment and the current security state.
 *
 * The single sign-on provider is registered only when its discovery document passed the boot check, so Better Auth never runs its own unbounded discovery fetch against a provider already known to be unreachable. Password sign-in follows the security state, which the boot guard may have forced on.
 *
 * @param env - Parsed environment.
 * @param db - Database handle.
 * @param logger - Logger.
 * @param security - The sign-in services and their resolved state.
 * @param discoveryUrl - The discovery URL that passed the boot check, when single sign-on is available.
 * @returns The Better Auth instance.
 */
export const buildAuth = (
  env: Env,
  db: Database,
  logger: Logger,
  security: SecurityServices,
  discoveryUrl: string | undefined,
): Auth =>
  createAuth({
    db,
    webOrigins: env.WEB_ORIGIN,
    authSecret: env.AUTH_SECRET,
    isProduction: env.NODE_ENV === 'production',
    logger,
    // Passed only while the flag is on, so `MCP_ENABLED=0` leaves the authorization server unregistered rather than mounted and unused.
    ...(env.MCP_ENABLED && env.MCP_RESOURCE_URL !== undefined
      ? { mcpResource: env.MCP_RESOURCE_URL }
      : {}),
    ...(env.PUBLIC_BASE_URL !== undefined ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
    passwordSignIn: security.passwordSignIn,
    ...(security.singleSignOn !== null &&
    security.singleSignOnAvailable &&
    discoveryUrl !== undefined
      ? { singleSignOn: { ...security.singleSignOn, discoveryUrl } }
      : {}),
    // Read uncached: the reset command bumps the epoch from another process, and a session stamped from a cached value would be ended as invalidated once the cache caught up.
    securityEpoch: async () => (await repo.authSecuritySettings.get(db)).securityEpoch,
    events: security.events,
  });

/**
 * Boot guard for `LIVE_DEMO`: a demo box holds testnet keys only, so refuse to
 * start if the flag is on and any account is on the live Binance environment.
 */
export const assertLiveDemoInvariant = async (
  db: Database,
  opts: { liveDemo: boolean },
): Promise<void> => {
  if (!opts.liveDemo) return;
  if (await repo.accounts.anyLiveMode(db)) {
    throw new Error(
      'LIVE_DEMO refuses to boot: an account is configured for the live Binance environment. A demo deployment must hold testnet keys only.',
    );
  }
};

export const createDI = (env: Env, facts: BootFacts = {}): DI => {
  const pool = createPool({ kind: 'api', connectionString: env.DATABASE_URL });
  const db = createDb(pool);
  const redis = createRedis(env.REDIS_URL);
  const queue = new Queue('pipeline', {
    connection: createBullMQConnection({ url: env.REDIS_URL }),
  });
  const tickQueue = new Queue('tick', {
    connection: createBullMQConnection({ url: env.REDIS_URL }),
  });
  const backtestQueue = new Queue('backtest', {
    connection: createBullMQConnection({ url: env.REDIS_URL }),
  });
  const advisorQueue = new Queue('advisor', {
    connection: createBullMQConnection({ url: env.REDIS_URL }),
  });
  const diagnosisQueue = new Queue('profile-diagnosis', {
    connection: createBullMQConnection({ url: env.REDIS_URL }),
  });
  const logger = createLogger({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' });
  const metrics = createMetricsRegistry({ service: 'api' });
  // Its own fail-fast connection: on the shared one a Redis outage would hold every request in the flood limit for ioredis's whole retry budget before the in-process fallback answered.
  const securityRedis = createSecurityRedis(env.REDIS_URL);
  const security = createSecurityServices({
    db,
    redis: securityRedis,
    queue,
    logger,
    registry: metrics.registry,
    secret: env.AUTH_SECRET,
    singleSignOn: singleSignOnConfigFromEnv(env),
    passwordSignIn: env.PASSWORD_SIGN_IN_ENABLED,
  });
  const discovery = facts.singleSignOnDiscovery;
  security.singleSignOnAvailable = security.singleSignOn !== null && discovery?.ok === true;
  if (security.singleSignOn !== null)
    security.metrics.singleSignOnAvailable.set(security.singleSignOnAvailable ? 1 : 0);
  const discoveryUrl = discovery?.ok === true ? discovery.discoveryUrl : undefined;
  const rebuildAuth = (): Auth => buildAuth(env, db, logger, security, discoveryUrl);
  const auth = rebuildAuth();
  const websocketSessions = createWebSocketSessionWatch({
    db,
    subscriber: redis.raw().duplicate(),
    security,
    logger,
  });
  // One keyless REST client per Binance host. Klines is unsigned, and the client
  // attaches the key to signed calls only, so empty credentials never reach the
  // wire here. Built once at boot rather than per request.
  const emptyCredentials = { apiKey: '', secretKey: '' };
  const binanceByMode: Record<BinanceMode, ReturnType<typeof createBinanceRest>> = {
    test: createBinanceRest({ mode: 'test', credentials: emptyCredentials }),
    live: createBinanceRest({ mode: 'live', credentials: emptyCredentials }),
  };
  const marketData: MarketData = {
    getKlines: (mode, params) => binanceByMode[mode].getKlines(params),
    getTicker24hr: (mode, symbol) => binanceByMode[mode].getTicker24hr(symbol),
    getRecentTrades: (mode, symbol, limit) => binanceByMode[mode].getRecentTrades(symbol, limit),
    getDepth: (mode, symbol, limit) => binanceByMode[mode].getDepth(symbol, limit),
  };
  const resolveLlm = async (): Promise<LlmAssist> =>
    createLlm(toAiProviderConfig(await repo.aiProviderConfig.get(db)));
  // Resolved once at boot: empty GIT_SHA (dev build) degrades to the local git
  // SHA, then to 'unknown'. bootedAt anchors the migration-skew check on /status.
  const gitSha = resolveGitSha(env.GIT_SHA || undefined);
  const bootedAt = new Date().toISOString();
  const shutdown = async (): Promise<void> => {
    await websocketSessions.stop();
    await queue.close();
    await tickQueue.close();
    await backtestQueue.close();
    await advisorQueue.close();
    await diagnosisQueue.close();
    // With no offline queue, QUIT is refused outright while Redis is down; dropping the socket keeps the rest of shutdown running.
    await securityRedis.quit().catch(() => securityRedis.disconnect());
    await redis.quit();
    await pool.end();
  };
  return {
    env,
    pool,
    db,
    redis,
    queue,
    tickQueue,
    backtestQueue,
    advisorQueue,
    diagnosisQueue,
    logger,
    auth,
    strategies,
    notifyProviders,
    metrics,
    marketData,
    resolveLlm,
    gitSha,
    bootedAt,
    // Resolved in boot() once LIVE_DEMO is known and the DB is reachable.
    demoOperatorId: null,
    security,
    rebuildAuth,
    websocketSessions,
    shutdown,
  };
};
