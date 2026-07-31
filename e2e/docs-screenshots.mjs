// Captures the operator UI for the docs, one content-tight PNG per screen.
//
// Runs against a stack seeded by `bun run seed:dev`, which writes both the
// Postgres rows and the Redis market data the UI reads, so no Binance
// credentials are involved. The page clock is frozen to the same instant the
// seeder measured its timestamps back from (`DOCS_FROZEN_AT_MS`), so relative
// ages render as the spread the seeder built rather than drifting mid-capture.
// CSS animations are frozen too, so the header's ticker marquee is not caught
// mid-crawl.
//
// Every capture writes straight into `docs/assets/screenshots/`, at the
// destinations `docs-screenshots.manifest.mjs` declares. There is no staging
// directory to copy out of by hand, so a run replaces the whole committed set.
//
// Sizing: the app shell is height:100vh with an inner scroller, so the document
// never scrolls and `fullPage` clips to the viewport. Measuring statically does
// not work either — a min-height floor makes a short page report the viewport
// height, and nested scrollers hide their extent. So start below any real page
// height and grow the viewport until nothing overflows. Starting tall can only
// leave a band above the sticky footer, because growing never shrinks.
//
// Any capture that fails is fatal: a screen that silently went missing would
// leave a stale PNG in the docs looking current.
//
// Usage: bun run docs:screenshots   (see scripts/docs/screenshots.ts)

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { SHOTS } from './docs-screenshots.manifest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env['DOCS_BASE_URL'] ?? 'http://localhost:5173';
const OUT = process.env['DOCS_OUT_DIR'] ?? `${REPO_ROOT}/docs/assets/screenshots`;
const EMAIL = process.env['DOCS_LOGIN_EMAIL'] ?? 'docs@example.com';
const PASSWORD = process.env['DOCS_LOGIN_PASSWORD'] ?? 'docs-screenshot-pw-1234';
// Must match the instant the seeder used (`SEED_NOW_MS`); the driver passes both.
const FROZEN_AT_MS = Number(process.env['DOCS_FROZEN_AT_MS'] ?? Date.now());

const WIDTH = 1440;
// Below any real page height, so the grow loop converges from underneath.
const START_HEIGHT = 400;
const PAD = 24; // breathing room between content and the footer, matches p-6
// Chromium tiles screenshots at 16384px; a fullPage capture past that can
// truncate, sometimes silently. Stay under it so hitting the cap is a loud
// failure rather than a quietly clipped PNG.
const MAX_HEIGHT = 16_000;
const GROW_STEPS = 15;
// Overlays are captured at a fixed height: they float above the page, so the
// grow loop has no scroller extent to converge on.
const OVERLAY_HEIGHT = 950;

/**
 * How much taller the viewport must be for the page to stop scrolling.
 *
 * Scrollers capped with an explicit max-height (`max-h-72` and friends) are
 * excluded: they are meant to scroll on their own, and their overflow is
 * constant at every viewport size, so counting them grows the shot forever and
 * strands the content above a blank band.
 */
const overflowAmount = () => {
  let need = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
    if (s.maxHeight && s.maxHeight !== 'none') continue;
    need = Math.max(need, el.scrollHeight - el.clientHeight);
  }
  return need;
};

const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;

/**
 * Re-encode a capture to a palette PNG.
 *
 * The operator UI is a flat dark terminal: a handful of background greys, one
 * amber, two semantic colours, and antialiased text. That is far under 256
 * distinct colours over most of the frame, so quantising is visually lossless
 * here while cutting a full-page config form by roughly two thirds. Expanding
 * every disclosure (which the docs need) made the largest captures megabytes,
 * and those ship in the repo and over the wire to every reader.
 *
 * `effort: 10` is the slowest, smallest setting — this runs once per capture on
 * a developer machine, never in CI, so the time is worth the bytes.
 *
 * Falls back to the original bytes if quantising fails OR comes out bigger,
 * which can happen on a capture dominated by a photographic chart gradient. A
 * screenshot that is merely large is fine; one that failed to write is not.
 */
const compress = async (buffer, name) => {
  try {
    const out = await sharp(buffer).png({ palette: true, quality: 90, effort: 10 }).toBuffer();
    return out.length < buffer.length ? out : buffer;
  } catch (err) {
    console.warn(`  ${name}: compression skipped (${err.message})`);
    return buffer;
  }
};

