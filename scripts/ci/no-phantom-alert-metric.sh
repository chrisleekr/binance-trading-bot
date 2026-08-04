#!/usr/bin/env bash
set -euo pipefail
# Phantom-alert-metric gate. Every metric name an alert rule's `expr:` reads must
# be a name this repo actually emits, or a series Prometheus itself synthesises.
#
# `promtool check rules` validates PromQL SYNTAX, not series existence, so a rule
# over a metric nothing emits parses clean and evaluates to an empty vector
# forever. It never fires and never errors, which makes it indistinguishable from
# a healthy rule that simply has not tripped. An operator who installs the shipped
# rules believes they are covered against, say, a Binance weight ban and is not.
#
# The emitted set is assembled from two independent sources so no sink has to be
# hardcoded here:
#   1. The worker's closed catalogue (`MetricName` union + `CATALOG` keys). Both
#      are parsed and diffed against each other: TypeScript already keeps them in
#      step, so a divergence means this parser regressed, not that the code moved.
#   2. Every `new Counter/Gauge/Histogram/Summary({ name: '...' })` under apps/**
#      and packages/**. That picks up the api HTTP sink and the @app/observability
#      process metrics by construction, so a future sink is covered the day it
#      lands rather than the day someone remembers to edit a list here.
# On top of that, two small exact-match sets cover series no repo code declares:
# Prometheus' synthesised `up`, and the prom-client default process/nodejs
# metrics. Both match exactly, never by prefix, so `up_wrong` is still reported.
#
# Tokenising is SUBTRACTIVE (strip strings, label matchers, range selectors,
# grouping label lists, modifiers and numeric literals, then read what is left)
# so a parse miss over-reports and fails the build rather than skipping a name.
# Only `expr:` values are scanned; annotations legitimately carry
# `{{ $labels.profileId }}` and prose.
#
# Two YAML shapes would otherwise let a phantom through silently, so both are
# handled rather than skipped: a fully quoted `expr:` scalar (the quote strip
# would eat the whole expression) and a `{__name__="x"}` matcher (the brace strip
# would eat the name before it was read). A regex-valued `__name__` matcher
# cannot be resolved to a concrete series at all, so it is a hard error.
#
# Vacuity floors fail the gate rather than pass it: zero catalogue names, zero
# constructed names, zero rules, zero exprs, and any single expr that names no
# metric. That last one is per-expr on purpose: a global count would let one
# healthy rule mask a sibling whose expression was parsed to nothing. Plus a
# count assert that every rule head yielded an expr, so a block-scalar miss fails
# red instead of silently scanning nothing. A drift gate that passes vacuously is
# worse than no gate.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs, not a recursive grep.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-phantom-alert-metric

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$root}"
cd "$root"

GUARD_ROOT="$GUARD_ROOT" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const fail = (msg) => { console.error(msg); process.exit(1); };

// ---------------------------------------------------------------------------
// Emitted set, source 1: the worker catalogue.
// ---------------------------------------------------------------------------
const catalogPath = path.join(root, "apps/worker/src/metrics/catalog.ts");
if (!fs.existsSync(catalogPath)) fail("apps/worker/src/metrics/catalog.ts not found — catalogue path regression in this gate.");
const catalogSrc = fs.readFileSync(catalogPath, "utf8");

// \x27 rather than a literal quote throughout: this whole program is a
// single-quoted bash argument, so an apostrophe would end it.
// Union members: everything quoted between `export type MetricName =` and its `;`.
const unionStart = catalogSrc.indexOf("export type MetricName =");
if (unionStart < 0) fail("no `export type MetricName =` in the catalogue — union parser regression in this gate.");
const unionBody = catalogSrc.slice(unionStart, catalogSrc.indexOf(";", unionStart));
const unionNames = new Set([...unionBody.matchAll(/\x27([A-Za-z_:][A-Za-z0-9_:]*)\x27/g)].map((m) => m[1]));

// CATALOG entries: 2-space keys are entries, 4-space fields are the spec, so the
// indent alone separates them without needing a brace-depth parser.
const catalogKinds = new Map();
{
  const lines = catalogSrc.split(/\r?\n/);
  let inside = false;
  let key = null;
  for (const line of lines) {
    if (!inside) { inside = /^export const CATALOG\b/.test(line); continue; }
    if (/^\};/.test(line)) break;
    const entry = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/);
    if (entry) { key = entry[1]; continue; }
    const kind = line.match(/^ {4}kind:\s*\x27([a-z]+)\x27/);
    if (kind && key) { catalogKinds.set(key, kind[1]); key = null; }
  }
}

