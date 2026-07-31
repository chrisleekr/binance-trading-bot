#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start install
bun install --frozen-lockfile
