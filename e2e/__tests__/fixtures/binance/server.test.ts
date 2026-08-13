import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  startBinanceFixtureServer,
  type BinanceFixtureServer,
} from '../../../fixtures/binance/server.js';

let fixtureRoot = '';
let server: BinanceFixtureServer | undefined;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'binance-app-e2e-fixtures-'));
  await mkdir(join(fixtureRoot, 'boot', 'rest'), { recursive: true });
  await writeFile(
    join(fixtureRoot, 'boot', 'rest', 'account.json'),
    JSON.stringify({
      request: { method: 'GET', path: '/api/v3/account', matchQuery: { symbol: 'BTCUSDT' } },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { canTrade: true },
      },
    }),
  );
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(fixtureRoot, { recursive: true, force: true });
});

const unmatchedLog = (): string => join(fixtureRoot, 'unmatched.log');

const start = async (): Promise<BinanceFixtureServer> => {
  server = await startBinanceFixtureServer({
    fixturesRoot: fixtureRoot,
    restScenarios: ['boot'],
    unmatchedLogPath: unmatchedLog(),
  });
  return server;
};

describe('binance fixture server', () => {
  it('refuses to start without the requested scenario', async () => {
    await expect(
      startBinanceFixtureServer({ fixturesRoot: fixtureRoot, restScenarios: ['missing'] }),
    ).rejects.toThrow(/scenario not found/);
  });

  it('serves a fixture whose method, path, and required query all match', async () => {
    const fixture = await start();

    const response = await fetch(`${fixture.restUrl}/api/v3/account?symbol=BTCUSDT&timestamp=1`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ canTrade: true });
    expect(fixture.unmatched).toEqual([]);
  });

  it('records a redacted 501 for traffic no fixture answers, as it happens', async () => {
    const fixture = await start();

    const wrongQuery = await fetch(
      `${fixture.restUrl}/api/v3/account?symbol=ETHUSDT&signature=deadbeef`,
    );
    const wrongPath = await fetch(`${fixture.restUrl}/api/v3/order`, { method: 'POST' });

    expect(wrongQuery.status).toBe(501);
    expect(wrongPath.status).toBe(501);
    expect(fixture.unmatched).toEqual([
      'GET /api/v3/account?symbol=ETHUSDT&signature=[REDACTED]',
      'POST /api/v3/order',
    ]);
    // Readable before any shutdown, so the harness still fails after a kill -9.
    await expect(readFile(unmatchedLog(), 'utf8')).resolves.toBe(
      'GET /api/v3/account?symbol=ETHUSDT&signature=[REDACTED]\nPOST /api/v3/order\n',
    );
  });

  it('refuses a stream upgrade and records it rather than acking a stub', async () => {
    const fixture = await start();

    const socket = new WebSocket(fixture.marketWsUrl);
    await new Promise<void>((resolve) => socket.once('error', () => resolve()));

    expect(fixture.unmatched).toEqual(['WS /market-stream']);
  });

  it('closes idempotently', async () => {
    const fixture = await start();

    await expect(fixture.close()).resolves.toBeUndefined();
    await expect(fixture.close()).resolves.toBeUndefined();
  });
});
