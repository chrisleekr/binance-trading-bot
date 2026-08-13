#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start coverage-merge

repo_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_root"

COVERAGE_REPO_ROOT="$repo_root" bun -e '
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.COVERAGE_REPO_ROOT;
const { COVERAGE_POLICY } = await import(
  pathToFileURL(join(root, "packages/config/vitest/coverage-policy.js")).href
);
const { writeMergedCoverage } = await import(
  pathToFileURL(join(root, "scripts/ci/merge-coverage.ts")).href
);
const result = writeMergedCoverage({ root, policy: COVERAGE_POLICY });
console.log(`coverage-merge: ${result.sourceCount} source files from ${result.workspaceCount} workspaces`);
'