/**
 * Open every disclosure on the page before measuring.
 *
 * Config sections, the advanced field groups, and several panels render as
 * native `<details>` that start closed. A capture taken as-is documents a
 * heading and a chevron instead of the settings the page is about, which is
 * exactly what made the Discovery and strategy-config shots useless. Returns
 * how many it opened so a page that unexpectedly has none is visible in the log.
 */
const expandAll = () => {
  const closed = [...document.querySelectorAll('details:not([open])')];
  for (const d of closed) d.open = true;
  return closed.length;
};

/**
 * Capture the current page to every destination the shot declares.
 * `animations: 'disabled'` freezes the header ticker's infinite marquee at its
 * first frame; without it the strip is captured mid-crawl and reads as
 * duplicated, half-clipped text.
 */
const shoot = async (page, shot, fixedHeight) => {
  let height = fixedHeight ?? START_HEIGHT;
  await page.setViewportSize({ width: WIDTH, height });
  // Before the grow loop, not after: an opened section adds height, and the loop
  // is what sizes the viewport to fit it.
  const opened = await page.evaluate(expandAll);
  await page.waitForTimeout(400);

  if (fixedHeight === undefined) {
    // A chart sized off the viewport grows as fast as the viewport does, so its
    // reported overflow never shrinks. Stop as soon as growing stops reducing
    // the deficit, otherwise the loop runs away to MAX_HEIGHT and leaves a huge
    // band under the content.
    let prevNeed = Number.POSITIVE_INFINITY;
    for (let i = 0; i < GROW_STEPS; i++) {
      const need = await page.evaluate(overflowAmount);
      if (need <= 0 || need >= prevNeed) break;
      prevNeed = need;
      height = Math.min(height + need, MAX_HEIGHT);
      await page.setViewportSize({ width: WIDTH, height });
      await page.waitForTimeout(350);
      if (height >= MAX_HEIGHT) break;
    }
    height = Math.min(height + PAD, MAX_HEIGHT);
    if (height >= MAX_HEIGHT) {
      throw new Error(
        `${shot.name}: viewport hit the ${MAX_HEIGHT}px cap — a container is sized off the viewport`,
      );
    }
    await page.setViewportSize({ width: WIDTH, height });
  }

  await page.waitForTimeout(500);
  // Captured once into a buffer, then written to each destination. Chromium's
  // own encoder is tuned for speed, so every PNG is re-encoded below before it
  // reaches the repo.
  const raw = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const encoded = await compress(raw, shot.name);
  for (const dest of shot.dest) {
    const path = `${OUT}/${dest}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encoded);
  }
  const saved = raw.length - encoded.length;
  console.log(
    `  ${shot.name}  ${WIDTH}x${height}` +
      `${opened > 0 ? `  (+${opened} expanded)` : ''}` +
      `  ${kb(encoded.length)}` +
      `${saved > 0 ? ` (−${Math.round((saved / raw.length) * 100)}%)` : ''}` +
      ` → ${shot.dest.join(', ')}`,
  );
};

/** Resolve a manifest route template against the seeded stack's ids. */
const resolveRoute = (route, ids) => {
  const out = route
    .replaceAll('{acc}', ids.acc)
    .replaceAll('{momentumProf}', ids.momentumProf)
    .replaceAll('{rebalanceProf}', ids.rebalanceProf)
    .replaceAll('{prof}', ids.prof)
    .replaceAll('{symbol}', ids.symbol);
  // A typo in a manifest template would otherwise resolve to a literal `{foo}`
  // path segment, 404, and be captured as the not-found page.
  const leftover = out.match(/\{[a-zA-Z]+\}/);
  if (leftover) throw new Error(`unresolved route placeholder ${leftover[0]} in "${route}"`);
  return out;
};

const visit = async (page, shot, ids) => {
  await page.goto(`${BASE}${resolveRoute(shot.route, ids)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shoot(page, shot);
};

/**
 * Captures that need an interaction rather than a URL, keyed by manifest name.
 * Kept beside the manifest rather than inside it because each one is a distinct
 * sequence, not data.
 */
const SCRIPTED = {
  // Step 2 renders the strategy picker only once step 1 carries a name.
  'profile-wizard-step2': async (page, shot, ids) => {
    await page.goto(`${BASE}${ids.acc}/profiles/new`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.locator('#profile-name').fill('TrailingTrade');
    await page
      .getByRole('button', { name: /next|continue/i })
      .first()
      .click();
    await page.waitForTimeout(900);
    await shoot(page, shot);
  },
  // The manage-profile sheet is an overlay opened from the profile header. Size
  // the viewport before opening it: the sheet is fixed to the viewport, so it
  // has no scroll extent for the grow loop to converge on.
  'manage-profile-sheet': async (page, shot, ids) => {
    await page.goto(`${BASE}${ids.prof}`, { waitUntil: 'networkidle' });
    await page.setViewportSize({ width: WIDTH, height: OVERLAY_HEIGHT });
    await page.waitForTimeout(1200);
    await page.locator('[data-testid="open-manage-sheet"]').first().click();
    await page.waitForSelector('[data-testid="manage-sheet"]', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await shoot(page, shot, OVERLAY_HEIGHT);
  },
};

/** Sign in and resolve the account, profile and symbol the manifest templates need. */
const signInAndResolveIds = async (page) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  await page
    .getByRole('button', { name: /sign in|log in/i })
    .first()
    .click();
  await page.waitForTimeout(3000);
  if (page.url().includes('/login')) {
    throw new Error(`login failed for ${EMAIL} — is the stack seeded? (bun run seed:dev)`);
  }

  const accountId = new URL(page.url()).pathname.split('/')[2];
  if (!accountId) throw new Error(`could not resolve accountId from ${page.url()}`);

  // The profile-* docs pages show a trailing-trade profile: it is the only
  // strategy with a pinned symbol and the full section set. The two other
  // strategies are resolved as well, because the config form is generated from
  // the selected strategy's own schema — one shot cannot document all three.
  const profiles = await page.evaluate(async (a) => {
    const res = await fetch(`/api/accounts/${a}/profiles`);
    if (!res.ok) throw new Error(`profiles returned ${res.status}`);
    return res.json();
  }, accountId);
  const byStrategy = (name) => profiles.find((p) => p.strategyName === name);
  const profile = byStrategy('trailing-trade') ?? profiles[0];
  if (!profile) throw new Error('no profiles found — run `bun run seed:dev` first');
  // Missing is fatal rather than skipped: a silently absent strategy profile
  // would leave the previous run's PNG in place, looking current.
  const momentum = byStrategy('momentum');
  const rebalance = byStrategy('rebalance');
  for (const [name, found] of [
    ['momentum', momentum],
    ['rebalance', rebalance],
  ]) {
    if (!found) {
      throw new Error(`no ${name} profile — the seeder creates one per registered strategy`);
    }
  }

  // Symbol routes are mounted under the account prefix. A bare
  // `/api/profiles/:id/symbols` 404s, and swallowing that would silently
  // capture every symbol-workspace shot against a hardcoded fallback pair the
  // profile may not even track.
  const symbols = await page.evaluate(
    async ({ a, p }) => {
      const res = await fetch(`/api/accounts/${a}/profiles/${p}/symbols`);
      if (!res.ok) throw new Error(`symbols returned ${res.status}`);
      return res.json();
    },
    { a: accountId, p: profile.id },
  );
  // A HELD symbol, not simply the first one. The workspace shots (trade, orders,
  // market) are about an open position; captured against a watching-only symbol
  // they document empty states and a "Flat" header. The symbols endpoint carries
  // no position data, so the held set comes from the dashboard aggregate, which
  // is the same source the Symbols table renders HOLDING from.
  const held = await page.evaluate(
    async ({ a, p, list }) => {
      for (const s of list) {
        const res = await fetch(`/api/accounts/${a}/profiles/${p}/symbols/${s}/state`);
        if (!res.ok) continue;
        const body = await res.json();
        // `avgEntryPrice` is the same field the grid panel reads to decide the
        // symbol is flat, so this picks exactly a symbol whose workspace panels
        // have something to show. First hit wins — only one is ever used.
        if (body.avgEntryPrice != null) return s;
      }
      return null;
    },
    { a: accountId, p: profile.id, list: symbols.map((s) => s.symbol) },
  );
  const symbol = held ?? symbols[0]?.symbol;
  if (!symbol)
    throw new Error(`profile ${profile.id} tracks no symbols — run \`bun run seed:dev\``);
  if (!held) {
    console.warn(
      `[docs-screenshots] no held symbol on ${profile.id}; the workspace shots will ` +
        'show empty panels. Re-seed to get a position.',
    );
  }

  return {
    acc: `/accounts/${accountId}`,
    prof: `/accounts/${accountId}/profiles/${profile.id}`,
    momentumProf: `/accounts/${accountId}/profiles/${momentum.id}`,
    rebalanceProf: `/accounts/${accountId}/profiles/${rebalance.id}`,
    symbol,
  };
};

// A finished backtest, so the Results and History tabs document a real run
// rather than an empty state. Run through the app's own API and queue — the
// study worker the driver boots picks the job up, backfills candles from
// Binance's public klines endpoint, and replays the strategy. Fabricating the
// stored result instead is not an option: it is ~50 interdependent numbers that
// only agree with each other if a replay produced them.
const BACKTEST_TIMEOUT_MS = 300_000;
const BACKTEST_POLL_MS = 3_000;

const ensureBacktestResult = async (page, ids) => {
  const profileId = ids.prof.split('/').pop();
  const accountId = ids.acc.split('/').pop();

  const existing = await page.evaluate(
    async ({ a, p }) => {
      const res = await fetch(`/api/accounts/${a}/profiles/${p}/backtests`);
      if (!res.ok) return [];
      return (await res.json()).items ?? [];
    },
    { a: accountId, p: profileId },
  );
  if (existing.some((r) => r.status === 'done')) {
    console.log('[docs-screenshots] backtest: a finished run already exists');
    return;
  }

  // A 30-day window on the profile's own trading interval. Long enough to
  // produce round-trips and a readable equity curve, short enough that the
  // candle backfill is one page per symbol.
  const toMs = FROZEN_AT_MS;
  const fromMs = toMs - 30 * 24 * 60 * 60 * 1000;
  const runId = await page.evaluate(
    async ({ a, p, body }) => {
      const res = await fetch(`/api/accounts/${a}/profiles/${p}/backtests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`enqueue returned ${res.status}: ${await res.text()}`);
      return (await res.json()).runId;
    },
    {
      a: accountId,
      p: profileId,
      body: {
        symbols: [ids.symbol],
        fromMs,
        toMs,
        strategyInterval: '1h',
        detailInterval: '1h',
        initialQuoteBalance: '1000',
        fees: { makerBps: 10, takerBps: 10 },
        slippageBps: 5,
        spreadBps: 2,
      },
    },
  );
  console.log(`[docs-screenshots] backtest ${runId} enqueued, waiting…`);

  const deadline = Date.now() + BACKTEST_TIMEOUT_MS;
  for (;;) {
    // The page clock is frozen, so `Date.now()` inside the browser cannot time
    // this loop — the wait is measured out here, in the driver's real time.
    if (Date.now() > deadline) {
      throw new Error(`backtest ${runId} did not finish within ${BACKTEST_TIMEOUT_MS}ms`);
    }
    await page.waitForTimeout(BACKTEST_POLL_MS);
    const row = await page.evaluate(
      async ({ a, p, r }) => {
        const res = await fetch(`/api/accounts/${a}/profiles/${p}/backtests/${r}`);
        if (!res.ok) throw new Error(`poll returned ${res.status}`);
        return res.json();
      },
      { a: accountId, p: profileId, r: runId },
    );
    if (row.status === 'done') {
      console.log('[docs-screenshots] backtest finished');
      return;
    }
    // A failed run is fatal, not skipped: continuing would capture the Results
    // tab's error state and ship it as the documented happy path.
    if (row.status === 'error' || row.status === 'cancelled') {
      throw new Error(`backtest ${runId} ended ${row.status}: ${row.error ?? 'no error recorded'}`);
    }
  }
};

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: START_HEIGHT },
    colorScheme: 'dark',
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // Frozen to the instant the seeder measured its timestamps back from. A fixed
  // calendar date instead would put the page clock months away from the data,
  // and every age helper clamps a negative elapsed time to zero — so every
  // "last tick" and "N ago" in the shipped screenshots would read "0s ago".
  await page.clock.setFixedTime(new Date(FROZEN_AT_MS));

  try {
    const ids = await signInAndResolveIds(page);
    await ensureBacktestResult(page, ids);
    console.log(`[docs-screenshots] ${SHOTS.length} screens → ${OUT}`);

    for (const shot of SHOTS) {
      const scripted = SCRIPTED[shot.name];
      // A manifest entry with neither a route nor a handler is a wiring
      // mistake, not a screen to skip.
      if (!shot.route && !scripted) {
        throw new Error(`${shot.name}: manifest declares no route and no scripted handler`);
      }
      try {
        if (scripted) await scripted(page, shot, ids);
        else await visit(page, shot, ids);
      } catch (err) {
        throw new Error(`${shot.name}: ${err.message}`, { cause: err });
      }
    }
  } finally {
    await browser.close();
  }
};

run().catch((err) => {
  console.error('docs-screenshots failed:', err.message);
  process.exit(1);
});
