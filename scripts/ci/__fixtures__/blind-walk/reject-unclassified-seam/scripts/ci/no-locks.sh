#!/usr/bin/env bash
# Fixture stub that takes its walk from the shared helper and reads a second, unclassified environment seam.
GUARD_ROOT="${GUARD_ROOT:-$root}"
RULES_DIR="${RULES_DIR:-$root/rules}"
CI_WALK_LIB=x bun -e 'const { collectOrExit } = await import(process.env.CI_WALK_LIB);'
