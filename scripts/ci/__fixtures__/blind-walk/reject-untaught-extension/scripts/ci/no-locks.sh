#!/usr/bin/env bash
# Fixture stub that takes its walk from the shared helper.
GUARD_ROOT="${GUARD_ROOT:-$root}"
CI_WALK_LIB=x bun -e 'const { collectOrExit } = await import(process.env.CI_WALK_LIB);'
