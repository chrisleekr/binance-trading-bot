#!/usr/bin/env bash
# Fixture stub that reads a directory itself.
GUARD_ROOT="${GUARD_ROOT:-$root}"
bun -e 'for (const e of require("node:fs").readdirSync(".")) console.log(e);'
