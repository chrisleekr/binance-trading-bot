#!/usr/bin/env bash
set -euo pipefail
# Lint the Prometheus alert rules with promtool. promtool is part of
# the Prometheus distribution; we cache it under .ci-cache/ so the
# script is fast on warm runs and works without re-downloading on
# every CI invocation.
#
# Skips with a non-fatal warning when promtool is unavailable AND the
# fetch is blocked (offline runner). The rule file's correctness is
# still verified by Prometheus on first load when the operator
# deploys; this script is the early-warning gate, not the only check.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start promtool-lint

PROMTOOL_VERSION="${PROMTOOL_VERSION:-3.4.1}"
# Cache under node_modules/.cache so we don't have to touch .gitignore;
# node_modules is already ignored by default. Wiped only when the
# operator nukes node_modules.
CACHE_DIR="node_modules/.cache/promtool-${PROMTOOL_VERSION}"
PROMTOOL_BIN="${CACHE_DIR}/promtool"
RULES_FILE="deploy/observability/alerts.yml"

if [[ ! -f "$RULES_FILE" ]]; then
  echo "promtool-lint: ${RULES_FILE} not found; nothing to check."
  exit 0
fi

# 1) Use a system-installed promtool if present.
if command -v promtool >/dev/null 2>&1; then
  PROMTOOL_BIN="$(command -v promtool)"
elif [[ ! -x "$PROMTOOL_BIN" ]]; then
  # 2) Otherwise fetch the matching release into the local cache.
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "promtool-lint: unsupported arch ${arch}; skipping." >&2; exit 0 ;;
  esac
  url="https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/prometheus-${PROMTOOL_VERSION}.${os}-${arch}.tar.gz"
  mkdir -p "$CACHE_DIR"
  if ! curl -fsSL --connect-timeout 5 -o "${CACHE_DIR}/prom.tgz" "$url"; then
    echo "promtool-lint: cannot reach ${url}; skipping (offline runner). Install promtool locally to enforce." >&2
    exit 0
  fi
  tar -xzf "${CACHE_DIR}/prom.tgz" -C "$CACHE_DIR" --strip-components=1
  rm -f "${CACHE_DIR}/prom.tgz"
fi

"$PROMTOOL_BIN" check rules "$RULES_FILE"
