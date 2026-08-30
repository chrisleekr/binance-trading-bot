#!/usr/bin/env bash
# Fixture stub that invokes its gate by a spelling the locator does not recognise, then sweeps at the bottom where the clearing reaches nobody.
"$(dirname -- "$0")/no-locks.sh"
unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION
