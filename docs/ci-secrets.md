# CI image-tag scheme and secrets table

This document is the source of truth for two CI invariants:

1. The image-tag scheme that release tooling produces.
2. The secrets surface — explicitly, what is **and is not** provisioned.

## Image-tag scheme

There is one app image, `server` (ROLE selects behaviour at runtime — the api, worker, and web/nginx per-app images were collapsed into it). Two layouts ship today, both keyed on the single `server` service name:

- **Docker Hub** (release-tracked): a single flat repo — `<repo>:<tag>`, via the build script's `--single-repo` flag. Docker Hub does not support nested namespaces, so the service name is not part of the path or the tag.
- **GitLab Container Registry** (dev factory): one repo per service — `<registry>/server:<tag>`. GitLab does support nested paths.

### Docker Hub — release-tracked images

Sources: `.github/workflows/release-please.yml` (versioned releases) and `.github/workflows/ci.yml` (the rolling `:dev` tag).

| Ref               | Image                            | Tags                               |
| ----------------- | -------------------------------- | ---------------------------------- |
| `main` release    | `chrisleekr/binance-trading-bot` | `:vX.Y.Z`, `:latest` (only `main`) |
| `beta` release    | `chrisleekr/binance-trading-bot` | `:vX.Y.Z-beta.N` (no `:latest`)    |
| `main` every push | `chrisleekr/binance-trading-bot` | `:dev` (rolling, overwritten)      |

`<release-tag>` comes verbatim from `googleapis/release-please-action@v4`'s `tag_name` output. `--tag-latest` is conditionally appended only on `main`. The build script defaults to the single `server` app.

`ci.yml`'s `docker-build` job pushes `:dev` only when its `PUSH_DEV_IMAGE` guard holds — not a pull request, `github.ref == refs/heads/main`, and `github.repository == chrisleekr/binance-trading-bot`. Forks and PRs have no secrets, so they fall through to `docker-build.sh --check`, which builds every platform and discards the result. `:dev` is one rolling tag each push overwrites, so the registry never accretes a tag per commit.

### GitLab — dev-image factory

Source: `.gitlab-ci.yml`.

| Trigger | Image | Tags |
| --- | --- | --- |
| `main` or tag push | `$CI_REGISTRY_IMAGE/server` | `:<ref-slug>` — `:main` or the tag slug |
| Feature branch, **manual** | `$CI_REGISTRY_IMAGE/server` | `:dev` (rolling, overwritten) |

Feature-branch builds are `when: manual` with `allow_failure: true`: nothing in CI consumes the branch image (e2e and integration use service containers), so it stays off the iteration critical path as a one-click check on a Dockerfile change.

There is no short-SHA **tag**. `GIT_SHA` is passed as a `--build-arg` so the running container's status bar can report its commit; it never becomes part of a tag.

`:latest` does **not** move on GitLab — the dev factory only mints snapshot tags. Releases (and `:latest`) live on Docker Hub.

**Architecture:** on GitLab, `main`/tag images are multi-arch (`linux/amd64,linux/arm64`) so the arm64 homelab node can pull `:main`, while feature-branch `:dev` images stay amd64-only — arm64 cross-build under QEMU roughly doubles build time and nothing consumes that image on arm64. On Docker Hub both the release images (`release-please.yml`) and the `:dev` image (`ci.yml`, pushed from `main`) are multi-arch.

## Secrets table

### Provider built-ins (no provisioning needed)

| Secret                 | Provider | Used by                 |
| ---------------------- | -------- | ----------------------- |
| `GITHUB_TOKEN`         | GitHub   | release-please PR + tag |
| `CI_REGISTRY_USER`     | GitLab   | `docker login`          |
| `CI_REGISTRY_PASSWORD` | GitLab   | `docker login`          |
| `CI_REGISTRY`          | GitLab   | docker login host       |
| `CI_REGISTRY_IMAGE`    | GitLab   | per-image registry path |

### Operator-managed (image publishing + nightly testnet e2e)

| Name | Kind | Configured at | Used by | Required? |
| --- | --- | --- | --- | --- |
| `DOCKERHUB_USERNAME` | GitHub repo secret | GitHub repo | `release-please.yml` (release push), `ci.yml` (`:dev` push on `main`) | required |
| `DOCKERHUB_TOKEN` | GitHub repo secret | GitHub repo | `release-please.yml` (release push), `ci.yml` (`:dev` push on `main`) | required |
| `BINANCE_TESTNET_API_KEY` | GitHub repo secret | GitHub repo | `nightly.yml` (testnet-e2e job) | optional |
| `BINANCE_TESTNET_API_SECRET` | GitHub repo secret | GitHub repo | `nightly.yml` (testnet-e2e job) | optional |

