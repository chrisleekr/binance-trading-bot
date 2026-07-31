#!/usr/bin/env bash
set -euo pipefail
# Single image-build entry. Provider-agnostic (called identically from
# GitHub Actions and GitLab CI). Builds the one `server` image (ROLE selects
# behaviour at runtime); an app without a Dockerfile is skipped.
#
# Usage:
#   docker-build.sh [flags] [APP ...]
#
# Flags:
#   --push                       push to the registry after building
#   --check                      build every --platforms arch to validate the
#                                Dockerfile, then discard (no push, no load).
#                                Catches an arch-specific build break on a
#                                build-only CI gate. Mutually exclusive with
#                                --push.
#   --registry <REG>             registry host/path (e.g. chrisleekr/binance-trading-bot)
#   --single-repo                tag as `<REG>:<tag>` instead of one repo per
#                                service (`<REG>/<service>:<tag>`). Use for
#                                Docker Hub, where nested namespaces are not
#                                allowed.
#   --platforms <LIST>           comma list, default linux/amd64,linux/arm64
#   --tag-version <V>            primary version tag (e.g. v0.4.0)
#   --tag-extra <T>              extra tag (repeatable)
#   --tag-latest                 also tag :latest
#   -h | --help                  this help
#
# When --push + --registry are set the script imports/exports a BuildKit
# registry layer cache at `<repo>:buildcache` (mode=max,
# image-manifest=true — GitLab Container Registry rejects the default
# OCI manifest list for cache refs). One shared cache per app; BuildKit
# already hashes layer contents so cross-branch reuse is safe.
#
# Defaults to the single `server` image. Pass an app name to target one.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"

usage() {
  sed -n '/^# Usage:/,/^# Defaults to /p' "$0" | sed 's/^# \{0,1\}//'
}

