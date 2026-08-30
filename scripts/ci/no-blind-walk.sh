#!/usr/bin/env bash
set -euo pipefail

# Meta-gate: every scripts/ci gate that decides its verdict from a tree walk must obtain that walk from scripts/ci/lib/walk.mjs.
#
# The defect this closes is not that a walk breaks — it is that a broken walk is indistinguishable from a clean tree. Each of these gates answers an invariant by walking a source tree and counting matches, and every one of them already refused a walk that returned NOTHING. None of that helps against the walk that merely narrows: a skip-list entry that grew to match a real source directory, a renamed root, a re-layout, a dropped extension clause. Hundreds of files still come back, the gate prints a confident count, and CI is green over an invariant nobody is checking any more.
#
# The fix is structural rather than advisory. `collectOrExit` refuses a root that declares no anchor, so a gate cannot take the zero-file floor without also taking the anchor stop; "routes through the helper" therefore means "carries both stops", which is the one thing a syntactic check like this one can never establish on its own. This gate only has to prove the routing.
#
# Vacuity floor: the pinned manifest below, in the exact-reading-count spirit of tofixed-inventory.json. Without it a recogniser that silently stopped matching would report zero offenders and read exactly like a fully migrated tree. Set-equality is asserted in BOTH directions, so a new walk gate cannot join without a deliberate edit here, and a gate that stops walking cannot leave without one either.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-blind-walk

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"
# Overridable so no-blind-walk.selftest.sh can drive this exact script over fixture trees rather than re-implementing its matching.
GUARD_ROOT="${GUARD_ROOT:-$root}"

# The pinned gate set, overridable ONLY for this gate's own self-test, which needs a manifest matching its fixture tree. lint.sh clears the variable before the real run so a value left in the environment cannot narrow the floor.
WALK_GATE_MANIFEST="${WALK_GATE_MANIFEST:-}"

# Derived from $root, never from $GUARD_ROOT: a fixture tree must not be able to supply its own walk helper and define away the very stops this gate exists to require.
CI_WALK_LIB="$root/scripts/ci/lib/walk.mjs" GUARD_ROOT="$GUARD_ROOT" WALK_GATE_MANIFEST="$WALK_GATE_MANIFEST" bun -e '
const { collectOrExit } = await import(process.env.CI_WALK_LIB);
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// This file names the walk API in its own recogniser, so an unfiltered scan reports it as an offender. Excluded by exact name, never by pattern, so a rename cannot silently widen the exclusion — the same convention no-busybox-incompatible-grep.sh uses for itself. Being excluded from the SCAN is not an exemption from the RULE: this gate routes its own walk through the helper and carries its own override seam, and both are asserted below rather than assumed.
const SELF = "no-blind-walk.sh";

// The pinned set. Every name here must route its walk through the helper, and nothing outside it may walk at all.
const MANIFEST = [
  "no-arbitrary-color-token.sh",
  "no-broken-admonition.sh",
  "no-broken-grid-card.sh",
  "no-busybox-incompatible-grep.sh",
  "no-decimal-tostring-cast.sh",
  "no-error-cast.sh",
  "no-hyphenated-trailing-trade.sh",
  "no-invalid-mermaid.sh",
  "no-locks.sh",
  "no-phantom-alert-metric.sh",
  "no-phantom-env-var.sh",
  "no-plugin-leak.sh",
  "no-stale-comment-refs.sh",
  "no-stale-migration-doc.sh",
  "no-stale-screenshot.sh",
  "no-stripped-err-log.sh",
  "no-uncommented-coverage-ignore.sh",
  "no-undeclared-workspace-import.sh",
  "no-unreviewed-tofixed.sh",
  "no-unwired-test-d.sh",
  "no-wider-metrics-sink.sh",
  "no-web-api-query-drift.ts",
  "turbo-sees-strategy.sh",
];

