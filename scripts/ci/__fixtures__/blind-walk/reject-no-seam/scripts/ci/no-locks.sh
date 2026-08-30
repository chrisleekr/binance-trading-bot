#!/usr/bin/env bash
# Fixture stub that routes through the helper but pins the root, so no self-test can drive it.
GUARD_ROOT="$root"
CI_WALK_LIB=x bun -e 'const { collectOrExit } = await import(process.env.CI_WALK_LIB);'
