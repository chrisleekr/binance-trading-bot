#!/usr/bin/env bash
set -euo pipefail
# Phantom-env-var gate. Every key declared in `.env.example` must either be read
# by app source (apps/** or packages/** TS) or be on the infra-only allowlist
# below. A declared key with no reader and no allowlist entry is a phantom: it
# tells an operator to set something the code never consults, so a typo, a
# renamed reader, or a deleted feature leaves a dead knob in the one file the
# operator is told is the single source of truth.
#
# The reader test is one whole-word match per key over the app TS trees. It
# matches every read form uniformly — process.env['KEY'], a Zod schema field
# `KEY:`, and import.meta.env.KEY — because all three contain the bare token.
# Infra consumers (the postgres image's init env, docker/compose interpolation,
# the OTel SDK's env-based auto-config) never appear in TS, so those keys are
# enumerated in INFRA_ONLY with a per-key note rather than matched. A key that is
# neither read nor infra is reported, not silently allowlisted.
#
# Two vacuity guards fail the gate rather than pass it: zero declared keys parsed
# (the .env.example parser regressed) and zero readers resolved across all
# non-allowlisted keys (the scan path regressed). A drift gate that passes
# vacuously is worse than no gate.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-phantom-env-var

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Keys consumed only outside TS source. Each carries the consumer that reads it;
// anything not listed here must have an app reader.
const INFRA_ONLY = new Set([
  "POSTGRES_DB",               // postgres image init env (deploy/compose)
  "POSTGRES_USER",             // postgres image init env (deploy/compose)
  "POSTGRES_PASSWORD",         // postgres image init env (deploy/compose)
  "APP_HTTP_PORT",             // compose ports interpolation
  "IMAGE_TAG",                 // compose image tag interpolation
  "WORKER_REPLICAS",           // compose deploy.replicas interpolation
  "OTEL_SERVICE_NAME",         // OTel SDK env auto-config
  "OTEL_EXPORTER_OTLP_HEADERS",// OTel SDK env auto-config
]);

// Declared keys: leading KEY= lines only (commented examples start with #).
const envText = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const keys = [...new Set(
  envText.split(/\r?\n/)
    .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=/))
    .filter(Boolean)
    .map((m) => m[1]),
)];
if (keys.length === 0) {
  console.error("no declared keys parsed from .env.example — parser regression in this gate.");
  process.exit(1);
}

// Enumerate app/package TS source. Only src/ ships; __tests__/dist/node_modules do not.
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
const files = [
  ...tsFiles(path.join(root, "apps")),
  ...tsFiles(path.join(root, "packages")),
];
if (files.length === 0) {
  console.error("no TS files found under apps/ or packages/ — scan-path regression in this gate.");
  process.exit(1);
}

// One pass over the corpus; a non-infra key is a reader iff its bare token appears
// whole-word in any source file. Early-exit once every key is accounted for.
const pending = keys.filter((k) => !INFRA_ONLY.has(k)).map((k) => ({ key: k, re: new RegExp("\\b" + k + "\\b") }));
const found = new Set();
for (const file of files) {
  if (found.size === pending.length) break;
  const src = fs.readFileSync(file, "utf8");
  for (const { key, re } of pending) {
    if (!found.has(key) && re.test(src)) found.add(key);
  }
}

const readersResolved = found.size;
const phantoms = pending.map((p) => p.key).filter((k) => !found.has(k));

// A broken scan resolves no reader and would flag every key; fail, do not pass.
if (readersResolved === 0) {
  console.error("zero env-var readers resolved across all non-allowlisted keys — scan regression in this gate.");
  process.exit(1);
}

if (phantoms.length > 0) {
  console.error("Phantom env vars (declared in .env.example, no app reader, not infra-only):");
  console.error(phantoms.map((k) => "  " + k).join("\n"));
  console.error("");
  console.error("For each: wire a reader, delete the .env.example key, or add it to INFRA_ONLY");
  console.error("with a consumer note if a non-TS consumer (docker/postgres/OTel) reads it.");
  process.exit(1);
}

console.log("no-phantom-env-var gate: OK (" + keys.length + " declared keys, " + readersResolved + " readers resolved)");
'
