#!/usr/bin/env bash
set -euo pipefail

root="${GUARD_ROOT:-$PWD}"
directory="$root/deploy/observability"
if [[ ! -d "$directory" ]]; then
  echo 'observability YAML not found: zero top-level observability YAML files discovered under deploy/observability' >&2
  exit 1
fi

non_rule_files=("deploy/observability/otel-collector.yaml")
files=0
rules=0
records=()
non_rules=()
while IFS= read -r -d '' absolute; do
  files=$((files + 1))
  relative="${absolute#"$root/"}"
  if [[ "$relative" == *$'\n'* || "$relative" == *$'\t'* ]]; then
    echo 'observability YAML filename contains a tab or newline and cannot be classified safely' >&2
    exit 1
  fi
  kind=RULE
  for allowed in "${non_rule_files[@]}"; do
    [[ "$relative" == "$allowed" ]] && kind=NON_RULE
  done
  records+=("$kind"$'\t'"$relative")
  if [[ "$kind" == RULE ]]; then
    rules=$((rules + 1))
  else
    non_rules+=("$relative")
  fi
done < <(find "$directory" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print0)

if [[ "$files" -eq 0 ]]; then
  echo 'observability YAML not found: zero top-level observability YAML files discovered under deploy/observability' >&2
  exit 1
fi

if [[ "$rules" -eq 0 ]]; then
  joined="$(IFS=', '; echo "${non_rules[*]}")"
  echo "zero Prometheus rules files discovered; classified non-rule YAML: $joined" >&2
  exit 1
fi

printf '%s\n' "${records[@]}"
