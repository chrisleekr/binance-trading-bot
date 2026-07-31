// Loader for the deterministic Binance fixture set consumed by e2e and
// integration suites. Mounts REST conversations by patching
// `globalThis.fetch` and replays WS user-stream frames from a local
// `ws` server.
//
// The fetch patch is intentionally minimal (~30 lines) rather than going
// through `nock` / `@mswjs/interceptors`: the latter ship a Node
// http-module-patching layer that crashes on Bun-on-Alpine with
// `TypeError: Attempted to assign to readonly property` inside their
// ClientRequest shim. The fixture files (`<scenario>/{rest,ws}/...`)
// stay the portable artefact — any consumer that prefers nock's
// assertion API can still load the same JSON files and feed them into
// nock themselves.

import { readdir, readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsClient } from 'ws';

/**
 * Selects which Binance host the REST interceptors are bound to. Mirrors
 * the runtime mode in `packages/binance` so a fixture mounted under `test`
 * cannot accidentally intercept calls a `live`-mode client makes.
 */
export type BinanceMode = 'live' | 'test';

const HOSTS: Readonly<Record<BinanceMode, string>> = {
  live: 'https://api.binance.com',
  test: 'https://testnet.binance.vision',
};

/**
 * Shape of a single REST fixture file. One file = one (method, path)
 * conversation; the loader registers a matcher per file. `matchQuery`
 * is intentionally `"any"` by default because Binance private requests
 * carry signed `timestamp`/`signature` query parameters that vary every
 * call — matching them strictly would make every test brittle.
 */
export interface RestFixture {
  readonly name: string;
  readonly request: {
    readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    readonly path: string;
    readonly matchQuery: 'any' | Readonly<Record<string, string>>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
}

/**
 * One WS frame to send to the connected client. `delayMs` is the wait
 * before this frame fires, applied serially — so a sequence of three
 * frames with delays `[0, 10, 10]` lands at roughly t+0, t+10, t+20 ms
 * relative to the connection opening.
 */
export interface WsFrame {
  readonly delayMs: number;
  readonly data: unknown;
}

/**
 * Caller-facing options. `mode` picks the Binance host being intercepted.
 * `fixturesRoot` is exposed so consumer repos can point at a snapshot
 * elsewhere on disk without symlink gymnastics; defaults to this loader's
 * own directory so the package is self-contained for normal use.
 */
export interface MountOptions {
  readonly mode?: BinanceMode;
  readonly fixturesRoot?: string;
}

/**
 * Handle returned to the caller. Exposes the loaded fixtures (so the
 * test can introspect what was mounted) and the local WS URL (so the
 * system under test can be pointed at the replayer). `dispose()` is
 * mandatory: the loader patches `globalThis.fetch` and binds a local
 * port for the duration of the mount, and `dispose()` is the only way
 * to give them back.
 */
export interface MountedFixtures {
  readonly restFixtures: readonly RestFixture[];
  readonly wsUrl: string | undefined;
  dispose(): Promise<void>;
}

const DEFAULT_FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));

const dirExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

const loadRestFixtures = async (dir: string): Promise<readonly RestFixture[]> => {
  if (!(await dirExists(dir))) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: RestFixture[] = [];
  for (const file of files) out.push(await readJson<RestFixture>(join(dir, file)));
  return out;
};

const loadWsFrames = async (dir: string): Promise<readonly WsFrame[]> => {
  if (!(await dirExists(dir))) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const out: WsFrame[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.push(JSON.parse(trimmed) as WsFrame);
    }
  }
  return out;
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface RestMatcher {
  readonly fixture: RestFixture;
  readonly host: string;
}

type FetchInput = string | URL | Request;

const requestMethod = (input: FetchInput, init: RequestInit | undefined): string => {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (typeof input === 'string' || input instanceof URL) return 'GET';
  return (input.method ?? 'GET').toUpperCase();
};

const requestUrl = (input: FetchInput): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const queryMatches = (
  matcher: 'any' | Readonly<Record<string, string>>,
  search: URLSearchParams,
): boolean => {
  if (matcher === 'any') return true;
  for (const [k, v] of Object.entries(matcher)) {
    if (search.get(k) !== v) return false;
  }
  return true;
};

const buildFetchInterceptor = (
  matchers: readonly RestMatcher[],
  passthrough: typeof globalThis.fetch,
): typeof globalThis.fetch => {
  // The wrapper seals ALL Binance hosts (both `live` and `test`) regardless of
  // which `mode` the mount targets, so WS-only scenarios still surface as
  // "no fixture matched" instead of leaking to the real API. Any non-Binance
  // origin falls through to the original fetch so unrelated code keeps
  // working.
  const interceptedHosts = new Set<string>(Object.values(HOSTS));
  const wrapped = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = new URL(requestUrl(input));
    const origin = `${url.protocol}//${url.host}`;
    if (!interceptedHosts.has(origin)) return passthrough(input, init);
    const method = requestMethod(input, init);
    for (const m of matchers) {
      if (m.host !== origin) continue;
      if (m.fixture.request.method !== method) continue;
      if (m.fixture.request.path !== url.pathname) continue;
      if (!queryMatches(m.fixture.request.matchQuery, url.searchParams)) continue;
      return new Response(JSON.stringify(m.fixture.response.body), {
        status: m.fixture.response.status,
        headers: { ...m.fixture.response.headers },
      });
    }
    throw new Error(
      `mountBinanceFixtures: no fixture matched ${method} ${url.toString()} (host=${origin})`,
    );
  };
  // Bun's `typeof fetch` carries an optional `preconnect` companion. The
  // type declares it required, but at runtime it's only present on Bun
  // itself — copy it across when it exists so the wrapper still
  // satisfies the platform's fetch shape, and cast through `unknown`
  // when it doesn't (Node-style fetch with no `preconnect`).
  const preconnect = (passthrough as { preconnect?: typeof globalThis.fetch.preconnect })
    .preconnect;
  if (preconnect !== undefined) {
    return Object.assign(wrapped, {
      preconnect: preconnect.bind(passthrough),
    }) as typeof globalThis.fetch;
  }
  return wrapped as unknown as typeof globalThis.fetch;
};

