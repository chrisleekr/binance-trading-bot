#!/usr/bin/env bash
# Publish-hazard gate: this repo is published to a public GitHub repo, so a
# blob that is merely gitignored today is not safe — anything reachable from
# the published branch is world-readable forever, and rewriting history on a
# repo with 1k+ forks is not a real remedy.
#
# Two checks:
#   1. No database dump, archive, or key material is reachable from HEAD.
#      A 64 KB pg_dump was committed once already (on branches that never
#      reached master), which is why this is a gate and not a convention.
#   2. No credential-shaped literal is tracked.
#
# Scans the git index, not the worktree, because the index is what publishes.
#
# Runs in the bun:alpine CI image, whose BusyBox grep lacks -R / --include /
# --exclude-dir, so this uses `git ls-files` plus bun's fs rather than a
# recursive grep. A vacuity guard fails rather than passes when nothing is
# scanned: a publish gate that passes because it looked at zero files is worse
# than no gate.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-publish-hazard

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

GUARD_ROOT="$root" bun -e '
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const root = process.env.GUARD_ROOT;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean);

if (tracked.length < 100) {
  console.error(`no-publish-hazard: only ${tracked.length} tracked files seen; scan path is broken.`);
  process.exit(1);
}

const failures = [];

// 1. Data and key material that must never reach a public repo. Matched on
//    path, so an unreadable binary still gets caught.
const HAZARD_PATH = [
  { re: /(^|\/)backups\//i,                 why: "database backup directory" },
  { re: /\.(dump|sql\.gz|bak)$/i,           why: "database dump" },
  { re: /\.(pem|pfx|p12|keystore|jks)$/i,   why: "key material" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: "private SSH key" },
  // .env.example is the documented template and is intentionally tracked.
  { re: /(^|\/)\.env(\.|$)(?!example)/,     why: "environment file" },
];

for (const f of tracked) {
  for (const { re, why } of HAZARD_PATH) {
    if (re.test(f)) failures.push(`${f} — ${why} is tracked`);
  }
}

// 2. Credential-shaped literals. Deliberately narrow: these are prefixes that
//    only ever appear in a real credential, so a hit is a finding rather than
//    a prompt to eyeball it.
const HAZARD_CONTENT = [
  { re: /\bghp_[A-Za-z0-9]{36}\b/,       why: "GitHub personal access token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/, why: "GitHub fine-grained token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20}\b/,   why: "GitLab personal access token" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/,          why: "AWS access key id" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "private key block" },
];

// uv.lock pins the PyPI package `ghp_import`, whose name matches the GitHub
// token prefix. It is a dependency name, not a credential.
const CONTENT_SKIP = [/^uv\.lock$/, /^bun\.lock$/, /^scripts\/ci\/no-publish-hazard\.sh$/];

const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|sh|md|env|example|toml|sql|txt)$/i;

let scanned = 0;
for (const f of tracked) {
  if (!TEXT.test(f)) continue;
  if (CONTENT_SKIP.some((re) => re.test(f))) continue;
  let body;
  try {
    body = fs.readFileSync(`${root}/${f}`, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  for (const { re, why } of HAZARD_CONTENT) {
    if (re.test(body)) failures.push(`${f} — looks like a ${why}`);
  }
}

if (scanned < 50) {
  console.error(`no-publish-hazard: only ${scanned} text files scanned; content scan is broken.`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error("no-publish-hazard: refusing to publish.\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error("\nThis repo publishes to a public GitHub repo. Remove the file from the");
  console.error("index and rotate anything that leaked before pushing.");
  process.exit(1);
}

console.log(`no-publish-hazard: ${tracked.length} tracked files, ${scanned} scanned for credentials, clean.`);
'
