#!/usr/bin/env bash
# Fixture stub that clears the seam only after the first gate has already run under the ambient value.
bash "$(dirname "$0")/no-locks.sh"
unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION
