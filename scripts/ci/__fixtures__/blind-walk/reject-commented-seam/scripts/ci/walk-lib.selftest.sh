#!/usr/bin/env bash
# Fixture stub that exercises the shared walk library directly.
CI_WALK_LIB=x bun -e 'const { walkRoots } = await import(process.env.CI_WALK_LIB); void walkRoots;'
