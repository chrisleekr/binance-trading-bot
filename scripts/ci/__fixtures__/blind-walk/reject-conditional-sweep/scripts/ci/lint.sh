#!/usr/bin/env bash
# Fixture stub whose sweep sits inside a branch that is not taken. It is live text that clears nothing.
if [ -n "${ALLOW_AMBIENT_GUARD_ROOT:-}" ]; then
  unset GUARD_ROOT GUARD_DIR GUARD_RUNNER WALK_GATE_MANIFEST MIGRATIONS_DIR MIGRATIONS_RUNNER OXLINT_CONFIG PROMTOOL_VERSION
fi
bash "$(dirname "$0")/no-locks.sh"
