---
goal: GitHub Actions CI for pull requests and a tag-driven release that publishes the KubeLynx image and Helm chart (OCI) to GHCR
version: 1
date_created: 2026-09-27
last_updated: 2026-09-27
owner: rafaelpissolatto
status: 'Planned'
tags: [infrastructure, ci, release, github-actions, helm, ghcr]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Implements GitHub issue #52 (parent #1, blocked by #10). The repo has no `.github/workflows/`. Issue #10 (`plan/feature-packaging-helm-1.md`) produces a `Dockerfile` and a chart at `charts/kubelynx/`, but nothing builds or publishes them. The chart's default `image.repository: ghcr.io/rafaelpissolatto/kubelynx` points at an image that doesn't exist yet (RISK-004 in that plan).

This plan adds:

1. `.github/workflows/ci.yml`, which verifies Go, the frontend, the chart and the Docker build on every PR and every push to `main`.
2. `.github/workflows/release.yml`. On a `v*.*.*` tag it pushes a multi-arch image to GHCR, pushes the Helm chart to GHCR as an OCI artifact, and creates a GitHub Release.

A single git tag versions both artifacts, and the chart version is stamped at package time. After a release, users install with:

```
helm install kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z --set prometheus.url=...
```

## 1. Requirements & Constraints

- **REQ-001**: The CI workflow runs on `pull_request` (all branches) and on `push` to `main`. It fails if any of these fail: `go vet ./...`, `go test ./...`, `npm ci`, `npm run lint`, `npm run build` (in `web/`), `helm lint charts/kubelynx`, the chart assertions script (TASK-003), or `docker build` of the root `Dockerfile`.
- **REQ-002**: The release workflow triggers only on `push` of tags matching `v*.*.*`. It never triggers on branches or PRs.
- **REQ-003**: The image is built for `linux/amd64` and `linux/arm64` and pushed to `ghcr.io/rafaelpissolatto/kubelynx`. For a stable tag `vX.Y.Z`, the image tags are `X.Y.Z`, `X.Y` and `latest`. For a pre-release tag (containing `-`, e.g. `v0.2.0-rc.1`), the only image tag is `X.Y.Z-rc.N`, and `latest` and `X.Y` do not move.
- **REQ-004**: The chart is packaged with `helm package charts/kubelynx --version <V> --app-version <V>`, where `<V>` is the tag with the leading `v` removed. It is pushed to `oci://ghcr.io/rafaelpissolatto/charts`, which produces the package `ghcr.io/rafaelpissolatto/charts/kubelynx:<V>`. Because the chart's `image.tag: ""` defaults to `.Chart.AppVersion` (#10, TASK-014), each chart version pulls the matching image tag with no extra wiring.
- **REQ-005**: The chart push runs only after the image push succeeds, so a published chart never references a missing image.
- **REQ-006**: A GitHub Release is created for the tag with `--generate-notes`, with `kubelynx-<V>.tgz` attached. It is marked `--prerelease` when the tag contains `-`.
- **REQ-007**: The README's Install section (added in #10, TASK-021) documents the OCI install command and states that the chart and image versions are identical.
- **SEC-001**: The only credential is `GITHUB_TOKEN`; no repository secrets are added. The workflow-level `permissions: {}` grants nothing, and each job declares least privilege. CI jobs get `contents: read`. The release image and chart jobs get `contents: read, packages: write`. The release job gets `contents: write`.
- **SEC-002**: Every third-party action is pinned to a full commit SHA, with the version in a trailing comment (e.g. `uses: actions/checkout@<sha> # v5.0.0`). First-party `actions/*` are pinned the same way.
- **SEC-003**: The `ci.yml` jobs use `pull_request`, not `pull_request_target`, so fork PRs never receive a token with write scopes.
- **CON-001**: GHCR requires a lowercase owner in image and chart refs. `rafaelpissolatto` is already lowercase, so `release.yml` uses the literal prefix `ghcr.io/rafaelpissolatto` rather than `${{ github.repository_owner }}`, which isn't guaranteed to be lowercase.
- **CON-002**: Helm chart versions must be SemVer 2 without a leading `v`, so the tag is stripped with `${GITHUB_REF_NAME#v}`.
- **CON-003**: The committed `version` and `appVersion` in `charts/kubelynx/Chart.yaml` are development placeholders (`0.1.0`), and the release workflow ignores them. Releases never commit version bumps back to the repo.
- **CON-004**: Helm must be v3.8 or later for OCI push/pull. CI pins Helm with `azure/setup-helm` to an explicit version (`v3.18.x` or the current stable release at implementation time).
- **CON-005**: The Go version comes from `go.mod` (`go-version-file: go.mod`), and the Node version is `24`, both matching #10's Dockerfile (CON-003 in that plan).
- **GUD-001**: Workflow `name:` and job ids are short and lowercase (`ci`, `release`; jobs `go`, `web`, `chart`, `docker`, `image`, `chart-publish`, `github-release`).
- **GUD-002**: `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` on `ci.yml`. On `release.yml`, use `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`, so an in-flight release is never cancelled halfway.
- **PAT-001**: Docker image tags are computed with `docker/metadata-action` using the rules `type=semver,pattern={{version}}`, `type=semver,pattern={{major}}.{{minor}}` and `type=raw,value=latest,enable=${{ !contains(github.ref_name, '-') }}`. The `{{major}}.{{minor}}` rule already skips pre-releases.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: CI verifies every PR. The phase is complete when a PR touching any file runs `ci.yml`, all four jobs pass on current `main` (after #10 merges), and deliberately breaking a Go test, a TS lint rule, the chart or the Dockerfile fails the corresponding job.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `.github/workflows/ci.yml` with `on: { pull_request: {}, push: { branches: [main] } }`, `permissions: {}` and the GUD-002 concurrency block. Job `go` (`runs-on: ubuntu-latest`, `permissions: { contents: read }`) runs `actions/checkout`, `actions/setup-go` (`go-version-file: go.mod`, `cache: true`), `go vet ./...` and `go test -race ./...`. | | |
| TASK-002 | In `ci.yml`, job `web` (`contents: read`) runs `actions/checkout`, then `actions/setup-node` (`node-version: 24`, `cache: npm`, `cache-dependency-path: web/package-lock.json`). Then, with `working-directory: web`, it runs `npm ci`, `npm run lint` and `npm run build`. | | |
| TASK-003 | Create the executable `dev/scripts/check-chart.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`), which implements #10's TEST-004 and TEST-005 as assertions. (1) Run `helm template t charts/kubelynx` and check that its `^kind:` lines, sorted and deduped, equal exactly `kind: Deployment` and `kind: Service`. (2) Check that the same output has no `kind: (ClusterRole\|Role\|ClusterRoleBinding\|RoleBinding\|ServiceAccount)`. (3) Check that `helm template t charts/kubelynx --set prometheus.bearerToken.existingSecret.name=prom-token` contains `--prometheus-bearer-token-file=` and `secretName: prom-token`. (4) Check that `helm template t charts/kubelynx --set prometheus.url=` exits non-zero. (5) Check that `--set refreshInterval=abc` and `--set refreshInterval=30` both exit non-zero, and `--set refreshInterval=1m30s` renders. (6) Check that the output contains no `subPath:` field, because Secret rotation needs a directory mount. Each failure prints `FAIL: <reason>` and exits 1, and success prints `PASS`, matching the output style of `dev/scripts/validate.sh`. | | |
| TASK-004 | In `Makefile`, change the `lint-chart` target from #10 (TASK-020) to run `helm lint charts/kubelynx && ./dev/scripts/check-chart.sh`. | | |
| TASK-005 | In `ci.yml`, job `chart` (`contents: read`) runs `actions/checkout`, `azure/setup-helm` (CON-004) and `make lint-chart`. | | |
| TASK-006 | In `ci.yml`, job `docker` (`contents: read`) runs `actions/checkout`, `docker/setup-buildx-action`, and `docker/build-push-action` with `context: .`, `push: false`, `platforms: linux/amd64`, `cache-from: type=gha,scope=kubelynx` and `cache-to: type=gha,mode=max,scope=kubelynx`. It builds amd64 only in CI to keep PR runs fast, while release builds both platforms. | | |

