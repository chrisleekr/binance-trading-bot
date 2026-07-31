#!/usr/bin/env bash
# Lock-free gate: forbid distributed-locking primitives (redlock / held intent
# sets / soft balance reservation) anywhere under apps/worker/**,
# packages/strategy*/**, packages/notify*/**, and packages/binance/**.
# The permitted shared-Redis coordination primitives are the consume-and-decay
# request-weight bucket and the self-expiring `SET NX PX` notifier-gap throttle
# (rate-limiting / visibility infra, not locks) — ratified in the WS6 ADR, epic
# #561. Tokens below match what a real lock would import / reference.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so the scan uses bun's fs (the same portable approach as
# no-undeclared-workspace-import.sh), not a recursive grep. A vacuity guard fails
# the gate rather than pass it if no source files are scanned (scan-path
# regression), because a drift gate that passes vacuously is worse than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-locks

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.GUARD_ROOT;

// Tokens a real lock would import / reference. balances:...reserved is the
// explicit Redis-key shape from acceptance criterion #11.05.
const PATTERNS = [
  ["redlock", /redlock/],
  ["Redlock", /Redlock/],
  ["intents:", /intents:/],
  ["softReserve", /softReserve/],
  ["balance-reservation", /balance-reservation/],
  ["balances:*reserved", /balances:[A-Za-z0-9_-]*reserved/],
];

// Shared coordination code (Redis weight bucket, epic #561 WS2) lives in
// packages/binance; the shared token bucket is consume-and-decay rate-limiting,
// not a lock, and must never regress into one. Scanning it closes the prior
// passes-by-omission hole.
const ROOTS = ["apps/worker/src", "packages/strategy", "packages/notify", "packages/binance"];
const SKIP_DIR = new Set(["node_modules", "dist"]);
const EXTS = /\.(tsx?|m?js)$/;

const srcFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) srcFiles(p, out);
    } else if (EXTS.test(e.name)) {
      out.push(p);
    }
  }
  return out;
};

const files = ROOTS.flatMap((r) => srcFiles(path.join(root, r)));
if (files.length === 0) {
  console.error("no source files scanned under the lock-free roots — scan-path regression in this gate.");
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [name, re] of PATTERNS) {
      if (re.test(lines[i])) hits.push(path.relative(root, file) + ":" + (i + 1) + " [" + name + "] " + lines[i].trim());
    }
  }
}

if (hits.length > 0) {
  console.error("Forbidden lock token(s) found:");
  console.error(hits.map((h) => "  " + h).join("\n"));
  console.error("");
  console.error("This codebase is lock-free. Adding redlock / held-intent sets / soft-balance-reservation");
  console.error("is a CLAUDE.md anti-pattern. The only permitted shared-Redis primitives are the");
  console.error("consume-and-decay weight bucket and the self-expiring SET NX PX notifier-gap throttle");
  console.error("(rate-limiting / visibility infra, not locks) — see the WS6 ADR, #561.");
  process.exit(1);
}

console.log("no-locks gate: OK (" + files.length + " files scanned)");
'
