#!/usr/bin/env bash
# Fixture stub that clears only GUARD_ROOT, leaving the manifest and migrations overrides live.
unset GUARD_ROOT
bash "$(dirname "$0")/no-locks.sh"
