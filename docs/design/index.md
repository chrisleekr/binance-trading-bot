# Design

The canonical visual system for `apps/web` lives in **`DESIGN.md` at the repository root**, authored in the [`google-labs-code/design.md`](https://github.com/google-labs-code/design.md) format (the format Google Stitch consumes). It defines the **Operator Terminal (v3 "Unified Terminal")** system: a Bauhaus-inspired dark terminal — flat near-black canvas with hairline 1px borders and square corners, one amber-yellow accent for selection/action (black ink on it), signal green/red for positive/negative, Space Grotesk for UI text with JetBrains Mono reserved for numbers. Dense on desktop with a collapsible left sidebar; still fully usable on a 375px phone via the bottom tab nav.

v3 keeps the v2 visual language and changes the information architecture: an overview dashboard at `/` plus a dedicated route per surface — the per-symbol workspace at `/profiles/:id/symbols/:SYMBOL` (`?tab` selects trade/orders/market/logs) and a page for each per-profile editor (config, api-key, notifications, discovery, risk, bulk-order), alongside history, backtest, the new-profile wizard, and login/onboarding. Every non-overview surface is a real route reached with `‹ Back`. See DESIGN.md's Layout section for the route map.

- **`DESIGN.md`** (repo root) — source of truth. Design tokens (front matter) + prose rationale + component rules. Token values mirror `apps/web/src/styles/app.css`.

## Superseded history

These earlier directions are kept for their rationale and research; none describes the current UI.

- **v1 "Operator Console"** — the calm, legibility-first console (mint = go, blue = commit, 6px radii, sentence case). v2 keeps its behavioural rules — mobile-first usability, inline glosses, colour-plus-glyph, honest numbers — and replaces the visual language with the terminal aesthetic the operator asked for.
- **"Operator Terminal" (pre-v1)** — a dense, all-monospace, true-black Bloomberg-style instrument aesthetic, superseded by v1 for legibility. v2 readopts its density and terminal chrome, but with v1's legibility rules (sans prose, glosses, no caps walls) kept intact.
- **[Bloomberg Terminal spec](bloomberg-terminal-design-spec.md)** — the original amber research direction behind the terminal aesthetic. Retained for density/layout and colour-accessibility research and its cited sources.
