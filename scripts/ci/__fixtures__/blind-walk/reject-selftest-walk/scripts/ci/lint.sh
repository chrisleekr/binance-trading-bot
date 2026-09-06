#!/usr/bin/env bash
# Fixture stub. Decides nothing and walks nothing.
echo fixture
unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION
bash "$(dirname "$0")/no-error-cast.sh"