interface WsHandle {
  readonly url: string;
  close(): Promise<void>;
}

const startWsServer = async (frames: readonly WsFrame[]): Promise<WsHandle> => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const replays = new Set<Promise<void>>();
  let aborted = false;

  server.on('connection', (socket: WsClient) => {
    const replay = (async () => {
      for (const frame of frames) {
        if (aborted) return;
        if (frame.delayMs > 0) await sleep(frame.delayMs);
        if (aborted || socket.readyState !== socket.OPEN) return;
        try {
          socket.send(JSON.stringify(frame.data));
        } catch {
          // Socket was closed mid-replay (typically by dispose's terminate()).
          return;
        }
      }
    })();
    replays.add(replay);
    void replay.finally(() => replays.delete(replay));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('mountBinanceFixtures: WS server failed to bind to a numeric port');
  }
  const port = (addr as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    // Shutdown order: set `aborted` so in-flight replays short-circuit,
    // force-terminate connected clients, then close the listener. The
    // `server.close()` callback never fires on some runtimes (observed on
    // Bun-on-Alpine in CI — `afterEach` hung for the full 10s vitest hook
    // timeout) so it's capped at 1s; after that the listener will be
    // garbage-collected with the rest of the handle. Final
    // `Promise.allSettled` drains any replay timers that were pending when
    // `aborted` flipped.
    close: async () => {
      aborted = true;
      for (const client of server.clients) client.terminate();
      await Promise.race([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        }),
      ]);
      await Promise.allSettled([...replays]);
    },
  };
};

let activeMount: symbol | undefined;

/**
 * Loads `<fixturesRoot>/<scenario>/{rest,ws}/...` and mounts them. REST
 * fixtures patch `globalThis.fetch` for calls to the Binance host of
 * the chosen mode; WS frames are served from a fresh local `ws` server
 * bound to an ephemeral 127.0.0.1 port. The caller MUST call
 * `dispose()` on the returned handle — the loader owns the fetch global
 * for the duration of the mount and the WS port until then.
 *
 * Throws if the scenario directory is missing or contains no fixtures,
 * so a typo in the scenario name surfaces immediately instead of
 * leaving a silently-empty mock.
 */
export const mountBinanceFixtures = async (
  scenario: string,
  opts: MountOptions = {},
): Promise<MountedFixtures> => {
  if (activeMount !== undefined) {
    throw new Error(
      'mountBinanceFixtures: a previous mount is still active; call dispose() on it before mounting again',
    );
  }
  const myMount = Symbol('binance-fixture-mount');
  activeMount = myMount;

  try {
    const mode: BinanceMode = opts.mode ?? 'test';
    const root = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
    const scenarioDir = join(root, scenario);
    if (!(await dirExists(scenarioDir))) {
      throw new Error(`mountBinanceFixtures: scenario directory not found: ${scenarioDir}`);
    }

    const [restFixtures, wsFrames] = await Promise.all([
      loadRestFixtures(join(scenarioDir, 'rest')),
      loadWsFrames(join(scenarioDir, 'ws')),
    ]);

    if (restFixtures.length === 0 && wsFrames.length === 0) {
      throw new Error(
        `mountBinanceFixtures: scenario "${scenario}" has neither rest/*.json nor ws/*.jsonl files`,
      );
    }

    const host = HOSTS[mode];
    const matchers: readonly RestMatcher[] = restFixtures.map((fixture) => ({ fixture, host }));

    // Snapshot the original fetch so dispose can put it back exactly as it
    // was — we never blanket-restore the platform default, in case an outer
    // harness installed its own fetch wrapper before us. The patch is
    // installed unconditionally (even on WS-only scenarios with zero REST
    // fixtures) so accidental Binance HTTP calls cannot leak to the real
    // API on any code path.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildFetchInterceptor(matchers, originalFetch);
    // Track installation so the catch-block + dispose can undo cleanly even
    // if a future change makes the patch conditional again.
    let fetchPatched = true;
    const restoreFetch = (): void => {
      if (fetchPatched) {
        globalThis.fetch = originalFetch;
        fetchPatched = false;
      }
    };

    let ws: WsHandle | undefined;
    try {
      if (wsFrames.length > 0) ws = await startWsServer(wsFrames);
    } catch (wsErr) {
      // WS startup failed AFTER the fetch patch was installed; revert the
      // patch before propagating so the global state isn't left polluted.
      restoreFetch();
      throw wsErr;
    }

    let disposed = false;
    return {
      restFixtures,
      wsUrl: ws?.url,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        if (activeMount === myMount) activeMount = undefined;
        restoreFetch();
        if (ws) await ws.close();
      },
    };
  } catch (err) {
    if (activeMount === myMount) activeMount = undefined;
    throw err;
  }
};
