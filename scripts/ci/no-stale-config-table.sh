#!/usr/bin/env bash
# Fail if a committed docs config-table partial no longer matches its schema.
#
# The config tables under docs/_generated/config/ are generated from the live
# zod config schemas through the SAME pipeline the web AutoForm renders with
# (packages/contracts/src/form-builder.ts), so a doc config table can never
# drift from the UI. This gate regenerates in memory and diffs against the
# committed partials; a mismatch means someone changed a schema without running
# `bun run docs:gen`.
#
# The generator carries its own vacuity floor (FLOOR partials, exits non-zero if
# fewer are produced), so a registry/import regression fails this gate rather
# than passing it vacuously.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-config-table

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

bun run docs:gen --check