PUSH=0
CHECK=0
REGISTRY=""
SINGLE_REPO=0
PLATFORMS="linux/amd64,linux/arm64"
TAG_VERSION=""
TAG_LATEST=0
declare -a TAG_EXTRAS=()
declare -a APPS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)         PUSH=1; shift ;;
    --check)        CHECK=1; shift ;;
    --registry)
      REGISTRY="${2%/}"  # strip any trailing slash so ${REGISTRY}/${app} can't produce //
      shift 2 ;;
    --single-repo)  SINGLE_REPO=1; shift ;;
    --platforms)    PLATFORMS="$2"; shift 2 ;;
    --tag-version)  TAG_VERSION="$2"; shift 2 ;;
    --tag-extra)    TAG_EXTRAS+=("$2"); shift 2 ;;
    --tag-latest)   TAG_LATEST=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    --) shift; while [[ $# -gt 0 ]]; do APPS+=("$1"); shift; done ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)  APPS+=("$1"); shift ;;
  esac
done

if [[ "$SINGLE_REPO" -eq 1 && -z "$REGISTRY" ]]; then
  echo "docker-build: --single-repo requires --registry" >&2
  exit 2
fi

if [[ "$PUSH" -eq 1 && "$CHECK" -eq 1 ]]; then
  echo "docker-build: --push and --check are mutually exclusive" >&2
  exit 2
fi

if [[ ${#APPS[@]} -eq 0 ]]; then
  # One image for the whole app; ROLE selects behaviour at runtime.
  APPS=(server)
fi

ci::start docker-build

if ! docker buildx version >/dev/null 2>&1; then
  echo 'docker-build: docker buildx is required' >&2
  exit 1
fi

# The default buildx `docker` driver only builds for the host's native
# platform. Multi-platform builds need the `docker-container` driver and
# QEMU binfmt handlers for cross-arch emulation. Bootstrap them on first
# use so any CI runner with a privileged Docker daemon (GitLab dind,
# GitHub Actions, local dev) works the same way.
ensure_builder() {
  # Local (--load) builds always collapse to linux/amd64 below, so the
  # default driver suffices. --push and --check both build foreign arches and
  # need the docker-container driver + QEMU: the default driver only supports
  # the host's native arch, so even a single foreign platform (e.g. linux/arm64
  # on an amd64 runner) fails without them.
  if [[ "${PUSH:-0}" -ne 1 && "${CHECK:-0}" -ne 1 ]]; then
    return 0
  fi
  local builder=binance-trading-bot-multi
  local context=binance-trading-bot-dind
  # Idempotent: binfmt handlers live in host kernel state and are lost on
  # daemon/host restart, so re-register every push rather than only on
  # builder creation.
  #
  # The image path is overridable so CI can point at a registry mirror and
  # dodge Docker Hub's unauthenticated pull rate limit (#122). Defaults to
  # the upstream so local dev keeps working without any env setup.
  docker run --privileged --rm "${BINFMT_IMAGE:-tonistiigi/binfmt}" --install all >/dev/null
  # Bind the current Docker CLI env to a named context. buildx cannot
  # propagate DOCKER_HOST + TLS env vars (DOCKER_TLS_VERIFY / DOCKER_CERT_PATH)
  # into the buildkitd helper container; pointing the builder at a context
  # makes the daemon address explicit and works equally for plain socket
  # daemons and TLS-fronted dind.
  local existing_host=""
  if docker context inspect "$context" >/dev/null 2>&1; then
    existing_host="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  fi
  # The context captures the endpoint at creation time and does not track
  # later DOCKER_HOST changes. If a developer switches between daemons
  # between runs (e.g. local socket ↔ remote dind), refresh the context
  # and the dependent builder so the next build hits the new endpoint.
  local current_host="${DOCKER_HOST:-}"
  if [[ -n "$current_host" && -n "$existing_host" && "$current_host" != "$existing_host" ]]; then
    docker buildx rm "$builder" >/dev/null 2>&1 || true
    docker context rm "$context" >/dev/null
    existing_host=""
  fi
  if [[ -z "$existing_host" ]]; then
    docker context create "$context" >/dev/null
  fi
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    local driver
    driver="$(docker buildx inspect "$builder" --format '{{.Driver}}' 2>/dev/null || true)"
    if [[ "$driver" != "docker-container" ]]; then
      docker buildx rm "$builder" >/dev/null 2>&1 || true
      docker buildx create --name "$builder" --driver docker-container "$context" >/dev/null
    fi
  else
    docker buildx create --name "$builder" --driver docker-container "$context" >/dev/null
  fi
  docker buildx inspect "$builder" --bootstrap >/dev/null
  docker buildx use "$builder"
}

ensure_builder

repo_for() {
  local app="$1"
  if [[ -z "$REGISTRY" ]]; then
    printf '%s' "$app"
  elif [[ "$SINGLE_REPO" -eq 1 ]]; then
    printf '%s' "$REGISTRY"
  else
    printf '%s/%s' "$REGISTRY" "$app"
  fi
}

build_one() {
  local app="$1"
  local dockerfile="apps/${app}/Dockerfile"
  if [[ ! -f "$dockerfile" ]]; then
    echo "docker-build: skipping ${app} — ${dockerfile} not found"
    return 0
  fi
  local repo
  repo="$(repo_for "$app")"
  local -a tag_args=()
  if [[ -n "$TAG_VERSION" ]]; then
    tag_args+=("--tag" "${repo}:${TAG_VERSION}")
  fi
  for extra in "${TAG_EXTRAS[@]:-}"; do
    [[ -z "$extra" ]] && continue
    tag_args+=("--tag" "${repo}:${extra}")
  done
  if [[ "$TAG_LATEST" -eq 1 ]]; then
    tag_args+=("--tag" "${repo}:latest")
  fi
  if [[ ${#tag_args[@]} -eq 0 ]]; then
    tag_args+=("--tag" "${repo}:dev")
  fi
  local -a buildx_args=(
    buildx build
    --file "$dockerfile"
    --platform "$PLATFORMS"
    "${tag_args[@]}"
  )
  # Forward the mirror image only when the env opts in. Dockerfiles default
  # `BUN_IMAGE=oven/bun` so omitting this leaves local builds untouched.
  if [[ -n "${BUN_IMAGE:-}" ]]; then
    buildx_args+=(--build-arg "BUN_IMAGE=${BUN_IMAGE}")
  fi
  # Stamp the build's git short SHA when the caller provides it (CI sets it from
  # the pipeline commit). The runtime alpine image has no git, so without this
  # the status bar shows "unknown". Empty in local builds — the Dockerfile's ENV
  # default plus the runtime git fallback keep those working.
  if [[ -n "${GIT_SHA:-}" ]]; then
    buildx_args+=(--build-arg "GIT_SHA=${GIT_SHA}")
  fi
  # Registry-backed layer cache reuses unchanged layers across pipelines.
  # One shared `<repo>:buildcache` tag per app — BuildKit hashes layer
  # contents internally, so cross-branch reuse is safe and per-branch
  # scoping is unnecessary. `mode=max` exports intermediate layers so a
  # subsequent build can skip the bun-install + QEMU-emulated arm64
  # stages. `image-manifest=true` is required because GitLab Container
  # Registry rejects the default OCI manifest list for cache refs. Gated
  # on --push + --registry because the cache round-trips through the
  # registry; local builds (no --push, no --registry) stay offline.
  if [[ "$PUSH" -eq 1 ]] && [[ -n "$REGISTRY" ]]; then
    buildx_args+=(--cache-from "type=registry,ref=${repo}:buildcache")
    buildx_args+=(--cache-to "type=registry,ref=${repo}:buildcache,mode=max,image-manifest=true")
  fi
  if [[ "$PUSH" -eq 1 ]]; then
    buildx_args+=(--push)
  elif [[ "$CHECK" -eq 1 ]]; then
    # Validate every --platforms arch, then throw the result away. cacheonly
    # runs the full build (so an arch-specific break surfaces) without needing
    # a registry to push to or a single-arch --load.
    buildx_args+=(--output type=cacheonly)
  else
    buildx_args+=(--load)
    # --load only supports a single platform; force amd64 for local builds.
    buildx_args=("${buildx_args[@]/--platform $PLATFORMS/--platform linux/amd64}")
  fi
  ci::group "build ${app}"
  docker "${buildx_args[@]}" .
  ci::endgroup
}

for app in "${APPS[@]}"; do
  build_one "$app"
done