`DOCKERHUB_TOKEN` is a Docker Hub access token (Account Settings → Personal access tokens) with `Read, Write, Delete` scope on `chrisleekr/binance-trading-bot`. Do not use a Docker Hub password.

The `BINANCE_TESTNET_*` rows are **presence-gated**: `nightly.yml`'s gate step sets `skip=true` when either is empty and the testnet-e2e job is skipped with a log line, so nightly is safe on a fresh fork without any provisioning.

The `DOCKERHUB_*` rows are **not** presence-gated — `docker/login-action@v3` fails hard when either secret is missing. Two jobs need them, so provision both before **either** trigger first fires: `ci.yml`'s login runs on every non-PR push to `main`, and `release-please.yml`'s runs when a release is created. Each login is itself conditional (`PUSH_DEV_IMAGE` and `steps.release.outputs.release_created` respectively), so an unprovisioned repo stays green until the first push to `main`.

No GitLab credential is provisioned in GitHub, by decision: GitLab secrets do not belong in the public GitHub repo. The `nightly.yml` job that once fanned drift signals into GitLab was deleted, and `GITLAB_PROJECT_TOKEN` / `GITLAB_URL` / `GITLAB_PROJECT_ID` must not be recreated.

### Not provisioned, not used

The CI surface deliberately avoids any of the following:

- No PAT (`GH_PAT`, `PERSONAL_ACCESS_TOKEN`, etc.).
- No `GHCR_TOKEN` — release images publish to Docker Hub, not GHCR.
- No `GITLAB_REGISTRY_TOKEN` — `CI_REGISTRY_*` triplet is sufficient.
- No long-lived deploy keys.

A simple greppable invariant — `grep -RInE 'secrets\.(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)\b|\$(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)\b|(^|[[:space:]])(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)[[:space:]]*:' .github/workflows .gitlab-ci.yml` — must return zero matches at all times. The alternation covers GitHub-style `secrets.<NAME>` references, GitLab-style `$<NAME>` interpolations, and YAML key declarations like `<NAME>:`. The PAT arm is anchored as `PAT` or `PAT_<UPPER>`, so `PATH`/`PATTERN`/etc. don't trip the regex.

## Verification on a fresh checkout

```bash
# Tag scheme — build the app image locally as a one-off dev tag (no app
# argument needed; the script defaults to the single `server` image):
bash scripts/ci/docker-build.sh --tag-extra dev

# Build the Docker Hub release-tag combo the way release-please does:
bash scripts/ci/docker-build.sh \
  --single-repo \
  --registry chrisleekr/binance-trading-bot \
  --tag-version v1.2.3 --tag-latest
# → chrisleekr/binance-trading-bot:{v1.2.3,latest}

# Secrets posture: catches GitHub `secrets.<NAME>`, GitLab `$<NAME>`, and YAML `<NAME>:` keys
grep -RInE 'secrets\.(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)\b|\$(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)\b|(^|[[:space:]])(PAT(_[A-Z_]+)?|GHCR_TOKEN|GITLAB_REGISTRY_TOKEN)[[:space:]]*:' \
  .github/workflows .gitlab-ci.yml || echo 'no PAT-like secrets — OK'
```

## Buildx layer cache

`scripts/ci/docker-build.sh` writes a registry-backed layer cache to a **single shared tag per image repo**, `<repo>:buildcache`:

```bash
--cache-from "type=registry,ref=${repo}:buildcache"
--cache-to   "type=registry,ref=${repo}:buildcache,mode=max,image-manifest=true"
```

The cache is **not** scoped per branch. BuildKit keys reuse on layer content hashes, so a branch build reads the same cache the default branch wrote and still gets a correct result; per-branch scoping would only multiply storage. `mode=max` exports intermediate layers so a later build can skip the `bun install` and QEMU-emulated arm64 stages. `image-manifest=true` is required because the GitLab Container Registry rejects the default OCI manifest list for cache refs.

Both arms are gated on `--push` **and** `--registry` together, because the cache round-trips through a registry. Local builds (neither flag) and `--check` builds stay offline and neither read nor write it.

This applies to **every** registry the script pushes to, Docker Hub included — `ci.yml` and `release-please.yml` both push with a registry, so `chrisleekr/binance-trading-bot:buildcache` is a real, publicly visible tag on Docker Hub alongside `:latest` and the version tags.

**No cleanup policy is required.** `buildcache` is one rolling tag per repo that each push overwrites, so tag count does not grow with branches or commits; superseded layer blobs become unreferenced and are reclaimed by the registry's own garbage collection. What does accumulate on GitLab is one `:<ref-slug>` tag per git tag — that is the surface worth a retention rule, not the cache.

If a cleanup policy is ever configured, it must not match `buildcache`. Deleting it costs a full cold rebuild — tens of GB of `mode=max` export per image per platform — but nothing else; the next push repopulates it.
