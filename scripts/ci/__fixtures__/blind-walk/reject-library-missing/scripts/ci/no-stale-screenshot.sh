#!/usr/bin/env bash
# Fixture stub that uses the helper AND still reads a directory itself.
GUARD_ROOT="${GUARD_ROOT:-$root}"
CI_WALK_LIB=x bun -e 'const { collectOrExit } = await import(process.env.CI_WALK_LIB); require("node:fs").readdirSync(".");'