// A gate may still read a directory directly, but only where the listing is not a verdict — and then it is registered here with the reason written at the call site, rather than left to be inferred from its absence. An unregistered raw walk is the blind walk this gate is named for.
const RAW_WALK_REGISTERED = ["no-stale-screenshot.sh"];

// Only the "declared but absent" direction of this floor is reachable, and that is structural rather than an oversight: the classification below reads FROM this list, so the live set is always a subset of it and nothing can ever be "only in the tree". A module that starts walking without being declared here is not missed — it falls through to the walk-gate manifest and surfaces there as an unrouted blind walk, which is the louder of the two diagnostics anyway. Kept as a diff rather than a one-way check so the drift reads the same way as the two floors above it.
//
// Modules that export a walk instead of deciding with one. They are held to a different bar because the two stops would be in the wrong place here: neither module prints a verdict, and each takes its root as a PARAMETER, which is a stricter seam than the environment override a gate needs — a caller cannot reach them without choosing a root. What makes their narrowing safe is that each refuses a short result itself before returning one, at `declared workspace has no package.json`, `missing complete-suite lcov for:` and `no lcov source records found`. Pinned in both directions like every other set here, so a third module cannot join by being a library, and one that stops walking cannot leave unnoticed.
const LIBRARY_WALKERS = ["merge-coverage.ts", "workspaces.ts"];

// The override seam a self-test needs to point the real gate at a deliberately broken fixture tree. The `${GUARD_ROOT:-` form is the whole assertion: a gate that writes GUARD_ROOT="$root" also mentions the variable but pins it to the repo root, so matching the name alone would pass on every gate and prove nothing. Without the seam a gate stop branch cannot be driven at all, and a stop nobody has ever watched fire is not evidence — which is why this belongs beside the routing check rather than in an audit nothing runs.
// One per language, because the seam is a spelling, not a concept: a shell gate parameterises its root with the `:-` default, a TypeScript one reads the same variable through `process.env`. An unrecognised spelling lands the gate in the seamless list, so a new one fails LOUDLY here and is added deliberately rather than being waved through.
const Q = String.fromCharCode(39);
// Both quote spellings count. The seam is that the root is a parameter, not that it was written with a particular quote, and rejecting one style would only teach the next author to satisfy the recogniser.
const TS_SEAM = ["process.env[" + Q + "GUARD_ROOT" + Q + "]", "process.env[\"GUARD_ROOT\"]"];
const SEAM_BY_EXT = {
  ".sh": ["GUARD_ROOT=\"${GUARD_ROOT:-"],
  ".ts": TS_SEAM,
};
const SEAM = SEAM_BY_EXT[".sh"][0];

// Keyed on the real extension rather than a "ends with .ts, else treat as shell" test. That fallback silently bucketed every unrecognised extension into the shell recognisers, which is how a whole file class goes unseen: a gate written in a third language would have matched neither the shell helper string nor the shell seam, been classified as not walking at all, and left the printed total reading as a fully routed tree.
//
// Reaching that conclusion needs the scan to admit the file first. An extension allow-list in the walk predicate cannot: it filters out precisely the file the tables have not been taught, so the untaught branch is unreachable by construction and the refusal is decoration. The predicate below therefore takes everything at depth 1 except the registered non-gate data, and a file that walks by ANY recognised spelling but has no recogniser of its own stops this gate here.

