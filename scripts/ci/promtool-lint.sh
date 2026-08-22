#!/usr/bin/env bash
set -euo pipefail
# Lint the Prometheus alert rules with promtool. Cache the matching Prometheus
# binary under node_modules so warm runs do not download it again.
#
# A missing rules set or unavailable validator fails the gate. A green result
# must mean promtool inspected every discovered Prometheus rules file.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start promtool-lint
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"

PROMTOOL_VERSION="${PROMTOOL_VERSION:-3.4.1}"
# Cache under node_modules/.cache so we don't have to touch .gitignore;
# node_modules is already ignored by default. Wiped only when the
# operator nukes node_modules.
CACHE_DIR="node_modules/.cache/promtool-${PROMTOOL_VERSION}"
PROMTOOL_BIN="${CACHE_DIR}/promtool"
root="${GUARD_ROOT:-$PWD}"
cd "$root"
RULE_FILES=()
while IFS= read -r file; do
  [[ "$file" == RULE$'\t'* ]] && RULE_FILES+=("${file#RULE$'\t'}")
done < <(GUARD_ROOT="$root" bash "$script_dir/discover-prometheus-rules.sh")
if [[ "${#RULE_FILES[@]}" -eq 0 ]]; then
  echo 'promtool-lint: rules discovery returned zero files.' >&2
  exit 1
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
    *) echo "promtool-lint: unsupported arch ${arch}; cannot validate rules." >&2; exit 1 ;;
  esac
  release="prometheus-${PROMTOOL_VERSION}.${os}-${arch}"
  url="https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/${release}.tar.gz"
  mkdir -p "$CACHE_DIR"
  # Two fetchers because the lanes disagree: the GitHub lane runs on ubuntu and
  # has curl, the GitLab lane runs oven/bun:*-alpine, which ships BusyBox wget
  # and no curl at all. Assuming curl made this gate fail closed on every GitLab
  # run. Whichever exists is tried, and an available fetcher that fails falls
  # through to the other before the gate gives up.
  if command -v curl >/dev/null 2>&1 &&
    curl -fsSL --connect-timeout 5 -o "${CACHE_DIR}/prom.tgz" "$url"; then
    :
  elif command -v wget >/dev/null 2>&1 &&
    wget -q --timeout=20 -O "${CACHE_DIR}/prom.tgz" "$url"; then
    :
  else
    echo "promtool-lint: cannot reach ${url}; install promtool locally to validate rules." >&2
    exit 1
  fi
  # Extract only promtool. The tarball also carries the ~150 MB prometheus
  # server binary, which nothing here runs, and CACHE_DIR lives under
  # node_modules — a path the GitLab `lint` job uploads into the shared bun
  # cache that every other job then pulls.
  tar -xzf "${CACHE_DIR}/prom.tgz" -C "$CACHE_DIR" --strip-components=1 "${release}/promtool"
  rm -f "${CACHE_DIR}/prom.tgz"
fi

"$PROMTOOL_BIN" check rules "${RULE_FILES[@]}"

# Syntax is only half of it. `check rules` accepts an expression that can never
# evaluate true, which then reads exactly like a rule that has simply not tripped.
# `test rules` replays synthetic series through the real rule file and asserts which
# alerts fire, which is the only thing that catches a rule made silent by how
# Prometheus samples a counter rather than by its threshold.
#
# Discovered rather than hard-coded, and a missing suite fails the gate: a test file
# deleted or renamed would otherwise take its coverage with it silently.
TEST_FILES=()
while IFS= read -r -d '' f; do TEST_FILES+=("$f"); done \
  < <(find deploy/observability/tests -maxdepth 1 -type f -name '*.test.yml' -print0 2>/dev/null | sort -z)
if [[ "${#TEST_FILES[@]}" -eq 0 ]]; then
  echo 'promtool-lint: no rule unit tests found under deploy/observability/tests.' >&2
  exit 1
fi
"$PROMTOOL_BIN" test rules "${TEST_FILES[@]}"
