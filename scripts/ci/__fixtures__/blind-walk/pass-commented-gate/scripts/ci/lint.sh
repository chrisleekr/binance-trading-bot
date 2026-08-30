#!/usr/bin/env bash
# Fixture stub. The commented-out gate line below must not be taken as the first gate, or a correct sweep reads as a late one.
# bash "$(dirname "$0")/no-error-cast.sh"
unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION
bash "$(dirname "$0")/no-locks.sh"
