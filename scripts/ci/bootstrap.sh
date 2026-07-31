#!/usr/bin/env bash
set -euo pipefail
# Single bootstrap entry point for CI: installs Bun deps. Other CI scripts
# assume bootstrap.sh has run. The CI YAML installs bash before invoking
# this script, since alpine ships only sh by default.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start bootstrap

bash "$(dirname "$0")/install.sh"
