---
name: feature-walkthrough
description: Autonomously test the running binance-trading-bot app in a real browser. The agent drives the browser itself via the Playwright MCP - logs in, looks at each screen, and works through every feature end-to-end like a real operator, finding and fixing bugs. Use when asked to test the app, smoke-test or walk through the UI, verify the frontend end-to-end, or check that features actually work in a browser.
---

# Feature walkthrough

Autonomously exercise the real app in a real browser. **You** are the test driver: open the browser, look at the screen, decide what to click, observe the result, decide the next step. This is agentic, vision-driven testing - not a pre-written script.

The goal is "the feature works when a person uses it". Type-checks and unit tests verify code correctness, not feature correctness.

**Test as a non-expert operator.** Walk the app as a user who is _not_ a financial or trading expert. The product must be **easy but accurate**: precise and correct under the hood, yet usable by someone who does not already know the strategy. Unexplained jargon, a setting with no inline help, a number with no units or context, a flow that only a strategy-literate user can complete - each is a real UI/UX finding, not cosmetic.

**This is a greenfield project - refactor freely.** Nothing is deployed; there is no legacy to protect and no shipped behaviour to preserve. When a finding exposes mis-architecture, a performance problem, or a UI/UX flow that is wrong at the structural level, the sanctioned fix is a **large refactor**, not a surgical patch. Do not paper over a bad design to keep the diff small - the bar is the correct architecture, correct code, tested and performant. Surface the scope of a big refactor, confirm, then do it properly.

This skill is stateless and self-contained - no sibling tracker files. Discover features fresh each run; fix what you can this run; file the rest as GitLab issues. Deterministic regression tests do NOT belong here - they live in `e2e/tests/` as Playwright specs (`manual-order-roundtrip.spec.ts`, `profile-controls.spec.ts`, ...). This skill is the exploratory layer that adapts to whatever the UI actually shows.

## 1. Preflight

