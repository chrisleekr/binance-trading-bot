#!/usr/bin/env bash
# Fixture stub: routes through the shared helper, so the routing half of the self-check passes, but pins the repo root instead of carrying the seam.
GUARD_ROOT="$root"
CI_WALK_LIB=x bun -e 'const { collectOrExit } = await import(process.env.CI_WALK_LIB);'