### Implementation Phase 2

- GOAL-002: A tag publishes the image, chart and release. The phase is complete when pushing `v0.1.0` produces `ghcr.io/rafaelpissolatto/kubelynx:0.1.0`, `:0.1` and `:latest` (multi-arch manifest), `oci://ghcr.io/rafaelpissolatto/charts/kubelynx` version `0.1.0`, and a GitHub Release `v0.1.0` with `kubelynx-0.1.0.tgz` attached.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Create `.github/workflows/release.yml` with `on: { push: { tags: ['v*.*.*'] } }`, `permissions: {}` and the GUD-002 release concurrency block. Add a workflow-level `env: { REGISTRY: ghcr.io/rafaelpissolatto, IMAGE: ghcr.io/rafaelpissolatto/kubelynx }`. | | |
| TASK-008 | In `release.yml`, job `image` (`permissions: { contents: read, packages: write }`) runs `actions/checkout`, `docker/setup-qemu-action`, `docker/setup-buildx-action`, and `docker/login-action` (`registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`). It then runs `docker/metadata-action` (`images: ${{ env.IMAGE }}`, with the PAT-001 tag rules) and `docker/build-push-action` with `context: .`, `platforms: linux/amd64,linux/arm64`, `push: true`, `tags`/`labels` from the metadata step, and the same gha cache scope as TASK-006. | | |
| TASK-009 | In `release.yml`, job `chart-publish` (`needs: image`, `permissions: { contents: read, packages: write }`) runs `actions/checkout` and `azure/setup-helm`. It sets `VERSION="${GITHUB_REF_NAME#v}"` into `$GITHUB_ENV`, then runs `helm lint charts/kubelynx`, `helm package charts/kubelynx --version "$VERSION" --app-version "$VERSION" --destination dist/`, `echo "${{ secrets.GITHUB_TOKEN }}" \| helm registry login ghcr.io -u "${{ github.actor }}" --password-stdin`, and `helm push "dist/kubelynx-$VERSION.tgz" oci://ghcr.io/rafaelpissolatto/charts`. Finally, `actions/upload-artifact` uploads `dist/kubelynx-$VERSION.tgz` under the name `chart`. | | |
| TASK-010 | In `release.yml`, job `github-release` (`needs: chart-publish`, `permissions: { contents: write }`) runs `actions/checkout` and downloads the `chart` artifact with `actions/download-artifact` into `dist/`. It then runs `gh release create "$GITHUB_REF_NAME" dist/*.tgz --verify-tag --generate-notes --title "$GITHUB_REF_NAME" $( [[ "$GITHUB_REF_NAME" == *-* ]] && echo --prerelease )`, with `env: { GH_TOKEN: ${{ github.token }} }`. | | |
| TASK-011 | In `README.md`, extend the #10 Install section with the published-artifact path: `helm install kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z --set prometheus.url=...` and `helm show values oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z`. Add one sentence stating that the chart version equals the app/image version. Keep the local `./charts/kubelynx` install for development. | | |
| TASK-012 | Create `docs/releasing.md` with the release procedure. (1) Merge to `main` with CI green. (2) `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. (3) Watch `release.yml`. (4) The **first release only** needs a manual step: in GitHub → Packages, set `kubelynx` and `charts/kubelynx` visibility to Public, and under "Manage Actions access" confirm the repo has write access. (5) Verify with TEST-005. For pre-releases, use tags like `v0.2.0-rc.1`. | | |

### Implementation Phase 3

- GOAL-003: The first real release is verified end to end. The phase is complete when TEST-005 and TEST-006 pass against `v0.1.0` from a machine logged out of GHCR.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | After #10 and Phases 1–2 merge to `main`, push the tag `v0.1.0-rc.1` and confirm REQ-003's pre-release rule: `latest` is absent and the Release is marked pre-release. Then push `v0.1.0`. | | |
| TASK-014 | Human: set both GHCR packages to Public (TASK-012, step 4). Then run TEST-005 and TEST-006 and tick the checkboxes on issue #52. | | |

## 3. Alternatives

- **ALT-001**: A classic Helm repo on GitHub Pages via `helm/chart-releaser-action` (`gh-pages` branch plus `index.yaml`). Rejected: it needs an extra branch and index maintenance, and it separates the chart's storage from the image's. OCI in GHCR reuses the same registry and token. The trade-off is that `helm repo add` / `helm search repo` don't work with OCI; users pass the full `oci://` URL. That's acceptable for a single chart.
- **ALT-002**: Independent chart versioning, bumped in `Chart.yaml` separately from the app. Rejected for now: chart-only changes are rare at this stage, and lockstep versioning removes a whole class of version-drift errors. Revisit if chart-only patch releases become frequent.
- **ALT-003**: Committing version bumps to `Chart.yaml` from the release workflow. Rejected: it needs `contents: write` on `main` (and a branch-protection bypass), and stamping at package time gives the same result.
- **ALT-004**: Automated versioning (release-please, semantic-release). Rejected as unneeded process for a single-maintainer repo; manual `git tag` is enough. It can be layered on later, because it only needs to push the same `v*` tags.
- **ALT-005**: Docker Hub instead of GHCR. Rejected: it would need a separate account and secret, and GHCR works with `GITHUB_TOKEN` alone (SEC-001).
- **ALT-006**: Building multi-arch images in PR CI. Rejected for speed (QEMU arm64 builds are slow). The amd64 build catches Dockerfile breakage, and arm64 is only exercised at release, where a failure blocks publishing before anything is pushed (REQ-005).

