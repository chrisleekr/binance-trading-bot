import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// The production SPA is served by the api with a strict CSP (`script-src 'self'`,
// no `unsafe-inline`). An inline <script> is blocked there — it silently fails
// and, for the theme-init script, reintroduces a theme flash. This guards the
// source template (Vite adds no inline <script> of its own here, so the built
// index.html inherits this), keeping every script external and same-origin.
// vitest runs with the package root (apps/web) as cwd.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('index.html is CSP-safe', () => {
  it('has no inline <script> (every script tag carries a src)', () => {
    const openTags = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(openTags.length).toBeGreaterThan(0);
    for (const tag of openTags) {
      expect(tag).toMatch(/\ssrc=/);
    }
  });

  it('loads theme-init from a same-origin file, not inline', () => {
    expect(html).toContain('src="/theme-init.js"');
    // No inline theme logic left behind.
    expect(html).not.toContain('localStorage.getItem');
  });
});
