#!/usr/bin/env bash
set -euo pipefail
# Lint the Prometheus alert rules with promtool. Cache the matching Prometheus
# archive and binary under node_modules so warm runs do not download them again.
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
PROMTOOL_ARCHIVE="${CACHE_DIR}/prom.tgz"
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
else
  # 2) Otherwise verify the matching official archive and extract a fresh binary from it.
  raw_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  raw_arch="$(uname -m)"
  case "$raw_os" in
    linux|darwin) os="$raw_os" ;;
    *) echo "promtool-lint: unsupported platform ${raw_os}-${raw_arch}; cannot validate rules." >&2; exit 1 ;;
  esac
  case "$raw_arch" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "promtool-lint: unsupported platform ${os}-${raw_arch}; cannot validate rules." >&2; exit 1 ;;
  esac
  release="prometheus-${PROMTOOL_VERSION}.${os}-${arch}"
  url="https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/${release}.tar.gz"
  digest_file="${script_dir}/prometheus-${PROMTOOL_VERSION}.sha256"
  expected_digest="$(awk -v asset="${release}.tar.gz" '$2 == asset { print $1 }' "$digest_file" 2>/dev/null || true)"
  if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "promtool-lint: no pinned SHA-256 digest for ${release}.tar.gz." >&2
    exit 1
  fi
  mkdir -p "$CACHE_DIR"
  archive_to_verify="$PROMTOOL_ARCHIVE"
  downloaded=0
  if [[ ! -f "$PROMTOOL_ARCHIVE" ]]; then
    download="${PROMTOOL_ARCHIVE}.download"
    rm -f "$download"
    # Two fetchers because the lanes disagree: the GitHub lane runs on ubuntu and has curl, while the GitLab Alpine lane has BusyBox wget. An available fetcher that fails falls through to the other before the gate gives up.
    if command -v curl >/dev/null 2>&1 &&
      curl -fsSL --connect-timeout 5 -o "$download" "$url"; then
      :
    elif command -v wget >/dev/null 2>&1 &&
      wget -q --timeout=20 -O "$download" "$url"; then
      :
    else
      rm -f "$download"
      echo "promtool-lint: cannot reach ${url}; install promtool locally to validate rules." >&2
      exit 1
    fi
    archive_to_verify="$download"
    downloaded=1
  fi

  actual_digest=''
  if command -v sha256sum >/dev/null 2>&1; then
    actual_digest="$(sha256sum "$archive_to_verify" 2>/dev/null | awk '{ print $1 }')" || true
  elif command -v shasum >/dev/null 2>&1; then
    actual_digest="$(shasum -a 256 "$archive_to_verify" 2>/dev/null | awk '{ print $1 }')" || true
  else
    if [[ "$downloaded" -eq 1 ]]; then rm -f "$archive_to_verify"; fi
    echo 'promtool-lint: neither sha256sum nor shasum is available to verify the Prometheus archive.' >&2
    exit 1
  fi
  if [[ "$actual_digest" != "$expected_digest" ]]; then
    if [[ "$downloaded" -eq 1 ]]; then rm -f "$archive_to_verify"; fi
    echo "promtool-lint: checksum mismatch for ${url}." >&2
    exit 1
  fi
  if [[ "$downloaded" -eq 1 ]]; then mv "$archive_to_verify" "$PROMTOOL_ARCHIVE"; fi

  # Extract only promtool after every successful verification. This overwrites a modified cached executable without storing the much larger Prometheus server binary.
  tar -xzf "$PROMTOOL_ARCHIVE" -C "$CACHE_DIR" --strip-components=1 "${release}/promtool"
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
