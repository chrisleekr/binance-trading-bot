#!/usr/bin/env bash
set -euo pipefail
# Wider-metrics-sink gate. `apps/worker/src/metrics/catalog.ts` is the ONE module
# allowed to declare the metrics sink, and it types the metric name on the closed
# `MetricName` union. A second sink declaration typed on `string` compiles,
# satisfies every consumer of the real one, and accepts a name that is in no
# catalogue — so the metric is emitted, the catalogue never learns about it, the
# generated metrics reference never lists it, and an alert written against it
# evaluates empty forever. TypeScript cannot catch this: the wider type is a
# supertype, so assignment works in the direction that hurts.
#
# The match keys on the PARAMETER NAME, not just the type. `record(clientOrderId:
# string` is a legitimate unrelated method (the placement dedup ledger has one),
# and a gate that flagged it would be switched off within a week. Three spellings
# of the same widening are matched, because a gate that reads only one of them
# leaves the others as a way through: interface/class method syntax
# (`record(name: string`), property syntax (`record: (name: string`), and the
# same written across lines.
#
# Which methods get matched is READ OFF the sink declaration rather than named
# here, so a method added to the interface is guarded the moment it lands. The
# alternative fails open exactly where it hurts: the unguarded method is always
# the newest one.
#
# The catalogue itself is exempt from the file scan — it is the declaration this
# gate protects — so it gets its own assertion. Without it, widening the sink at
# its source legalises every call site at once while the file scan still passes.
#
# Keying on the parameter name leaves one hole this gate does NOT close: a second
# sink spelling it `record(metric: string` is not a candidate. Closing it means
# matching on the type alone, which flags the dedup ledger above on day one. So
# the hole is stated in docs/contributing/coding-rules.md rather than papered
# over, and the one place it could hide silently — the catalogue's own
# declaration — is failed loudly instead (below).
#
# Five ways this gate can stop meaning anything, each failing loudly with its own
# diagnostic rather than reporting OK: a scan that walked no candidate files (a
# path or extension change reports every file as clean), a catalogue file that is
# no longer where the gate looks, a catalogue with no `MetricsSink` declaration to
# read the method list from, a declaration carrying no `name`-first method, and a
# declaration carrying a member the `name` match would skip without saying so.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs, not a recursive grep.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-wider-metrics-sink

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
GUARD_ROOT="${GUARD_ROOT:-$root}"
cd "$root"

GUARD_ROOT="$GUARD_ROOT" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

const fail = (msg) => { console.error(msg); process.exit(1); };

const CATALOG_REL = "apps/worker/src/metrics/catalog.ts";
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

const catalogPath = path.join(root, CATALOG_REL);
const files = [...tsFiles(path.join(root, "apps")), ...tsFiles(path.join(root, "packages"))]
  .filter((f) => path.relative(root, f) !== CATALOG_REL);

if (files.length === 0) {
  fail(
    "zero candidate files under apps/ or packages/ — scan-path regression in this gate. " +
      "Every file reads as clean when none is walked, which is the failure a moved directory " +
      "or a new extension produces in silence.",
  );
}

// The line a match starts on, and that line verbatim. A diagnostic that quotes
// the source is one the reader can go straight to; a normalised rendering of the
// offence appears nowhere in the file and has to be hunted for.
const locate = (src, index) => {
  const before = src.slice(0, index);
  const lineNo = before.split(/\r?\n/).length;
  const start = before.lastIndexOf("\n") + 1;
  const end = src.indexOf("\n", index);
  return { lineNo, text: src.slice(start, end === -1 ? src.length : end).replace(/\s+$/, "") };
};

// \x27 rather than a literal quote: this program is a single-quoted bash argument.
// `record(` is method and class syntax, `record: (` is the property form; the
// \s* runs let either be written across lines.
// `[^,)]*` keeps the search inside the FIRST parameter, so `string` appearing
// later — `tags?: Readonly<Record<string, string>>` on every real sink — is not
// a match, while `name: MetricName | string` is. A union is the whole widening:
// it accepts any string, so pinning the literal spelling `name: string` would
// leave the one form an author actually reaches for when they want a loophole.
const wideRe = (method) =>
  new RegExp("\\b" + method + "\\s*(?:\\(|:\\s*\\()\\s*name\\s*:\\s*[^,)]*\\bstring\\b", "g");