1. **Browser tools.** Needs the Playwright MCP `browser_*` tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_wait_for`, `browser_resize`, `browser_console_messages`, `browser_network_requests`, `browser_take_screenshot`). If unavailable, stop and tell the operator to enable the Playwright MCP - the skill cannot run without it.
2. **Stack.** Postgres + Redis must be up - `docker ps` for `binance-trading-bot-postgres-1` and `-redis-1`; if absent, `docker compose -f deploy/compose/docker-compose.yml up -d db redis`. Apply migrations: `bun run db:migrate`.
3. **Dev server.** If not up: `bun run dev > /tmp/btb-dev.log 2>&1 &`. Ports: api `:3000`, web `:5173`, worker `:9101`. **`bun --watch` does NOT reload workspace `packages/*`** - after editing anything under `packages/`, or if the server was started before a recent merge, restart `bun run dev` or it serves stale code and a correct fix looks broken. Vite HMR (`apps/web`) reloads reliably.

## 2. Log in and orient

1. `browser_navigate` to `http://localhost:5173/login`.
2. `browser_snapshot` the login form. Type the dev credentials - request the executor credentials - into the real fields and click submit. (If login reports no account, create the master account at `/onboarding`.)
3. Log in **once** - the API rate-limits `/api/auth/sign-in/*` (60s window). Reuse the same session for the whole run; a wrong-password test also counts against the window, so run it after the real login.
4. `browser_snapshot` the dashboard. This is your map: the nav, the profile list, the action surfaces. Cross-reference `apps/web/src/routes/` for routes not linked from the dashboard.

## 3. Discover - fresh, every run

Build the feature set live each run; there is no coverage file to read:

1. From the dashboard snapshot, walk every nav target and action surface (`browser_snapshot` each screen).
2. Enumerate routes from `apps/web/src/routes/` - anything not reachable by clicking is still a feature.
3. Treat each distinct end-to-end thing an operator can _do_ (place an order, switch strategy, save a notifier, run the wizard, ...) as one feature.

## 4. Pick a batch

Fix a **substantial batch per run - ~5–8 items**, sized by reviewable diff, shipped as one MR(Gitlab) or PR(GitHub). CI and senior-review cost the same per MR whether it carries one fix or many, so a thin batch wastes the cycle. Priority order, highest first:

1. Defects already seen this run.
2. Features closest to the money path: orders > config > notifiers > cosmetic.
3. Sub-bar UX/DevX small enough to fold in.

Rules: a genuinely large or risky item (whole-feature work, refactor, "multiple valid approaches" territory) ships **solo** in its own MR - never padded with or batched against small fixes. A batch may span files and themes; keep commit history legible (one commit per item or theme). Each batched item is still walked and verified per §5.

## 5. Walk it - run this loop yourself, do not pre-script it

Run this loop for **each item in the batch**. Items are independent; do them in turn.

1. **Navigate** to the feature's entry screen.
2. **Observe** - `browser_snapshot` (accessibility tree, gives clickable refs); `browser_take_screenshot` when layout matters. Refs are snapshot-scoped: re-snapshot after every navigation or re-render or a stale ref clicks the wrong thing.
3. **Decide** the next interaction from what you see - the real button, input, selector.
4. **Act** - `browser_click` / `browser_type` / `browser_select_option` / `browser_press_key`. Real interactions only. Destructive actions (kill-switch, strategy switch) open a confirm modal - snapshot the dialog and click its Confirm; the action is not done until you do.
   - If `browser_click` reports success but nothing happens (no events reach the page), the long session's click coordinates have desynced - a tool artifact, not an app bug: `browser_close` then re-`browser_navigate` for a fresh context, and the click works again.
5. **Verify** - snapshot again. Assert the concrete outcome: a banner, a badge, a redirected URL, a new row, a value that survives a reload.
6. **Loop** to step 2 until the journey is complete or it visibly breaks.
7. **Check silent failure** - `browser_console_messages` and `browser_network_requests`: unexpected console errors or API responses ≥ 400 are findings even when the screen looked fine.
8. **Restore** every mutation through the UI - release kill-switches, revert config edits, delete test profiles. Leave the dev DB as you found it.

**UX/DevX is a first-class finding, not cosmetic.** This is an operator's trading tool. At every Verify step, judge the screen as a user: is the layout clean and aligned, the hierarchy clear, the primary action obvious, are loading/empty/error states handled, is copy precise, the flow short and unsurprising? Read the pixels with `browser_take_screenshot`, not only the accessibility tree.

**Non-expert lens.** Assume the user does not know trading. Jargon without explanation, a field with no inline help, a value with no units/context, or a flow that only a strategy-literate user can finish is a defect - fix or file it. "Easy but accurate": friendly defaults, plain-language labels, inline help, actionable errors, without losing correctness.

**DevX counts the same.** Every setting needs a proper form UI with typed inputs, inline help, and per-field validation - a raw JSON editor is itself a UX defect: flag and replace it. Validation errors must say exactly what is wrong and where; defaults must be sane; setup/recovery must not require reading source. A cryptic error, a silent rejection, or a flow only a code-reader can complete is a DevX finding.

Cross-cutting checks while you are in there:

- Wrong-password login → friendly error, not a crash. Do this **after** the real login or it burns the rate-limit window.
- Resize to 375×667 (`browser_resize`) on every screen you visit → no horizontal overflow, and the mobile layout must be genuinely usable, not merely non-overflowing (mobile-first is a core invariant).

**Dev-env boundary:** there is no live Binance connection in dev, and manual orders enqueue but may not fill. Verify what dev _can_ prove (enqueue, UI state, DB row) and state the boundary - do not file expected env state as a bug.

## 6. Triage - one verdict per observation

- **Fix it this run** - a small, contained defect, UI/UX, or DevX finding. Fix the root cause (§7).
- **File a GitLab issue** - a real finding too large/ambiguous for this batch, or sub-bar-but-not-broken. Title + location + severity + repro steps. This is the durable backlog; there is no local tracker file.
- **Leave it** - Cite the doc; do not act.
- **Re-observe** - your own misread: wrong screen, stale dev server, a moved control, a desynced click (§5). Do not touch the app.
- **Not a bug** - expected dev-env state: empty data, "Never" last-tick, 502s from Binance, 404s for unconfigured notifiers.

A bug is never parked as a "known issue" to work around - it is fixed this run or filed as an issue to fix later.

## 7. Fix - root cause, not symptom

Fix every batched item at the root. This is a greenfield project - no legacy to protect, no shipped behaviour to preserve - so **large refactoring is sanctioned and expected** wherever a finding warrants it. Mis-architecture (wrong abstraction, a pattern that should not exist, a missing layer), a performance problem, or a structurally-wrong UI/UX flow are all valid triggers for a big rewrite, not a patch. Do not paper over a bad design with a surgical fix that leaves the bad design in place. The bar is correct architecture, correct code, tested, performant - not minimal diff. A change that large is "multiple valid approaches" territory: surface the scope and design, confirm, then build. Keep `bun run typecheck`, `bun run lint`, and `bun run test` clean, and re-walk each affected feature in the browser. Loop until every batched item works.

When a bug is worth locking down, add a deterministic spec to `e2e/tests/` (follow `profile-controls.spec.ts`) - that is the regression layer; this skill is not.
