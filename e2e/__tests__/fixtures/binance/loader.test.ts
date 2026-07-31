// Unit tests for the Binance fixture loader. REST assertions drive
// `globalThis.fetch` — that's both what the loader patches and what
// production code calls, so the test path matches production exactly.

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mountBinanceFixtures, type MountedFixtures } from '../../../fixtures/binance/loader.js';

interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

const fetchJson = async (url: string, method = 'GET'): Promise<HttpResult> => {
  const res = await fetch(url, { method });
  const raw = await res.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // leave as raw string
  }
  return { status: res.status, headers: res.headers, body };
};

const collectWsFrames = (url: string, expected: number): Promise<unknown[]> =>
  new Promise<unknown[]>((resolve, reject) => {
    const out: unknown[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout waiting for ${expected} frames (got ${out.length})`));
    }, 2000);
    ws.on('message', (data: WebSocket.RawData) => {
      out.push(JSON.parse(data.toString('utf8')));
      if (out.length >= expected) {
        clearTimeout(timer);
        ws.close();
        resolve(out);
      }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

let mounted: MountedFixtures | undefined;

afterEach(async () => {
  if (mounted) {
    await mounted.dispose();
    mounted = undefined;
  }
});

describe('mountBinanceFixtures — REST', () => {
  it('mounts account-info on testnet host and replays GET /api/v3/account', async () => {
    mounted = await mountBinanceFixtures('account-info');
    expect(mounted.restFixtures).toHaveLength(1);
    expect(mounted.wsUrl).toBeUndefined();

    const res = await fetchJson(
      'https://testnet.binance.vision/api/v3/account?timestamp=1&signature=x',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mbx-used-weight-1m')).toBe('20');
    const body = res.body as { canTrade: boolean; balances: { asset: string }[] };
    expect(body.canTrade).toBe(true);
    expect(body.balances.map((b) => b.asset)).toContain('USDT');
  });

  it('mounts exchange-info and returns BTCUSDT + ETHUSDT TRADING entries', async () => {
    mounted = await mountBinanceFixtures('exchange-info');
    const res = await fetchJson('https://testnet.binance.vision/api/v3/exchangeInfo');
    expect(res.status).toBe(200);
    const body = res.body as { symbols: { symbol: string; status: string }[] };
    const traded = body.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol);
    expect(traded).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('mounts order-place and replays POST /api/v3/order as NEW', async () => {
    mounted = await mountBinanceFixtures('order-place');
    const res = await fetchJson(
      'https://testnet.binance.vision/api/v3/order?timestamp=1&signature=x',
      'POST',
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string; orderId: number; clientOrderId: string };
    expect(body.status).toBe('NEW');
    expect(body.orderId).toBe(28);
    expect(body.clientOrderId).toBe('fixture-limit-buy-1');
  });

  it('mounts order-status and replays GET /api/v3/order as FILLED', async () => {
    mounted = await mountBinanceFixtures('order-status');
    const res = await fetchJson(
      'https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT&orderId=28&timestamp=1&signature=x',
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string; executedQty: string };
    expect(body.status).toBe('FILLED');
    expect(body.executedQty).toBe('0.00100000');
  });

  it('binds to live host when mode=live', async () => {
    mounted = await mountBinanceFixtures('account-info', { mode: 'live' });
    const res = await fetchJson('https://api.binance.com/api/v3/account?timestamp=1&signature=x');
    expect(res.status).toBe(200);
  });

  it('replays the same endpoint multiple times without exhausting the interceptor', async () => {
    mounted = await mountBinanceFixtures('account-info');
    const a = await fetchJson(
      'https://testnet.binance.vision/api/v3/account?timestamp=1&signature=x',
    );
    const b = await fetchJson(
      'https://testnet.binance.vision/api/v3/account?timestamp=2&signature=y',
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it('throws on unmatched call to an intercepted host so missing fixtures are loud', async () => {
    mounted = await mountBinanceFixtures('account-info');
    await expect(fetchJson('https://testnet.binance.vision/api/v3/exchangeInfo')).rejects.toThrow(
      /no fixture matched/,
    );
  });
});

describe('mountBinanceFixtures — WS', () => {
  it('replays execution-report-filled frames in order', async () => {
    mounted = await mountBinanceFixtures('execution-report-filled');
    expect(mounted.restFixtures).toHaveLength(0);
    expect(mounted.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const wsUrl = mounted.wsUrl;
    if (wsUrl === undefined) throw new Error('expected wsUrl to be defined');

    const frames = (await collectWsFrames(wsUrl, 3)) as {
      e: string;
      X: string;
    }[];
    expect(frames.map((f) => f.X)).toEqual(['NEW', 'PARTIALLY_FILLED', 'FILLED']);
    expect(frames.every((f) => f.e === 'executionReport')).toBe(true);
  });

  it('replays account-update frames in order', async () => {
    mounted = await mountBinanceFixtures('account-update');
    const wsUrl = mounted.wsUrl;
    if (wsUrl === undefined) throw new Error('expected wsUrl to be defined');
    const frames = (await collectWsFrames(wsUrl, 2)) as { e: string }[];
    expect(frames.map((f) => f.e)).toEqual(['outboundAccountPosition', 'balanceUpdate']);
  });

  it('seals Binance hosts even when the scenario has no REST fixtures', async () => {
    mounted = await mountBinanceFixtures('account-update');
    expect(mounted.restFixtures).toHaveLength(0);
    await expect(
      fetchJson('https://testnet.binance.vision/api/v3/account?timestamp=1&signature=x'),
    ).rejects.toThrow(/no fixture matched/);
  });
});

describe('mountBinanceFixtures — errors and disposal', () => {
  it('throws when the scenario directory does not exist', async () => {
    await expect(mountBinanceFixtures('not-a-real-scenario')).rejects.toThrow(
      /scenario directory not found/,
    );
  });

  it('refuses a second mount while one is still active', async () => {
    mounted = await mountBinanceFixtures('account-info');
    await expect(mountBinanceFixtures('exchange-info')).rejects.toThrow(
      /a previous mount is still active/,
    );
  });

  it('is idempotent: calling dispose twice does not throw', async () => {
    const handle = await mountBinanceFixtures('account-info');
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it('throws when fixturesRoot is wrong and the scenario cannot be located', async () => {
    await expect(
      mountBinanceFixtures('account-info', { fixturesRoot: '/tmp/does-not-exist-xyz' }),
    ).rejects.toThrow(/scenario directory not found/);
  });

  it('restores globalThis.fetch on dispose so unrelated calls pass through', async () => {
    const originalFetch = globalThis.fetch;
    const first = await mountBinanceFixtures('account-info');
    expect(globalThis.fetch).not.toBe(originalFetch);
    await first.dispose();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('closes the WS server on dispose', async () => {
    const handle = await mountBinanceFixtures('account-update');
    const url = handle.wsUrl;
    if (url === undefined) throw new Error('expected wsUrl to be defined');
    await handle.dispose();

    // Connecting to the now-closed server must fail.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('expected connection to fail after dispose'));
      }, 1000);
      ws.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error('expected connection refused after dispose, got open'));
      });
    });
  });
});
