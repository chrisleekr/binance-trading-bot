#!/usr/bin/env bash
# Arbitrary-colour-token gate (apps/web). Colour must go through the semantic
# Tailwind utility (`text-muted-fg`, `border-border`, `text-up`, …), never the
# arbitrary `text-[var(--muted-fg)]` escape hatch. Both resolve to the same CSS
# var, so the arbitrary form is pure drift: it bypasses the design-token
# utilities and defeats grep/refactor. app.css `@theme inline` is the single
# source of truth; every token below has a generated `--color-*` utility.
#
# Only the exact `-[var(--TOKEN)]` shape is flagged. Composite arbitraries such
# as `border-[color-mix(in_srgb,var(--accent)_45%,transparent)]` are untouched
# (no bare `)]` after the token) — a class utility can't express those.
#
# Replaces the local/no-arbitrary-color-token ESLint rule (eslint→oxlint
# migration, #576). The former rule was a regex over string literals; this is
# the same regex.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it if no source files are scanned (scan-path
# regression), because a drift gate that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-arbitrary-color-token

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-arbitrary-color-token.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const TOKENS = "bg-elevated|surface-alt|fg-emphasis|muted-fg|border-strong|accent-fg|primary-fg|danger-fg|warning-fg|card-fg|bg|fg|muted|border|accent|primary|success|up|down|danger|destructive|warning|focus|card";
const PATTERN = new RegExp("-\\[var\\(--(" + TOKENS + ")\\)\\]");

// Walked and vacuity-checked by the shared helper: it refuses a walk that returns nothing AND one that still returns files but no longer reaches the shared UI primitives, which are where the semantic utilities this rule protects are actually spelled. A feature-tree re-layout leaves hundreds of files in scope while the components that carry colour go unscanned, and a file count cannot tell that apart from a clean tree.
const files = collectOrExit({
  root,
  label: ".ts/.tsx files",
  skipDirs: ["node_modules", "dist"],
  test: (p) => /\.tsx?$/.test(p),
  roots: [
    {
      name: path.join("apps", "web", "src"),
      anchors: [
        path.join("apps", "web", "src", "main.tsx"),
        path.join("apps", "web", "src", "shared", "components", "ui", "button.tsx"),
      ],
    },
  ],
});

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) hits.push(path.relative(root, file) + ":" + (i + 1) + ": " + lines[i].trim());
  }
}

if (hits.length > 0) {
  console.error("Arbitrary colour token(s) found — use the semantic utility (e.g. text-muted-fg), not text-[var(--muted-fg)]:");
  console.error(hits.map((h) => "  " + h).join("\n"));
  process.exit(1);
}

console.log("no-arbitrary-color-token gate: OK (" + files.length + " files scanned)");
'