if (!fs.existsSync(catalogPath)) {
  fail(CATALOG_REL + " not found — catalogue path regression in this gate.");
}
const catalogSrc = fs.readFileSync(catalogPath, "utf8");

// The guarded method names are DERIVED from the sink declaration, never listed
// in this gate. A literal list goes stale the day a method is added, and it
// fails open in the worst direction: the unguarded method is the newest one,
// the one whose call sites nobody has written yet. `forget` was added to this
// sink after `record`, and a gate naming only `record` would have shipped
// beside it already blind to half the interface it claims to protect.
const body = /export interface MetricsSink\s*\{([\s\S]*?)\n\}/.exec(catalogSrc);
if (!body) {
  fail(
    CATALOG_REL + " declares no `export interface MetricsSink` — this gate derives the methods " +
      "it guards from that declaration, so a rename leaves it guarding nothing while still " +
      "reporting OK.",
  );
}
//
// Every callable member is enumerated, not just the `name`-first ones, because
// the whole gate keys on that parameter spelling. A method declared
// `observe(metric: MetricName, ...)` carries a metric name the scan below would
// never look for, and silently dropping it from `guarded` is the same fail-open
// this derivation exists to end — one level further down. The gate cannot tell a
// differently-spelled metric name from a parameter that is not one, so it stops
// and makes a human say which.
// The type is captured up to the parameter boundary, not as one identifier: a
// one-word capture reads `name: MetricName | string` as `MetricName` and the
// widened check below then agrees the sink is narrow. Which side of the `|` the
// author wrote would decide whether CI catches them.
const members = [
  ...body[1].matchAll(/^[ \t]*(\w+)\s*(?:\(|:\s*\()\s*(?:(\w+)\s*:\s*([^,)]+))?/gm),
].map((m) => ({ method: m[1], param: m[2], type: m[3]?.trim() }));
const decls = members.filter((m) => m.param === "name");
if (decls.length === 0) {
  fail(
    CATALOG_REL + " declares MetricsSink with no method taking `name` first — there is nothing " +
      "to guard, so every file in the scan below reads as clean.",
  );
}
const offSpelling = members.filter((m) => m.param !== undefined && m.param !== "name");
if (offSpelling.length > 0) {
  fail(
    CATALOG_REL + " declares MetricsSink members this gate cannot guard:\n" +
      offSpelling.map((m) => "  " + m.method + "(" + m.param + ": " + m.type).join("\n") + "\n\n" +
      "The scan matches on the parameter being named `name`. Rename it to `name` if it takes a " +
      "metric name, so the widening check covers this method too. If it takes something else, " +
      "this gate needs teaching before the member lands — left as is, the method is exempt from " +
      "the check while the gate still reports OK.",
  );
}
const widened = decls.filter((d) => d.type !== "MetricName");
if (widened.length > 0) {
  fail(
    CATALOG_REL + " must type its sink on MetricName:\n" +
      widened.map((d) => "  " + d.method + "(name: " + d.type).join("\n") + "\n\n" +
      "This is the declaration every other module is measured against, so widening it here " +
      "legalises every call site at once and the file scan below still passes.",
  );
}
const guarded = decls.map((d) => d.method);

const offences = [];
let scanned = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  scanned++;
  for (const method of guarded) {
    if (!src.includes(method)) continue;
    for (const m of src.matchAll(wideRe(method))) {
      const at = locate(src, m.index);
      offences.push("  " + path.relative(root, file) + ":" + at.lineNo + ": " + at.text.trim());
    }
  }
}

if (offences.length > 0) {
  console.error("Metrics-sink declarations typed on `string` outside " + CATALOG_REL + ":");
  console.error(offences.join("\n"));
  console.error("");
  console.error("Type the parameter on MetricName and add the metric to CATALOG, or rename the");
  console.error("parameter if this is not a metrics sink. A sink typed on `string` accepts a name");
  console.error("no catalogue lists, so the series is emitted, never documented, and any alert");
  console.error("written against it evaluates empty forever.");
  process.exit(1);
}

console.log(
  "no-wider-metrics-sink gate: OK (" + scanned + " files, guarding " + guarded.join(", ") + ")",
);
'