if (unionNames.size === 0 || catalogKinds.size === 0) {
  fail("zero metric names parsed from the worker catalogue — catalogue parser regression in this gate.");
}

const onlyUnion = [...unionNames].filter((n) => !catalogKinds.has(n));
const onlyCatalog = [...catalogKinds.keys()].filter((n) => !unionNames.has(n));
if (onlyUnion.length > 0 || onlyCatalog.length > 0) {
  fail(
    "MetricName union and CATALOG keys disagree — parser regression in this gate (TypeScript already couples them):\n" +
      [...onlyUnion.map((n) => "  union only: " + n), ...onlyCatalog.map((n) => "  CATALOG only: " + n)].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Emitted set, source 2: prom-client constructor call sites across the repo.
// ---------------------------------------------------------------------------
const SKIP_DIR = new Set(["node_modules", "dist", "__tests__"]);
const tsFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) tsFiles(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};
const files = [...tsFiles(path.join(root, "apps")), ...tsFiles(path.join(root, "packages"))];

const CTOR_KIND = { Counter: "counter", Gauge: "gauge", Histogram: "histogram", Summary: "summary" };
const CTOR = /new\s+(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?(Counter|Gauge|Histogram|Summary)\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const constructed = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(CTOR)) {
    // Bound the search at the closing `})` of this very call rather than at a
    // character count. A fixed window can run past the call and adopt an
    // unrelated `name:` literal as a declared metric, which is fail-OPEN: it
    // would stop a real phantom being reported. A spread-built options object
    // (no literal name) truncates to nothing and is skipped, which fails closed.
    const rest = src.slice(m.index);
    const close = rest.search(/\}\s*\)/);
    if (close === -1) continue;
    const named = rest.slice(0, close).match(/\bname:\s*[\x27"]([A-Za-z_:][A-Za-z0-9_:]*)[\x27"]/);
    if (named) constructed.set(named[1], CTOR_KIND[m[1]]);
  }
}
if (constructed.size === 0) {
  fail("zero prom-client metric constructors found under apps/ or packages/ — scan-path regression in this gate.");
}

const declared = new Map([...catalogKinds, ...constructed]);

// Series no repo code declares. Exact match only: a prefix rule would silently
// bless `up_wrong` and every typo that happens to start with a real name.
const PROM_SYNTHESISED = new Set([
  "up", // Prometheus writes one per scrape target; the target never emits it
]);

// Registered by promClient.collectDefaultMetrics({ prefix: "" }) in
// packages/observability. Enumerated rather than prefix-matched for the same reason.
//
// Taken from prom-client 15.1.3 lib/metrics/*.js, not from a scrape, and pruned
// to what THIS runtime registers. lib/metrics/heapSpacesSizeAndUsed.js probes
// v8.getHeapSpaceStatistics() and returns early on ERR_NOT_IMPLEMENTED (its own
// comment says "Bun"), so nodejs_heap_space_size_{total,used,available}_bytes
// never exist here; blessing them would let an alert on one pass and then
// evaluate empty forever, which is the exact phantom this gate catches.
// process_virtual_memory_bytes and process_heap_bytes are kept even though
// lib/metrics/osMemoryHeap.js registers them only on linux: the deployment
// target is a linux container, so they are real where the rules run.
const DEFAULT_METRICS = new Set([
  "process_cpu_user_seconds_total",
  "process_cpu_system_seconds_total",
  "process_cpu_seconds_total",
  "process_start_time_seconds",
  "process_resident_memory_bytes",
  "process_virtual_memory_bytes", // linux only, see the note above
  "process_heap_bytes",           // linux only, see the note above
  "process_open_fds",
  "process_max_fds",
  "nodejs_eventloop_lag_seconds",
  "nodejs_eventloop_lag_min_seconds",
  "nodejs_eventloop_lag_max_seconds",
  "nodejs_eventloop_lag_mean_seconds",
  "nodejs_eventloop_lag_stddev_seconds",
  "nodejs_eventloop_lag_p50_seconds",
  "nodejs_eventloop_lag_p90_seconds",
  "nodejs_eventloop_lag_p99_seconds",
  "nodejs_active_resources",
  "nodejs_active_resources_total",
  "nodejs_active_handles",
  "nodejs_active_handles_total",
  "nodejs_active_requests",
  "nodejs_active_requests_total",
  "nodejs_heap_size_total_bytes",
  "nodejs_heap_size_used_bytes",
  "nodejs_external_memory_bytes",
  "nodejs_version_info",
  "nodejs_gc_duration_seconds",
]);

