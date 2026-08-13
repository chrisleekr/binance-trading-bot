import { describe, expect, it } from 'vitest';

import { resolveBinanceEndpoints } from '../src/endpoints.js';

const OVERRIDES = {
  NODE_ENV: 'test',
  APP_E2E: '1',
  BINANCE_REST_URL: 'http://127.0.0.1:4010',
  BINANCE_MARKET_WS_URL: 'ws://127.0.0.1:4010/market-stream',
  BINANCE_USER_WS_URL: 'ws://127.0.0.1:4010/user-stream',
};

describe('resolveBinanceEndpoints', () => {
  it('keeps production and testnet defaults fixed when no override is requested', () => {
    expect(resolveBinanceEndpoints({})).toEqual({
      rest: {
        live: 'https://api.binance.com',
        test: 'https://testnet.binance.vision',
      },
      marketStream: {
        live: 'wss://stream.binance.com:9443/stream',
        test: 'wss://testnet.binance.vision/stream',
      },
      userStream: {
        live: 'wss://ws-api.binance.com:443/ws-api/v3',
        test: 'wss://ws-api.testnet.binance.vision/ws-api/v3',
      },
    });
  });

  it('binds every mode to the complete loopback fixture set in app-e2e', () => {
    const endpoints = resolveBinanceEndpoints(OVERRIDES);

    expect(new Set(Object.values(endpoints.rest))).toEqual(new Set([OVERRIDES.BINANCE_REST_URL]));
    expect(new Set(Object.values(endpoints.marketStream))).toEqual(
      new Set([OVERRIDES.BINANCE_MARKET_WS_URL]),
    );
    expect(new Set(Object.values(endpoints.userStream))).toEqual(
      new Set([OVERRIDES.BINANCE_USER_WS_URL]),
    );
  });

  it('accepts IPv6 loopback and strips a trailing slash', () => {
    // Both lines run under the IPv4 fixtures above without their effect being
    // observable, so coverage alone would not notice either going away. A host
    // that binds `::1` would then be refused outright, and a URL saved with a
    // trailing slash would build every request path with a doubled separator.
    const endpoints = resolveBinanceEndpoints({
      NODE_ENV: 'test',
      APP_E2E: '1',
      BINANCE_REST_URL: 'http://[::1]:4010/',
      BINANCE_MARKET_WS_URL: 'ws://[::1]:4010/market-stream',
      BINANCE_USER_WS_URL: 'ws://[::1]:4010/user-stream',
    });

    expect(endpoints.rest.live).toBe('http://[::1]:4010');
    expect(endpoints.marketStream.test).toBe('ws://[::1]:4010/market-stream');
  });

  it('refuses overrides outside the explicit test app-e2e runtime', () => {
    expect(() => resolveBinanceEndpoints({ ...OVERRIDES, NODE_ENV: 'production' })).toThrow(
      /only allowed/,
    );
    expect(() => resolveBinanceEndpoints({ ...OVERRIDES, APP_E2E: '0' })).toThrow(/only allowed/);
  });

  it('refuses incomplete, remote, or transport-loosened override sets', () => {
    expect(() => resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_USER_WS_URL: undefined })).toThrow(
      /must be complete/,
    );
    expect(() =>
      resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_REST_URL: 'http://example.com' }),
    ).toThrow(/loopback/);
    // `localhost` is a NAME, not an address, so it is rejected alongside the
    // remote host. Pinned because re-adding it is the obvious way to make a
    // local run work, and an /etc/hosts entry or a rebinding resolver then
    // points it off-box past the check.
    expect(() =>
      resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_REST_URL: 'http://localhost:4010' }),
    ).toThrow(/loopback/);
    expect(() =>
      resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_MARKET_WS_URL: 'wss://127.0.0.1:4010' }),
    ).toThrow(/must use ws:/);
    // The REST scheme is pinned the same way, and rejecting the MORE secure
    // scheme is the surprising half: the check is not about transport security
    // on loopback, it is that every override must be one exact recognised shape.
    // Widening it to "http or https" is the plausible edit, and it is the first
    // step toward accepting a scheme whose host resolution differs.
    expect(() =>
      resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_REST_URL: 'https://127.0.0.1:4010' }),
    ).toThrow(/must use http:/);
    expect(() => resolveBinanceEndpoints({ ...OVERRIDES, BINANCE_REST_URL: 'not a URL' })).toThrow(
      /valid URL/,
    );
  });
});
