import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { corsAllowlist, isAllowedOrigin } from '../src/middleware/cors.js';

const LOCAL = 'http://localhost:5173';
const LAN = 'http://192.168.1.50:5173';
const ALLOW = [LOCAL, LAN];

const appWithCors = () => {
  const app = new Hono();
  app.use('*', corsAllowlist(ALLOW));
  app.get('/', (c) => c.text('ok'));
  return app;
};

describe('corsAllowlist — WEB_ORIGIN allowlist', () => {
  it('reflects an allowed (non-first) origin and allows credentials', async () => {
    const res = await appWithCors().request('/', { headers: { Origin: LAN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(LAN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('does not reflect an origin outside the allowlist', async () => {
    const res = await appWithCors().request('/', { headers: { Origin: 'http://evil.test' } });
    // Credentialed CORS must never echo an unlisted origin back.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('http://evil.test');
  });
});

describe('isAllowedOrigin — WEB_ORIGIN allowlist (WS upgrade gate)', () => {
  it('accepts any listed origin', () => {
    expect(isAllowedOrigin(LOCAL, ALLOW)).toBe(true);
    expect(isAllowedOrigin(LAN, ALLOW)).toBe(true);
  });
  it('rejects an unlisted origin', () => {
    expect(isAllowedOrigin('http://evil.test', ALLOW)).toBe(false);
  });
  it('rejects a missing Origin header', () => {
    expect(isAllowedOrigin(undefined, ALLOW)).toBe(false);
  });
});