// The only default metric prom-client registers as a Histogram, so it is the only
// one whose _bucket/_sum/_count are real series. Kept separate from the name set
// above so no kind is claimed for a metric whose constructor was not checked.
const DEFAULT_METRIC_KINDS = new Map([["nodejs_gc_duration_seconds", "histogram"]]);

// ---------------------------------------------------------------------------
// Referenced set: expr values in the shipped alert rules.
// ---------------------------------------------------------------------------
const alertsPath = path.join(root, "deploy/observability/alerts.yml");
if (!fs.existsSync(alertsPath)) fail("deploy/observability/alerts.yml not found — rules path regression in this gate.");
const alertLines = fs.readFileSync(alertsPath, "utf8").split(/\r?\n/);

// A flow-style rule entry matches no block-style key pattern while still being a
// rule, so it would be skipped in silence with the counts still balanced. Reject
// the shape. The match requires a rule KEY inside the braces: a bare `- {` also
// begins an ordinary Go-template bullet (`- {{ $labels.profileId }}`) inside an
// annotation, which is legitimate and must not be mistaken for a rule.
const flow = alertLines.findIndex(
  (l) => /^\s*-\s*\{\s*(?:alert|record|expr)\s*:/.test(l) || /^\s*rules:\s*\[\s*\{/.test(l),
);
if (flow >= 0) {
  fail(
    "flow-style rule entry at deploy/observability/alerts.yml:" + (flow + 1) +
      " — this gate parses block style only. Write the rule as indented `- alert:` / `expr:` keys.",
  );
}

// A plain YAML scalar ends at an unquoted " #"; a quoted or block scalar does not.
const stripPlainComment = (s) => s.replace(/\s+#.*$/, "").trim();

// Index of the quote that closes a quoted scalar, honouring the escape each YAML
// style uses: doubling in single-quoted, backslash in double-quoted. Walking to
// it (rather than assuming the last character of the line) is what lets a
// trailing YAML comment follow a quoted expr, while a `#` inside the quotes
// stays part of the expression.
const closingQuote = (s, q) => {
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== q) continue;
    if (q === "\x27") {
      if (s[i + 1] === q) { i++; continue; }
      return i;
    }
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
};

// A quoted `expr:` scalar would be erased whole by the quote strip in the
// tokeniser, contributing no candidates. Unwrap it here so the PromQL inside is
// tokenised like any other expression.
const unwrapScalar = (s, lineNo) => {
  const q = s[0];
  // \x22 is a double quote: only an apostrophe would end the bash argument, but
  // both quote characters are escaped here so the two branches read alike.
  if (q !== "\x27" && q !== "\x22") return stripPlainComment(s);
  const close = closingQuote(s, q);
  if (close === -1) {
    fail(
      "unterminated quoted expr scalar at deploy/observability/alerts.yml:" + lineNo +
        " — this gate reads single-line quoted or block scalars only.",
    );
  }
  const tail = s.slice(close + 1).trim();
  if (tail !== "" && !tail.startsWith("#")) {
    fail(
      "unexpected content after the closing quote of the expr scalar at deploy/observability/alerts.yml:" +
        lineNo + " — only a trailing YAML comment may follow it.",
    );
  }
  const inner = s.slice(1, close);
  return q === "\x27" ? inner.replace(/\x27\x27/g, "\x27") : inner.replace(/\\(.)/g, "$1");
};

// Rules are read as ENTRIES rather than as a stream of keys. An entry begins at
// the dash that introduces it, whichever of its keys comes first, so `expr:`
// leading a rule is parsed like any other ordering instead of going uncounted.
// Sibling keys are then matched at exactly the entry key column, which keeps a
// block-scalar annotation containing `expr:` or `alert:` from being read as one.
const ENTRY_START = /^(\s*)-\s*(?:alert|record|expr)\s*:/;
const entries = [];
for (let i = 0; i < alertLines.length; i++) {
  const start = ENTRY_START.exec(alertLines[i]);
  if (!start) continue;
  const dashCol = start[1].length;
  let j = i + 1;
  for (; j < alertLines.length; j++) {
    if (alertLines[j].trim() === "") continue;
    if (alertLines[j].match(/^\s*/)[0].length <= dashCol) break;
  }
  entries.push({ first: i, lines: alertLines.slice(i, j) });
  i = j - 1;
}

if (entries.length === 0) fail("zero alert rules parsed from deploy/observability/alerts.yml — rules parser regression in this gate.");

const exprs = [];
const missingExpr = [];
for (const entry of entries) {
  // Blank the dash so the first key sits at the same column as its siblings.
  const lines = entry.lines.slice();
  lines[0] = lines[0].replace(/^(\s*)-/, "$1 ");
  const keyCol = lines[0].match(/^\s*/)[0].length;
  const keyAt = new RegExp("^\\s{" + keyCol + "}(alert|record|expr):\\s*(.*)$");

  let rule = "(unnamed)";
  let expr = null;
  let exprLine = -1;
  for (let k = 0; k < lines.length; k++) {
    const key = keyAt.exec(lines[k]);
    if (key === null) continue;
    if (key[1] !== "expr") {
      if (rule === "(unnamed)") rule = key[2].trim();
      continue;
    }
    if (expr !== null) continue;
    exprLine = entry.first + k;
    const inline = key[2].trim();
    if (!/^[|>]/.test(inline)) { expr = unwrapScalar(inline, exprLine + 1); continue; }
    // Block scalar: the value is every following line indented past the key column.
    const buf = [];
    for (let b = k + 1; b < lines.length; b++) {
      if (lines[b].trim() === "") continue;
      if (lines[b].match(/^\s*/)[0].length <= keyCol) break;
      buf.push(lines[b].trim());
    }
    expr = buf.join(" ");
  }

  if (expr === null) { missingExpr.push(rule); continue; }
  exprs.push({ rule, expr, exprLine });
}

if (exprs.length === 0) fail("zero expr values parsed from deploy/observability/alerts.yml — expr parser regression in this gate.");
if (missingExpr.length > 0) {
  fail(
    "rule entries with no expr key: " + missingExpr.join(", ") +
      " — every rule carries one, so this is an expr parser regression in this gate.",
  );
}

// Only keywords that can actually reach the identifier pass as BARE tokens.
//
// Aggregation operators (sum, max, topk, quantile, limitk, …) are deliberately
// absent. Every legal spelling puts them in front of a `(` — `sum(x)`,
// `sum by (job) (x)`, `sum(x) by (job)` — and the grouping strip below leaves
// that `(` in place, so the call-applied rule already drops them. Listing them
// anyway would mean a real metric that happened to be named `count` or `group`
// was silently blessed, which is fail-open in a file whose whole design is
// fail-closed. `start` and `end` are absent for the same reason: they are legal
// only as `@ start()` / `@ end()`.
//
// `atan2` is here because, unlike the other operators spelled as words, it is a
// BINARY operator written between its operands, so it does appear bare.
// The six vector-matching keywords are belt-and-braces behind the grouping
// strip: each is also legal without a label list (`group_left` alone).
const PROMQL_KEYWORDS = new Set([
  "and", "or", "unless", "bool", "offset", "atan2",
  "by", "without", "on", "ignoring", "group_left", "group_right",
  "Inf", "NaN",
]);

// A rule may legitimately name no metric: a dead-man switch watchdog is
// `expr: vector(1)` by construction. Opting one out is explicit and per-rule, so
// silence still fails; the author writes the marker on the line above `expr:`.
const OPT_OUT = /^\s*#\s*names-no-metric:\s*\S/;

// `{__name__="x"}` selects metric x exactly as a bare `x` does, so the name has
// to be read before the brace strip removes it.
const NAME_MATCHER = /__name__\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27)/g;

const candidates = [];
for (const { rule, expr, exprLine } of exprs) {
  const found = [];

  for (const m of expr.matchAll(NAME_MATCHER)) {
    if (m[1] !== "=") {
      fail(
        "rule " + rule + " selects a metric with `__name__" + m[1] + "` — this gate cannot resolve a regex or negated " +
          "name matcher to a concrete series. Name the metric directly in the expression.",
      );
    }
    found.push(m[2].slice(1, -1));
  }

  const stripped = expr
    .replace(/\x27[^\x27]*\x27|"(?:[^"\\]|\\.)*"|`[^`]*`/g, " ") // quoted label values
    .replace(/\{[^}]*\}/g, " ") // label matchers
    .replace(/\[[^\]]*\]/g, " ") // range and subquery selectors
    // Grouping and vector-matching label lists sit in round brackets, which are
    // never stripped, so their labels would otherwise read as metric names.
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ")
    // Offset modifier and its duration. The unit group repeats because PromQL
    // durations compound (`1h30m`), and a leftover `30m` survives the numeric
    // strip as a bare `m`. `ms` leads the alternation so it is not read as `m`
    // plus a stray `s`. No fractional part: PromQL does not allow one.
    .replace(/\boffset\s+-?(?:\d+(?:ms|[smhdwy]))+/g, " ")
    .replace(/@\s*-?\d+(?:\.\d+)?/g, " ") // @ timestamp modifier
    // Word-boundary anchored so a digit inside an identifier survives and the
    // name is still reported: binance_weight_used_1m keeps its _1m.
    .replace(/\b\d+(?:\.\d+)?\b/g, " ");

  for (const m of stripped.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*\s*\(?/g)) {
    // A metric name is never call-applied, so a trailing `(` marks a function.
    // That kills rate/increase/histogram_quantile with no list to maintain.
    if (m[0].endsWith("(")) continue;
    const name = m[0].trim();
    if (PROMQL_KEYWORDS.has(name)) continue;
    found.push(name);
  }

  // Per-expr, not global: a global count lets one healthy rule mask a sibling
  // whose expression was parsed down to nothing, which is the exact silent pass
  // this gate exists to stop. A watchdog opts out by saying so above its expr.
  if (found.length === 0 && !OPT_OUT.test(alertLines[exprLine - 1] ?? "")) {
    fail(
      "expr for rule " + rule + " names no metric — expr tokeniser regression in this gate, or a rule that " +
        "watches nothing and can never fire. A rule that names none on purpose (a vector(1) watchdog) " +
        "declares it with a `# names-no-metric: <reason>` comment on the line above its expr.",
    );
  }
  for (const name of found) candidates.push({ rule, name });
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------
// Prometheus derives these from the parent metric, and only for these kinds: a
// counter or gauge named `foo` gives no `foo_sum`, so a typo like `decision_count`
// -> `decision_count_sum` must still be reported.
const DERIVED_SUFFIXES = { histogram: new Set(["count", "sum", "bucket"]), summary: new Set(["count", "sum"]) };
const kindOf = (name) => declared.get(name) ?? DEFAULT_METRIC_KINDS.get(name);

const isEmitted = (name) => {
  if (declared.has(name) || PROM_SYNTHESISED.has(name) || DEFAULT_METRICS.has(name)) return true;
  const derived = name.match(/^(.+)_(count|sum|bucket)$/);
  if (derived === null) return false;
  const suffixes = DERIVED_SUFFIXES[kindOf(derived[1])];
  return suffixes !== undefined && suffixes.has(derived[2]);
};

const seen = new Set();
const phantoms = [];
for (const { rule, name } of candidates) {
  if (isEmitted(name)) continue;
  const dedupe = rule + " " + name;
  if (seen.has(dedupe)) continue;
  seen.add(dedupe);
  phantoms.push("  " + name + " (rule " + rule + ")");
}

if (phantoms.length > 0) {
  console.error("Alert rules reference metric names nothing emits:");
  console.error(phantoms.join("\n"));
  console.error("");
  console.error("For each: emit the metric (catalogue entry or prom-client constructor), correct the");
  console.error("name to one that is emitted, or delete the rule. A rule over a series nothing writes");
  console.error("evaluates empty forever, so it can never fire and never errors.");
  process.exit(1);
}

console.log(
  "no-phantom-alert-metric gate: OK (" + declared.size + " declared, " + candidates.length + " referenced)",
);
'
