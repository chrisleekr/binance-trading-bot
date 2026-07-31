import { resolve } from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { cacheControlFor, resolveWebDist, spaNotFound } from '../src/web-dist.js';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/web-dist');

describe('cacheControlFor', () => {
  it('marks hashed /assets/* and media immutable (case-insensitive, matching nginx ~*)', () => {
    for (const p of [
      '/assets/index-abc123.js',
      '/assets/font.woff2',
      '/favicon.svg',
      '/logo.png',
      '/LOGO.PNG',
      '/Icon.WEBP',
    ]) {
      expect(cacheControlFor(p)).toBe('public, max-age=31536000, immutable');
    }
  });

  it('marks the shell, service worker, and manifest no-store', () => {
    for (const p of [
      '/',
      '/index.html',
      '/sw.js',
      '/workbox-2fbc6a65.js',
      '/manifest.json',
      '/dashboard',
    ]) {
      expect(cacheControlFor(p)).toBe('no-store');
    }
  });
});

describe('spaNotFound', () => {
  const app = new Hono();
  app.get('/api/real', (c) => c.json({ ok: true }));
  app.notFound(spaNotFound('<!doctype html><title>shell</title>'));

  it('returns the JSON error envelope for an unmatched /api path (never HTML)', async () => {
    const r = await app.request('/api/missing');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'not found' } });
  });

  it('renders the SPA shell no-store for a non-/api deep-link', async () => {
    const r = await app.request('/dashboard/deep/link');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toContain('shell');
  });

  it('does not shadow a real /api route', async () => {
    const r = await app.request('/api/real');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe('resolveWebDist', () => {
  it('returns null for an undefined or missing directory', () => {
    expect(resolveWebDist(undefined)).toBeNull();
    expect(resolveWebDist(resolve(FIXTURE, 'does-not-exist'))).toBeNull();
  });

  it('reads index.html when the build exists', () => {
    const web = resolveWebDist(FIXTURE);
    expect(web).not.toBeNull();
    expect(web?.root).toBe(FIXTURE);
    expect(web?.indexHtml).toContain('web-static fixture');
  });
});
