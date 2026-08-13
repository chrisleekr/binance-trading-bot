#!/usr/bin/env bash
# Fail if the committed env-contract.json no longer matches ENV_CATALOGUE.
#
# The helm chart at chrisleekr/helm-charts is synced by version only, so a
# variable added here never reaches its ConfigMap or Secret and nothing fails:
# an unmirrored variable does not render and `helm template` still succeeds. The
# chart's parity check is intended to read this file at the release tag, which
# only works if the committed copy is current. This gate regenerates in memory
# and diffs.
#
# The generator carries its own vacuity floor and refuses to publish a
# credential-shaped variable classified as config, so a catalogue regression
# fails this gate rather than passing it with an empty or unsafe contract.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start no-stale-env-contract

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$root"

bun run env-contract --check