## 4. Dependencies

- **DEP-001**: Issue #10 must merge first. It provides the root `Dockerfile`, `charts/kubelynx/` (with `image.tag` defaulting to `.Chart.AppVersion`), the `Makefile` `lint-chart` target, and the README Install section. This dependency is recorded as a native GitHub dependency on #52.
- **DEP-002**: Issue #9 (bearer-token flag). The token-wiring assertion in `check-chart.sh` (TASK-003, step 3) only passes once the chart from #10 renders the token flag. It has no other effect on this plan.
- **DEP-003**: GitHub Actions: `actions/checkout`, `actions/setup-go`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action`, `docker/build-push-action` and `azure/setup-helm`. Use the latest major version of each at implementation time, SHA-pinned (SEC-002).
- **DEP-004**: GitHub-hosted `ubuntu-latest` runners, which include the `gh` CLI and Docker.
- **DEP-005**: GHCR package settings (a manual, one-time step; TASK-014).

## 5. Files

- **FILE-001**: `.github/workflows/ci.yml` (new): jobs `go`, `web`, `chart` and `docker`.
- **FILE-002**: `.github/workflows/release.yml` (new): jobs `image`, `chart-publish` and `github-release`.
- **FILE-003**: `dev/scripts/check-chart.sh` (new, executable): chart structure assertions.
- **FILE-004**: `Makefile` (modified): `lint-chart` also runs `check-chart.sh`.
- **FILE-005**: `README.md` (modified): OCI install command.
- **FILE-006**: `docs/releasing.md` (new): release procedure and the first-release manual step.

## 6. Testing

- **TEST-001**: Open a PR containing Phase 1. All four `ci.yml` jobs run and pass.
- **TEST-002**: On a throwaway branch, make four separate commits, each introducing one failure: a failing Go assertion, an oxlint violation, adding a `ClusterRole` template to the chart, and a typo in the `Dockerfile`. Each commit fails exactly the corresponding job (`go`, `web`, `chart`, `docker`). Delete the branch afterwards.
- **TEST-003**: Run `./dev/scripts/check-chart.sh` locally against the #10 chart. It prints `PASS`. Temporarily adding `templates/sa.yaml` with `kind: ServiceAccount` makes it print `FAIL` and exit 1.
- **TEST-004**: `actionlint .github/workflows/*.yml` reports zero findings. Run it locally via `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.
- **TEST-005**: After `v0.1.0` has been released and the packages made public, run these checks from a shell with `docker logout ghcr.io` and `helm registry logout ghcr.io` applied:
  - `docker manifest inspect ghcr.io/rafaelpissolatto/kubelynx:0.1.0` lists both `amd64` and `arm64`.
  - `docker manifest inspect ghcr.io/rafaelpissolatto/kubelynx:latest` resolves to the same digest.
  - `helm show chart oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version 0.1.0` prints `version: 0.1.0` and `appVersion: 0.1.0`.
  - `gh release view v0.1.0` lists `kubelynx-0.1.0.tgz`.
- **TEST-006**: On the kind dev cluster (`make setup`), run `helm install kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version 0.1.0 -n kubelynx --create-namespace --set prometheus.url=http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090 --wait`. The pod image is `ghcr.io/rafaelpissolatto/kubelynx:0.1.0`, and after `kubectl port-forward -n kubelynx svc/kubelynx 8080:80` the UI renders the demo topology (verify with Playwright/Chromium).
- **TEST-007**: For pre-release tag `v0.1.0-rc.1` (TASK-013), `docker manifest inspect ghcr.io/rafaelpissolatto/kubelynx:0.1.0-rc.1` succeeds, `:latest` does not exist yet (or is unchanged from the prior stable release), and `gh release view v0.1.0-rc.1 --json isPrerelease` returns `true`.

## 7. Risks & Assumptions

- **RISK-001**: The first push creates private GHCR packages, so anonymous `helm install` and image pulls return `401`/`403` until they're made public manually (TASK-014). Mitigation: this is documented in `docs/releasing.md` and in #52.
- **RISK-002**: arm64 builds under QEMU are slow; the `npm ci` / `vite build` stage may take several minutes. Mitigation: gha layer cache (TASK-008). If it's still too slow, change #10's Dockerfile so the `web` stage uses `FROM --platform=$BUILDPLATFORM` (the frontend output is platform-independent) and the Go stage cross-compiles with `GOARCH=$TARGETARCH` instead of emulating. This is a small follow-up edit to #10's Dockerfile, and it's recommended if a release build exceeds 10 minutes.
- **RISK-003**: A tag pushed on a commit whose CI failed still publishes, because the release workflow doesn't re-check CI status. Mitigation: `docs/releasing.md` requires tagging only green `main` commits, and `chart-publish` re-runs `helm lint`. Gating on CI status is deferred.
- **RISK-004**: The `latest` tag moves on every stable release, so users who pin `latest` get unannounced upgrades. Mitigation: the chart always pins `appVersion`, so `latest` affects only ad-hoc `docker run` usage.
- **ASSUMPTION-001**: The repo stays at `github.com/rafaelpissolatto/kubelynx`. The owner is hardcoded in `release.yml` `env` (CON-001) and in the chart's `image.repository` default.
- **ASSUMPTION-002**: The GitHub Actions free tier for public repos is sufficient; no self-hosted runners are needed.
- **ASSUMPTION-003**: No branch protection currently blocks pushing tags. Tag protection rules, if added later, don't affect the workflow.

## 8. Related Specifications / Further Reading

- Issue #52: https://github.com/rafaelpissolatto/kubelynx/issues/52
- Blocker, issue #10 and its plan `plan/feature-packaging-helm-1.md`: https://github.com/rafaelpissolatto/kubelynx/issues/10
- Parent PRD, issue #1: https://github.com/rafaelpissolatto/kubelynx/issues/1
- Helm OCI registries: https://helm.sh/docs/topics/registries/
- Working with the GHCR container registry: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- `docker/metadata-action` tag rules: https://github.com/docker/metadata-action#tags-input
- GitHub Actions security hardening (SHA pinning, least-privilege tokens): https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
