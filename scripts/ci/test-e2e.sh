#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-e2e

# Browsers ship pre-installed in the mcr.microsoft.com/playwright image at
# /ms-playwright; the e2e job in .gitlab-ci.yml sets
# PLAYWRIGHT_BROWSERS_PATH=/ms-playwright so Playwright finds them at
# runtime. Bypass `bunx turbo` and invoke playwright directly because
# turbo strips env vars not listed in `globalEnv` / `globalPassThroughEnv`,
# and adding PLAYWRIGHT_BROWSERS_PATH there would force a cache miss on
# every other task that reads the env.
(cd "$(git rev-parse --show-toplevel)/e2e" && bun x playwright test)