// One override file carries both floors, `lib:`-prefixed for the library set. A second environment variable would be a second thing to remember to clear, and lint.sh can only unset what it knows about.
const manifestOverride = process.env.WALK_GATE_MANIFEST;
const overrideLines = manifestOverride
  ? fs.readFileSync(manifestOverride, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
  : null;
const expected = overrideLines ? overrideLines.filter((l) => !l.startsWith("lib:")) : MANIFEST;
const expectedLibraries = overrideLines
  ? overrideLines.filter((l) => l.startsWith("lib:")).map((l) => l.slice(4))
  : LIBRARY_WALKERS;

// Assembled from fragments so this file does not contain the literals it searches for; that is what lets the scan below read every gate including the ones that quote the API in prose.
const PRIMITIVE = new RegExp(["readdir", "opendir", "glob"].map((n) => n + "S" + "ync").join("|"));
// Routing has a spelling per language too. A shell gate reaches the helper through the CI_WALK_LIB indirection it exports to `bun -e`; a TypeScript gate imports the module directly, and never mentions that variable. Matching only the shell spelling would read every TS gate as "does not route", or — worse, once it also stops matching a primitive — as not walking at all.
const HELPER_BY_EXT = { ".sh": "CI_WALK" + "_LIB", ".ts": "lib/walk" + ".mjs" };
const HELPER = HELPER_BY_EXT[".sh"];
// A file class is taught only when BOTH recognisers know it. Half a table is worse than none: routing would be judged by the right spelling and the seam by nothing.
const TAUGHT_EXTS = Object.keys(HELPER_BY_EXT).filter((e) => SEAM_BY_EXT[e] !== undefined);

// Data that lives beside the gates and executes nothing. Registered by extension rather than filtered by an allow-list of gate extensions, so the unknown file is admitted and classified instead of dropped unseen.
// The empty string covers a dot-leading name with no other dot: path.extname of a bare .gitignore is the empty string, so a dotfile would otherwise be admitted and read.
const NON_GATE_EXTS = [".json", ".md", ".txt", ".yml", ".yaml", ""];

const gates = collectOrExit({
  root,
  label: "CI gate scripts",
  flat: true,
  // `flat` keeps this at depth 1, which is why lib/ and __fixtures__ are never read: the helper itself walks, and every fixture tree is deliberately broken, so both would be scanned as offenders. Depth is the exclusion, so neither needs a name here that a re-layout could leave behind.
  test: (p) => !p.endsWith(".selftest.sh") && !NON_GATE_EXTS.includes(path.extname(p)),
  roots: [
    {
      name: path.join("scripts", "ci"),
      // The .ts anchor is not redundant beside the .sh ones. Gates were shell-only when this gate was written, and a TypeScript one walking unseen is exactly the blind walk it exists to refuse, so a narrowing that reached only the shell gates has to fail rather than report a routed tree.
      anchors: [
        path.join("scripts", "ci", "lint.sh"),
        path.join("scripts", "ci", "no-error-cast.sh"),
        path.join("scripts", "ci", "no-web-api-query-drift.ts"),
      ],
    },
  ],
});

const read = new Map(gates.map((p) => [path.basename(p), fs.readFileSync(p, "utf8")]));

// The scan-exclusion for this gate is not an exemption. Its own walk above must go through the helper, so that is asserted directly, in the same run, over the file actually on disk.
const selfSrc = read.get(SELF);
if (selfSrc !== undefined && !selfSrc.includes(HELPER)) {
  console.error(SELF + " is excluded from its own scan because it names the walk API in its text, and it no longer routes its own walk through the shared helper. The exclusion is only sound while that holds.");
  process.exit(1);
}
if (selfSrc !== undefined && !selfSrc.includes(SEAM)) {
  console.error(SELF + " is excluded from its own scan, and it no longer carries the override seam it requires of every other gate. The exclusion is only sound while that holds.");
  process.exit(1);
}

// A seam nothing clears is not a seam, it is a redirect. Every gate that carries the seam reads GUARD_ROOT from the environment, and a substitute tree that carries the declared anchors satisfies both walk stops, so every one of them would print its usual count over a tree that is not the repo. lint.sh is the single place that can close it for all of them at once, which is why the sweep is asserted here rather than left to each gate.
//
// Three things make the clearing real, and a substring test establishes none of them: the line has to be live rather than commented out, it has to name every override and not just the one this gate is called after, and it has to run BEFORE the first gate. A sweep appended below the gates clears the environment for nobody.
// Which seams must be cleared is a judgement, not a derivation. Each name here scopes WHAT a gate looks at — its root, its runner, its config, its pinned manifest — so an ambient value changes what the verdict of that gate means; the names in AMBIENT_BY_DESIGN below are inputs CI legitimately supplies, and clearing them would break the run. Deriving the sweep from every seam would therefore be wrong. Leaving it hand-written is the other failure: this list is checked against the seams actually present, and that check is what caught MIGRATIONS_RUNNER arriving with a new migration gate.
// GUARD_DIR and GUARD_RUNNER are not read as `${VAR:-}` anywhere; both migration gates reassign them unconditionally. They are swept defensively and listed here so this set stays identical to the line lint.sh actually runs.
const SWEPT_VARS = ["GUARD_ROOT", "GUARD_DIR", "GUARD_RUNNER", "WALK_GATE_MANIFEST", "MIGRATIONS_DIR", "MIGRATIONS_RUNNER", "OXLINT_CONFIG", "PROMTOOL_VERSION"];
const lintSrc = read.get("lint.sh");
if (lintSrc !== undefined) {
  const lines = lintSrc.split("\n");
  // Recognised by invocation shape rather than by one quoting style. `dirname "$0"` was the whole test, and this repo already writes `dirname -- "$0"` in newer gates, so tidying lint.sh to that spelling silently turned the position check below off. `source` is excluded because loading _common.sh is not a gate and legitimately precedes the sweep; `bunx` does not match because `bun` must be followed by whitespace.
  //
  // The leading `^\s*` is load-bearing beyond tidiness: it is what makes a commented-out invocation unmatchable, so no separate liveness test is needed here or below. Both finders once carried one, and it could not change either answer — a `#`-leading line fails this anchor, and fails the `unset` token test below for the same reason. A check that cannot change an answer reads as protection and is not.
  const GATE_LINE = /^\s*(?:env\s+[^|;]*?\s)?(?:bash|bun|sh)\s/;
  const firstGate = lines.findIndex((l) => GATE_LINE.test(l) && !l.includes("source "));
  // Column 0 is required because an `unset` indented inside an `if` that is not taken, or inside a function body nobody calls, is present in the text and clears nothing. Indentation is the cheap approximation of "runs unconditionally at top level", and it is what every correct spelling of this line already looks like. Full shell parsing would be the only exact answer and is not worth it here.
  const sweptAt = lines.findIndex((l) => {
    if (l !== l.trimStart()) return false;
    const tokens = l.trim().split(/\s+/);
    return tokens[0] === "unset" && SWEPT_VARS.every((v) => tokens.includes(v));
  });
  // Refused rather than skipped. `firstGate === -1` used to mean "cannot check the position, so do not", which is the shape of a guard that stops applying without saying so — the same defect this gate is named for.
  if (firstGate === -1) {
    console.error("UNSWEPT SEAM — no gate invocation could be located in scripts/ci/lint.sh, so the clearing cannot be shown to run before the gates.");
    console.error("");
    console.error("A gate is recognised as a live bash/bun/sh line that is not a `source`. If lint.sh now invokes gates another way, this checker stopped making the position half of the check rather than failing — which is the failure it exists to refuse.");
    console.error("Fix: teach GATE_LINE the new invocation spelling, or restore one this checker recognises.");
    process.exit(1);
  }
  if (sweptAt === -1 || sweptAt > firstGate) {
    const carriers = [...read].filter(([n, src]) => (SEAM_BY_EXT[path.extname(n)] ?? []).some((needle) => src.includes(needle))).length;
    console.error("UNSWEPT SEAM — scripts/ci/lint.sh does not clear GUARD_ROOT before running the gates.");
    console.error("");
    console.error(carriers + " gates resolve GUARD_ROOT from the environment so their self-tests can drive them. Left set, it redirects all of them at another tree, and a tree carrying the declared anchors passes both stops silently.");
    console.error(sweptAt === -1
      ? "No top-level line clearing " + SWEPT_VARS.join(" ") + " was found."
      : "The clearing at line " + (sweptAt + 1) + " runs after the first gate at line " + (firstGate + 1) + ", so every gate above it still sees the ambient value.");
    console.error("Fix: unset " + SWEPT_VARS.join(" ") + " near the top of lint.sh, before the first gate runs.");
    process.exit(1);
  }
}

// A sweep is only complete against a known set of seams, and that set was three names somebody typed. Every `${NAME:-` in a gate is a value the caller supplies and the gate then reads, so each one is either swept above or declared an ambient input here, and a seam in neither stops this gate until it is classified. Without this the next verdict-scoping override joins the ambient set by default and the sweep keeps reporting itself complete.
//
// One direction only. A fixture tree carries a subset of the real seams by construction, so demanding every pinned name be present would fail on every fixture; a name left here after its gate stops reading it is stale, not unsafe.
const AMBIENT_BY_DESIGN = [
  "BINFMT_IMAGE",
  "BUN_IMAGE",
  "CHECK",
  "DATABASE_TEST_URL",
  "DOCKER_HOST",
  "GIT_SHA",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "PUSH",
  "REDIS_TEST_URL",
];
const SEAM_VAR = new RegExp("\\$\\{([A-Z][A-Z0-9_]*):-", "g");
const unclassified = [];
const compareEntryNames = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
for (const [name, src] of [...read].sort(compareEntryNames)) {
  // lint.sh is the sweeper, not a gate. SELF is excluded for the reason it is excluded from the scan: it names the seam pattern in its own recogniser prose, so an unfiltered pass reports its own comment as an offender. Its one real seam is GUARD_ROOT, asserted directly above.
  if (name === "lint.sh" || name === SELF) continue;
  for (const m of src.matchAll(SEAM_VAR)) {
    const found = m[1];
    if (SWEPT_VARS.includes(found) || AMBIENT_BY_DESIGN.includes(found)) continue;
    const entry = found + " (scripts/ci/" + name + ")";
    if (!unclassified.includes(entry)) unclassified.push(entry);
  }
}
if (unclassified.length > 0) {
  console.error("UNCLASSIFIED ENVIRONMENT SEAM — these gates read a caller-supplied value that lint.sh neither clears nor declares an ambient input:");
  for (const entry of unclassified) console.error("    " + entry);
  console.error("");
  console.error("A seam that scopes WHAT a gate looks at changes what its verdict means, so it must be cleared; one CI legitimately supplies must not be, or the run breaks. Defaulting to ambient is how a verdict-scoping override goes unswept beside the ones that are.");
  console.error("Fix: add it to SWEPT_VARS and to the unset line in lint.sh, or to AMBIENT_BY_DESIGN with the reason it is an input.");
  process.exit(1);
}

const walkers = [];
const rawWalkers = [];
const libraries = [];
const blind = [];
const seamless = [];
const untaught = [];
for (const [name, src] of [...read].sort(compareEntryNames)) {
  if (name === SELF) continue;
  const ext = path.extname(name);
  // Classified by extension BEFORE asking whether it walks, and that order is the whole point. The walk test is itself a set of language-specific spellings — three JavaScript directory primitives and two helper paths — so a gate written with `os.walk` or `filepath.WalkDir` answers "does not walk", takes the early continue below, and is never seen at all. That is precisely the file class this branch exists to catch, so it cannot be gated on a vocabulary that class does not share.
  if (!TAUGHT_EXTS.includes(ext)) {
    untaught.push(name);
    continue;
  }
  const usesHelper = src.includes(HELPER_BY_EXT[ext]);
  const usesPrimitive = PRIMITIVE.test(src);
  if (!usesHelper && !usesPrimitive) continue;
  if (expectedLibraries.includes(name)) {
    libraries.push(name);
    continue;
  }
  walkers.push(name);
  if (usesPrimitive) rawWalkers.push(name);
  if (!usesHelper) blind.push(name);
  if (!SEAM_BY_EXT[ext].some((needle) => src.includes(needle))) seamless.push(name);
}

let failed = false;
const diff = (label, actual, pinned, hint) => {
  const extra = actual.filter((n) => !pinned.includes(n));
  const gone = pinned.filter((n) => !actual.includes(n));
  if (extra.length === 0 && gone.length === 0) return;
  console.error(label);
  if (extra.length > 0) console.error("  only in the tree: " + extra.join(", "));
  if (gone.length > 0) console.error("  only in the manifest: " + gone.join(", "));
  console.error("  " + hint);
  failed = true;
};

diff(
  "The walk-gate set drifted from the pinned manifest.",
  walkers,
  expected,
  "A new walk gate must be added to this manifest, and a gate that stopped walking must be removed from it. The manifest is the vacuity floor: without it a recogniser that matched nothing would report a fully migrated tree.",
);

diff(
  "The registered raw-walk set drifted.",
  rawWalkers,
  RAW_WALK_REGISTERED,
  "A gate may read a directory directly only where the listing is not a verdict, and only with the reason written at the call site and the name registered here. Register it deliberately or route it through the helper.",
);

diff(
  "The registered library-walker set drifted.",
  libraries,
  expectedLibraries,
  "A module here exports a walk and decides nothing, and its callers must already refuse a short result. If it grew a verdict of its own it belongs in the walk-gate manifest instead; if it stopped walking, drop it from this list.",
);

if (seamless.length > 0) {
  console.error("NO OVERRIDE SEAM — these gates hard-code the repo root, so no self-test can point them at a fixture tree:");
  for (const name of seamless) console.error("    scripts/ci/" + name);
  console.error("");
  console.error("Both walk stops exit 1 with different sentences, and a gate whose stops have never been driven is a gate nobody has watched fail. Without the seam they cannot be driven at all.");
  console.error("Fix: GUARD_ROOT=\"${GUARD_ROOT:-$root}\" before the walk, as no-error-cast.sh does, plus a self-test that runs the real gate over a broken fixture tree.");
  failed = true;
}

if (untaught.length > 0) {
  console.error("UNTAUGHT FILE CLASS — this gate has no routing or seam recogniser for the extension of these files, so it cannot say whether they walk:");
  for (const name of untaught) console.error("    scripts/ci/" + name);
  console.error("");
  console.error("Routing and the override seam are spellings, not concepts: a shell gate reaches the helper through an exported path variable and parameterises its root with the `:-` default, a TypeScript one imports the module and reads process.env. A language whose walk verbs and helper spelling are both unknown here cannot be judged at all — asked the question it answers \"does not walk\", and the printed total then reads as a fully routed tree over a walk nobody has seen.");
  console.error("Fix: add the extension to BOTH recogniser tables with the spelling that language uses, or register it in NON_GATE_EXTS if it executes nothing.");
  failed = true;
}

if (blind.length > 0) {
  console.error("BLIND WALK — these gates decide a verdict from a tree walk they obtain themselves:");
  for (const name of blind) console.error("    scripts/ci/" + name);
  console.error("");
  console.error("A walk that returns nothing is caught by the floor each of them already carries. A walk that merely narrowed is not: it still returns files, the gate prints a confident count, and that count is indistinguishable from a clean tree.");
  console.error("Fix: take the walk from scripts/ci/lib/walk.mjs via collectOrExit, declaring each root and the module under it the rule exists to protect.");
  failed = true;
}

if (failed) process.exit(1);

console.log(
  "no-blind-walk gate: OK (" + walkers.length + " walk gates, all routed through the shared helper; " +
    rawWalkers.length + " registered raw listing(s), all fault-injectable; " +
    libraries.length + " root-parameterised walk librar(ies))",
);
'
