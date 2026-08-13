import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RestFixture {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly matchQuery: 'any' | Readonly<Record<string, string>>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
}

export interface StartBinanceFixtureServerOptions {
  readonly fixturesRoot?: string;
  readonly restScenarios: readonly string[];
  /** Where to mirror `unmatched` for a reader that outlives this process. */
  readonly unmatchedLogPath?: string;
}

export interface BinanceFixtureServer {
  readonly restUrl: string;
  readonly marketWsUrl: string;
  readonly userWsUrl: string;
  /**
   * Binance traffic the app made that this server does not answer. REST calls
   * get a 501 the app may swallow into a degraded-but-passing journey, and a
   * stream upgrade is unanswerable by design, so the harness fails the lane on
   * a non-empty list rather than trusting the green test.
   */
  readonly unmatched: readonly string[];
  close(): Promise<void>;
}

const DEFAULT_FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));
const SENSITIVE_QUERY = /(?:api|key|secret|signature|token|listen)/i;

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const loadRest = async (root: string, scenarios: readonly string[]): Promise<RestFixture[]> => {
  const fixtures: RestFixture[] = [];
  for (const scenario of scenarios) {
    const directory = join(root, scenario, 'rest');
    if (!(await directoryExists(directory))) {
      throw new Error(`fixture REST scenario not found: ${scenario}`);
    }
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()) {
      fixtures.push(JSON.parse(await readFile(join(directory, file), 'utf8')) as RestFixture);
    }
  }
  if (fixtures.length === 0) throw new Error('fixture server requires at least one REST fixture');
  return fixtures;
};

const queryMatches = (
  expected: 'any' | Readonly<Record<string, string>>,
  actual: URLSearchParams,
): boolean =>
  expected === 'any' || Object.entries(expected).every(([key, value]) => actual.get(key) === value);

/** Signed Binance calls carry the API key and HMAC in the query string. */
const redactedRequest = (method: string, url: URL): string => {
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => `${key}=${SENSITIVE_QUERY.test(key) ? '[REDACTED]' : value}`)
    .join('&');
  return `${method} ${url.pathname}${query ? `?${query}` : ''}`;
};

export const startBinanceFixtureServer = async (
  options: StartBinanceFixtureServerOptions,
): Promise<BinanceFixtureServer> => {
  const restFixtures = await loadRest(
    options.fixturesRoot ?? DEFAULT_FIXTURES_ROOT,
    options.restScenarios,
  );
  const unmatched: string[] = [];
  const record = (entry: string): void => {
    unmatched.push(entry);
    // Written where it happens, not on shutdown: the harness kills this process,
    // and a verdict still buffered in memory at that point would be lost exactly
    // when the lane is supposed to fail.
    if (options.unmatchedLogPath) appendFileSync(options.unmatchedLogPath, `${entry}\n`);
  };

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const method = request.method?.toUpperCase() ?? 'GET';
    const fixture = restFixtures.find(
      (candidate) =>
        candidate.request.method === method &&
        candidate.request.path === url.pathname &&
        queryMatches(candidate.request.matchQuery, url.searchParams),
    );
    if (!fixture) {
      record(redactedRequest(method, url));
      response.writeHead(501, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unmatched fixture traffic' }));
      return;
    }
    response.writeHead(fixture.response.status, { ...fixture.response.headers });
    response.end(JSON.stringify(fixture.response.body));
  });

  // The P0 journey seeds every profile disabled, so the worker subscribes to no
  // symbol and opens no account stream: nothing here should ever upgrade. A stub
  // that acked one would hide the day that stops being true, so an upgrade is
  // recorded as unmatched traffic and the connection refused.
  http.on('upgrade', (request: IncomingMessage, socket) => {
    const { pathname } = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? '127.0.0.1'}`,
    );
    record(`WS ${pathname}`);
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve);
    http.once('error', reject);
    http.listen(0, '127.0.0.1');
  });
  const { port } = http.address() as AddressInfo;
  let closed = false;
  return {
    restUrl: `http://127.0.0.1:${port}`,
    // Published because the endpoint override is all-or-nothing: the app refuses
    // a partial override, so the stream URLs have to resolve somewhere.
    marketWsUrl: `ws://127.0.0.1:${port}/market-stream`,
    userWsUrl: `ws://127.0.0.1:${port}/user-stream`,
    unmatched,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};

// Returns while the server is still listening: the open handle keeps the
// process alive until the harness kills it.
const runCli = async (): Promise<void> => {
  const manifestPath = process.env['BINANCE_FIXTURE_MANIFEST_PATH'];
  const unmatchedLogPath = process.env['BINANCE_FIXTURE_UNMATCHED_PATH'];
  if (!manifestPath || !unmatchedLogPath) {
    throw new Error(
      'BINANCE_FIXTURE_MANIFEST_PATH and BINANCE_FIXTURE_UNMATCHED_PATH are required',
    );
  }
  const server = await startBinanceFixtureServer({
    restScenarios: ['exchange-info', 'app-e2e-boot'],
    unmatchedLogPath,
  });
  // Shell-sourceable, the same channel the seed manifest uses.
  await writeFile(
    manifestPath,
    [
      `export BINANCE_REST_URL=${JSON.stringify(server.restUrl)}`,
      `export BINANCE_MARKET_WS_URL=${JSON.stringify(server.marketWsUrl)}`,
      `export BINANCE_USER_WS_URL=${JSON.stringify(server.userWsUrl)}`,
      '',
    ].join('\n'),
  );
};

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
