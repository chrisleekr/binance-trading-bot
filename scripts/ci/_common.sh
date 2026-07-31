#!/usr/bin/env bash
# Shared helpers for scripts/ci/*.sh.
#
# Sourced from every CI script so each one prints a one-line end summary
# (`✓ step X passed in Ys` / `✗ step X failed in Ys`) and emits matching
# group markers for GitHub Actions and GitLab CI log folding.
#
# Provider-agnostic: the same script must run identically under either
# CI provider, so we sniff `GITHUB_ACTIONS` and `GITLAB_CI` separately
# and fall back to plain prefixes when neither is set.
#
# Idempotent: re-sourcing this file is safe.

if [[ -n "${_BINANCE_TRADING_BOT_CI_COMMON_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
_BINANCE_TRADING_BOT_CI_COMMON_LOADED=1

# ci::group <label>
#   Prints a fold-aware group banner and remembers the open group name so
#   ci::endgroup can close the matching label under GitLab.
ci::group() {
  _BINANCE_TRADING_BOT_CURRENT_GROUP="$1"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::group::%s\n' "$1"
  elif [[ -n "${GITLAB_CI:-}" ]]; then
    # GitLab uses section_start/end with monotonic time + a token name.
    local token
    token="$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    _BINANCE_TRADING_BOT_CURRENT_GROUP_TOKEN="$token"
    printf '\e[0Ksection_start:%s:%s\r\e[0K%s\n' "$(date +%s)" "$token" "$1"
  else
    printf '── %s ──\n' "$1"
  fi
}

ci::endgroup() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::endgroup::\n'
  elif [[ -n "${GITLAB_CI:-}" ]]; then
    if [[ -n "${_BINANCE_TRADING_BOT_CURRENT_GROUP_TOKEN:-}" ]]; then
      printf '\e[0Ksection_end:%s:%s\r\e[0K\n' "$(date +%s)" "$_BINANCE_TRADING_BOT_CURRENT_GROUP_TOKEN"
    fi
  fi
  unset _BINANCE_TRADING_BOT_CURRENT_GROUP _BINANCE_TRADING_BOT_CURRENT_GROUP_TOKEN
}

# ci::start <step-name>
#   Records the start time and step name for ci::done. Trapping EXIT here
#   means a script that exits non-zero before ci::done still produces a
#   matching ✗ line.
ci::start() {
  _BINANCE_TRADING_BOT_STEP="$1"
  _BINANCE_TRADING_BOT_STEP_T0=$(date +%s)
  trap 'ci::_atexit $?' EXIT
}

ci::_atexit() {
  local rc="$1"
  if [[ -z "${_BINANCE_TRADING_BOT_STEP:-}" ]]; then return; fi
  local dt=$(( $(date +%s) - _BINANCE_TRADING_BOT_STEP_T0 ))
  if [[ "$rc" -eq 0 ]]; then
    printf '✓ step %s passed in %ss\n' "$_BINANCE_TRADING_BOT_STEP" "$dt"
  else
    printf '✗ step %s failed in %ss (exit %s)\n' "$_BINANCE_TRADING_BOT_STEP" "$dt" "$rc" >&2
  fi
  unset _BINANCE_TRADING_BOT_STEP _BINANCE_TRADING_BOT_STEP_T0
}

# ci::done
#   Explicit "step finished cleanly" marker. Prefer trap-based ci::_atexit
#   in plain scripts; ci::done is for callers that orchestrate multiple
#   logical steps inside one process.
ci::done() {
  ci::_atexit 0
  trap - EXIT
}

# ci::run <label> -- <command...>
#   Convenience wrapper: groups output, runs the command, and lets the
#   trap-based summary report on exit.
ci::run() {
  local label="$1"; shift
  if [[ "${1:-}" == "--" ]]; then shift; fi
  ci::group "$label"
  "$@"
  local rc=$?
  ci::endgroup
  return $rc
}
