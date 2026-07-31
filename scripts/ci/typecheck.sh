#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start typecheck
# Cap turbo fan-out: a cold cache runs `tsc -b` for every package at once, and the
# aggregate heap OOM-kills the memory-constrained CI runner (exit 137). Serialising
# to a few at a time keeps peak memory bounded; warm-cache runs restore outputs and
# skip the builds anyway, so the wall-time cost lands only on cache-cold pipelines.
bunx turbo typecheck --concurrency=2
