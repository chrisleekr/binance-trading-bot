#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start browser-bootstrap

# Browsers ship pre-installed in the mcr.microsoft.com/playwright image at
# /ms-playwright; the e2e job in .gitlab-ci.yml sets
# PLAYWRIGHT_BROWSERS_PATH=/ms-playwright so Playwright finds them at
# runtime. Bypass `bunx turbo` and invoke playwright directly because
# turbo strips env vars not listed in `globalEnv` / `globalPassThroughEnv`,
# and adding PLAYWRIGHT_BROWSERS_PATH there would force a cache miss on
# every other task that reads the env.
# Derive the root from this script's location, not `git rev-parse`: this step
# runs inside the playwright container, where the workspace is owned by the
# host runner uid but the shell is root, so git rejects the repo as dubious
# ownership. checkout's safe.directory lands in a temp HOME and is gone by now.
REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"

(cd "$REPO_ROOT/e2e" && bun x playwright test)
bun "$REPO_ROOT/scripts/ci/check-playwright-honesty.ts" \
  --mode=browser-bootstrap --strict-projects < "$REPO_ROOT/e2e/test-results/results.json"
