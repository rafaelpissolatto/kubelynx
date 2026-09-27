---
goal: Package KubeLynx as a single container image (Go binary embedding the Vite frontend) plus a Helm chart installing one Deployment and one Service
version: 1
date_created: 2026-09-27
last_updated: 2026-09-27
owner: rafaelpissolatto
status: 'Completed'
tags: [feature, packaging, helm, docker, infrastructure]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implements GitHub issue #10 (parent #1). KubeLynx currently runs as two dev processes: `go run ./cmd/kubelynx`, which serves `/api/*` only, and `npm run dev` in `web/`, which proxies `/api` to `:8080` (`web/vite.config.ts`). This plan produces:

1. One container image. Its Go binary serves both the API and the Vite-built frontend, which is embedded with `go:embed` (ADR `docs/adr/0001-single-image-packaging.md`).
2. A Helm chart at `charts/kubelynx/` that installs exactly one Deployment and one Service. Its `values.yaml` exposes the Prometheus base URL, an optional bearer-token Secret reference, and the refresh interval.
3. Makefile targets that build the image, load it into the kind dev cluster (`make setup`), install the chart, and port-forward to it.

## 1. Requirements & Constraints

- **REQ-001**: One Dockerfile at the repo root builds the frontend (`web/`, `npm ci && npm run build`) and embeds `web/dist` into the Go binary. No separate frontend image.
- **REQ-002**: The Go binary serves the embedded frontend at `/` (`index.html` plus hashed assets under `/assets/`, and the files from `web/public/`: `favicon.ico`, `logo.svg`, `site.webmanifest`, icons). The existing `/api/topology`, `/api/namespaces` and `/api/protocols` routes keep working unchanged.
- **REQ-003**: The Helm chart `charts/kubelynx/` renders exactly one `Deployment` and one `Service`, and no other objects.
- **REQ-004**: `values.yaml` exposes `prometheus.url` (string, required), `prometheus.bearerToken.existingSecret.name` / `.key` (optional), and `refreshInterval` (Go duration string, default `15s`).
- **REQ-005**: The refresh interval set in Helm must actually drive the frontend's polling cadence. The backend exposes it via a new `GET /api/config` endpoint returning `{"refreshIntervalMs": <int>}`. The frontend uses that value as its default, and the existing `?refreshInterval=<ms>` URL override still takes precedence.
- **REQ-006**: `helm install` against the dev cluster from `make setup` produces a Ready pod. Then `kubectl port-forward svc/kubelynx 8080:80` followed by opening `http://localhost:8080` renders the topology of the `demo-frontend` / `demo-backend` namespaces.
- **SEC-001**: The chart renders no `ClusterRole`, `Role`, `ClusterRoleBinding`, `RoleBinding` or `ServiceAccount`. The pod sets `automountServiceAccountToken: false` so no Kubernetes API credentials are mounted.
- **SEC-002**: The container runs as non-root (UID 65532, distroless `nonroot`) with `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` and `seccompProfile.type: RuntimeDefault`.
- **SEC-003**: The bearer token is never passed as a CLI argument or plain env value in the rendered manifest. It is mounted from the Secret as a file and read by the binary via `--prometheus-bearer-token-file`.
- **CON-001**: `go:embed` cannot reference paths outside the embedding package's directory, so the embed directive must live in a Go file inside `web/`.
- **CON-002**: `go build ./...`, `go vet ./...` and `go test ./...` must still pass on a fresh clone where `web/dist` does not exist, because `web/dist` is gitignored (`.gitignore`, `web/.gitignore`). So the embed sits behind the build tag `embedui`, with a no-embed fallback.
- **CON-003**: The Go toolchain version in the Dockerfile must match `go.mod` (`go 1.26.5`). The Node major must match the dev toolchain (Node 24, per `@types/node ^24`).
- **CON-004**: The Beyla/Prometheus dev manifests (`dev/**`) are not modified.
- **GUD-001**: Match the existing handler style in `internal/api/protocols.go`: a `XxxHandler(...) http.HandlerFunc` constructor, `Content-Type: application/json`, and `json.NewEncoder` with `slog.ErrorContext` on encode failure. Match the tests in `internal/api/protocols_test.go` (`package api_test`, `httptest.NewRecorder`).
- **GUD-002**: Keep the Helm chart minimal, following standard `helm create` conventions (`_helpers.tpl` with `kubelynx.fullname` and `kubelynx.labels`). Strip the scaffolding for ingress, HPA, serviceaccount and tests.
- **PAT-001**: Flags are defined with `flag.String` / `flag.Duration` in `cmd/kubelynx/main.go`, with a long help string, as the existing flags are.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: The Go binary serves the embedded frontend and a health endpoint, and exposes the refresh interval to the UI. The phase is complete when `go test ./...` passes without `web/dist`, and when `npm --prefix web run build && go build -tags embedui ./cmd/kubelynx` produces a binary that serves the UI at `/`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `web/embed_ui.go` with `//go:build embedui`, `package web`, `import "embed"` and `io/fs`, `//go:embed all:dist` `var dist embed.FS`, and `func Assets() (fs.FS, bool) { sub, err := fs.Sub(dist, "dist"); if err != nil { panic(err) }; return sub, true }`. | ✅ | 2026-09-27 |
| TASK-002 | Create `web/embed_none.go` with `//go:build !embedui`, `package web`, and `func Assets() (fs.FS, bool) { return nil, false }`. Add a doc comment on the package explaining the tag, and point to TASK-011's Dockerfile build stage as the only place that sets it. | ✅ | 2026-09-27 |
| TASK-003 | Create `internal/api/ui.go` with `func UIHandler(assets fs.FS, ok bool) http.Handler`. If `!ok`, return a handler that writes `503` with body `frontend not embedded: build with -tags embedui (or run "npm run dev" in web/)`. Otherwise, serve `http.FileServerFS(assets)`. For any request path not found in `assets`, and not prefixed `/api/`, serve `index.html` (SPA fallback: the UI keeps state in query params, so only `/` is hit today, but the fallback prevents 404s on deep links). Set `Cache-Control: public, max-age=31536000, immutable` for paths under `/assets/` (Vite content-hashed) and `Cache-Control: no-cache` for `index.html`. | ✅ | 2026-09-27 |
| TASK-004 | Create `internal/api/config.go` with `type configResponse struct { RefreshIntervalMs int64 \`json:"refreshIntervalMs"\` }` and `func ConfigHandler(refreshInterval time.Duration) http.HandlerFunc` returning `refreshInterval.Milliseconds()`, in GUD-001 style. | ✅ | 2026-09-27 |
| TASK-005 | Add `mux.HandleFunc("/healthz", ...)` in `cmd/kubelynx/main.go`, writing `200 ok` with no Prometheus call. Liveness must not depend on Prometheus reachability; the UI already reports Prometheus errors (issue #8). | ✅ | 2026-09-27 |
| TASK-006 | In `cmd/kubelynx/main.go`, add the flag `refreshInterval = flag.Duration("refresh-interval", 15*time.Second, "how often the UI polls /api/topology; served to the frontend via /api/config")`. Validate that it is `> 0`, otherwise `slog.Error` and `os.Exit(1)`. Register `mux.HandleFunc("/api/config", api.ConfigHandler(*refreshInterval))` and `mux.Handle("/", api.UIHandler(web.Assets()))`, importing `github.com/rafaelpissolatto/kubelynx/web`. Add `refresh_interval` and `ui_embedded` to the existing `kubelynx listening` log line. | ✅ | 2026-09-27 |
| TASK-007 | In `web/src/lib/topology.ts`, add `export interface ConfigResponse { refreshIntervalMs: number }` and `export async function fetchConfig(): Promise<ConfigResponse>`, following the `fetchProtocols` pattern. | ✅ | 2026-09-27 |
| TASK-008 | In `web/src/App.tsx` (the `refreshIntervalMs` state, ~line 135), change the state to settable. On mount, if `?refreshInterval` is absent or invalid, call `fetchConfig()` and apply `refreshIntervalMs` when it is `> 0`. On fetch failure, keep `DEFAULT_REFRESH_INTERVAL_MS` (15000) and `console.error`; do not surface this in the UI error state. The URL param still overrides. | ✅ | 2026-09-27 |

### Implementation Phase 2

- GOAL-002: One container image builds from a clean checkout. The phase is complete when `docker build -t kubelynx:dev .` succeeds, and when `docker run --rm -p 8080:8080 kubelynx:dev --prometheus-url=http://host.docker.internal:9090` serves the UI at `http://localhost:8080` and `200` at `/healthz`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | Create `.dockerignore` excluding `.git`, `web/node_modules`, `web/dist`, `.playwright-mcp`, `mock`, `docs`, `dev`, `plan`, `charts`, `*.md`, and `.claude`. | ✅ | 2026-09-27 |
| TASK-010 | Create `Dockerfile`, stage 1 `web` (`FROM node:24-alpine AS web`): `WORKDIR /src/web`, `COPY web/package.json web/package-lock.json ./`, `RUN npm ci`, `COPY web/ ./`, `RUN npm run build`. | ✅ | 2026-09-27 |
| TASK-011 | In `Dockerfile`, stage 2 `build` (`FROM golang:1.26.5-alpine AS build`): `WORKDIR /src`, `COPY go.mod go.sum ./`, `RUN go mod download`, `COPY cmd/ cmd/`, `COPY internal/ internal/`, `COPY web/*.go web/`, `COPY --from=web /src/web/dist web/dist`, then `RUN CGO_ENABLED=0 go build -trimpath -tags embedui -ldflags="-s -w" -o /out/kubelynx ./cmd/kubelynx`. | ✅ | 2026-09-27 |
| TASK-012 | In `Dockerfile`, stage 3 (`FROM gcr.io/distroless/static-debian12:nonroot`): `COPY --from=build /out/kubelynx /kubelynx`, `USER 65532:65532`, `EXPOSE 8080`, `ENTRYPOINT ["/kubelynx"]`. Add OCI labels `org.opencontainers.image.source=https://github.com/rafaelpissolatto/kubelynx` and `org.opencontainers.image.licenses=Apache-2.0`. | ✅ | 2026-09-27 |

### Implementation Phase 3

- GOAL-003: The Helm chart installs one Deployment and one Service with no RBAC. The phase is complete when `helm lint charts/kubelynx` passes and the TEST-004 and TEST-005 template assertions pass.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | Create `charts/kubelynx/Chart.yaml`: `apiVersion: v2`, `name: kubelynx`, `type: application`, `version: 0.1.0`, `appVersion: "0.1.0"`, a description taken from the first sentence of `CONTEXT.md`, `annotations: {artifacthub.io/license: Apache-2.0}` (Chart.yaml has no top-level license field). | ✅ | 2026-09-27 |
| TASK-014 | Create `charts/kubelynx/values.yaml` with commented keys. `image.repository: ghcr.io/rafaelpissolatto/kubelynx`, `image.tag: ""` (defaults to `.Chart.AppVersion`), `image.pullPolicy: IfNotPresent`, `imagePullSecrets: []`. `prometheus.url: http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090`. `prometheus.bearerToken.existingSecret.name: ""`, `prometheus.bearerToken.existingSecret.key: token`. `refreshInterval: 15s`. `extraArgs: []`, an escape hatch for `--protocol-ports-file` / `--tcp-port-allowlist-file`. `service.type: ClusterIP`, `service.port: 80`. `resources.requests: {cpu: 10m, memory: 32Mi}`, `resources.limits: {memory: 128Mi}`. `podSecurityContext` and `securityContext` carry the SEC-002 values. Also `nodeSelector: {}`, `tolerations: []`, `affinity: {}`, `podAnnotations: {}`, `podLabels: {}`. | ✅ | 2026-09-27 |
| TASK-015 | Create `charts/kubelynx/templates/_helpers.tpl` with `kubelynx.name`, `kubelynx.fullname`, `kubelynx.labels` (including `app.kubernetes.io/name`, `instance`, `version` and `managed-by`, plus `helm.sh/chart`) and `kubelynx.selectorLabels` (`name` + `instance` only). | ✅ | 2026-09-27 |
| TASK-016 | Create `charts/kubelynx/templates/deployment.yaml`: `replicas: 1`, `automountServiceAccountToken: false` (SEC-001), with no `serviceAccountName`. The container args are `--listen-addr=:8080`, `--prometheus-url={{ required "prometheus.url is required" .Values.prometheus.url }}` and `--refresh-interval={{ .Values.refreshInterval }}`. When `.Values.prometheus.bearerToken.existingSecret.name` is set, add the arg `--prometheus-bearer-token-file=/var/run/secrets/kubelynx/prometheus/token`, a volume `secret: {secretName: <name>, items: [{key: <key>, path: token}]}`, and a read-only volumeMount at `/var/run/secrets/kubelynx/prometheus`. Append `.Values.extraArgs`. Set `containerPort: 8080` named `http`, and `livenessProbe` plus `readinessProbe` as `httpGet /healthz` on port `http`. | ✅ | 2026-09-27 |
| TASK-017 | Create `charts/kubelynx/templates/service.yaml`: `type: {{ .Values.service.type }}`, port `{{ .Values.service.port }}`, `targetPort: http`, `name: http`, with the selector set to `kubelynx.selectorLabels`. | ✅ | 2026-09-27 |
| TASK-018 | Create `charts/kubelynx/templates/NOTES.txt` printing the port-forward command `kubectl port-forward -n {{ .Release.Namespace }} svc/{{ include "kubelynx.fullname" . }} 8080:{{ .Values.service.port }}` and `http://localhost:8080`, plus a warning that KubeLynx has no built-in auth (parent #1, user story 18). | ✅ | 2026-09-27 |
| TASK-019 | Create `charts/kubelynx/.helmignore` using the standard `helm create` content. | ✅ | 2026-09-27 |

### Implementation Phase 4

- GOAL-004: One-command dev-cluster install. The phase is complete when `make setup && make deploy-kubelynx && make port-kubelynx` yields a working UI at `http://localhost:8080` that shows the demo namespaces.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | In `Makefile`, add `IMAGE ?= kubelynx:dev` and `KUBELYNX_NAMESPACE ?= kubelynx`. Add the targets `image` (`docker build -t $(IMAGE) .`); `kind-load` (`kind load docker-image $(IMAGE) --name $(CLUSTER_NAME)`); `deploy-kubelynx: image kind-load`, which runs `helm upgrade --install kubelynx charts/kubelynx --namespace $(KUBELYNX_NAMESPACE) --create-namespace --set image.repository=kubelynx --set image.tag=dev --set image.pullPolicy=Never --wait --timeout 2m`; and `port-kubelynx` (`kubectl port-forward -n $(KUBELYNX_NAMESPACE) svc/kubelynx 8080:80`). Add `lint-chart` (`helm lint charts/kubelynx`). Update `.PHONY`. Leave `setup` unchanged, so KubeLynx deployment stays an explicit step. | ✅ | 2026-09-27 |
| TASK-021 | In `README.md`, add an "Install" section covering `helm install kubelynx ./charts/kubelynx --set prometheus.url=...`, the bearer-token Secret example (`kubectl create secret generic prom-token --from-literal=token=...` plus `--set prometheus.bearerToken.existingSecret.name=prom-token`), the `refreshInterval` value, a statement that no RBAC is required, and the dev loop (`make deploy-kubelynx`, `make port-kubelynx`). | ✅ | 2026-09-27 |

### Implementation notes

Where the build differs from the task text above:

- **TASK-003**: Missing files under `/assets/` return 404 instead of falling back to `index.html`, so a stale tab's request for an old bundle is never answered with the app shell under a one-year `immutable` cache header. Directory requests other than `/` (e.g. `/assets/`) also return 404 rather than a file listing. The parameter is named `embedded`, not `ok`.
- **TASK-006**: `--refresh-interval` must be at least `1ms`, not just `> 0`, because `/api/config` reports whole milliseconds and a shorter value would reach the UI as `0`.
- **TASK-014 / TASK-016**: The chart can't mount extra files, so `extraArgs` can't carry the file-based flags (`--protocol-ports-file`, `--tcp-port-allowlist-file`). The `values.yaml` comment says so, and mounting them is a follow-up. The Deployment template fails the render with a clear message when `refreshInterval` isn't a Go duration, instead of letting the pod crash-loop.
- **TASK-020**: The Makefile uses `IMAGE_REPO` and `IMAGE_TAG` instead of splitting `IMAGE` on `:`, which broke for registries with a port. `deploy-kubelynx` ends with `kubectl rollout restart`, because the `kubelynx:dev` tag never changes between rebuilds.
- **TEST-004/005**: The assertions ran from a local script. #52 (TASK-003) commits them as `dev/scripts/check-chart.sh` and adds the `refreshInterval` checks from above.
- **TEST-008**: The Playwright MCP server expected Google Chrome, which isn't installed, so the browser checks ran as a Node script driving Playwright's bundled Chromium.

## 3. Alternatives

- **ALT-001**: Separate nginx frontend image plus API image. Rejected by ADR 0001: it would mean two images and two Deployments for a single-replica tool.
- **ALT-002**: An untagged `//go:embed all:dist` plus a committed placeholder `web/dist/index.html`. Rejected because Vite empties `outDir` on every build, so the placeholder would be deleted and show up as a git diff, and a fresh clone would still need the placeholder to compile.
- **ALT-003**: Configuring the refresh interval only through the existing `?refreshInterval=` URL param. Rejected: a Helm value can't set a URL param, so the value in `values.yaml` would have no effect (REQ-005).
- **ALT-004**: Injecting the refresh interval into `index.html` at serve time (a `<script>window.__KUBELYNX__=...</script>` rewrite). Rejected in favor of `/api/config`: rewriting HTML at serve time conflicts with static serving and caching, and a JSON endpoint follows the existing `/api/protocols` pattern.
- **ALT-005**: Passing the bearer token as the env var `KUBELYNX_PROMETHEUS_BEARER_TOKEN` via `secretKeyRef`. Rejected in favor of a file mount: env values can't be rotated without a pod restart, and they leak into `kubectl describe`-adjacent tooling and crash dumps. A file also matches Prometheus client conventions (`bearer_token_file`).
- **ALT-006**: A dedicated `ServiceAccount` object with `automountServiceAccountToken: false`. Rejected to keep the rendered objects to exactly Deployment + Service (issue #10 AC). The namespace's `default` SA with automount disabled on the pod gives the same zero-permission result.
- **ALT-007**: Having the chart create a Secret from a plaintext `prometheus.bearerToken.value`. Deferred, because plaintext secrets in values files are an anti-pattern. Only `existingSecret` is supported in this plan. Adding it later requires relaxing REQ-003.

## 4. Dependencies

- **DEP-001**: Issue #9 (bearer-token auth to Prometheus) must land first and expose the CLI flag `--prometheus-bearer-token-file=<path>`. The issue body of #10 lists this blocker as "#7", which is a typo: #7 is the flows table (closed). If #9 lands with a different flag name, TASK-016 uses that name instead. Phases 1–2 and the non-token parts of Phase 3 do not depend on #9 and can proceed in parallel.
- **DEP-002**: Issue #3 (topology walking skeleton) is closed and satisfied.
- **DEP-003**: Build tooling: Docker (BuildKit), `helm` v3, `kind`, Node 24 and Go 1.26.5. All are present on the dev machine (`/usr/bin/docker`, `/usr/local/bin/helm`, `/usr/local/bin/kind`).
- **DEP-004**: Base images `node:24-alpine`, `golang:1.26.5-alpine` and `gcr.io/distroless/static-debian12:nonroot`.
- **DEP-005**: Dev cluster from `make setup`: kind cluster `kubelynx-dev`, with Prometheus at `prometheus-kube-prometheus-prometheus.monitoring.svc:9090`, Beyla, and the demo traffic.

## 5. Files

- **FILE-001**: `web/embed_ui.go` (new): `embedui`-tagged `go:embed all:dist`.
- **FILE-002**: `web/embed_none.go` (new): the untagged fallback, where `Assets()` returns `(nil, false)`.
- **FILE-003**: `internal/api/ui.go` (new): `UIHandler`, a static file server with SPA fallback and cache headers.
- **FILE-004**: `internal/api/config.go` (new): `ConfigHandler` for `/api/config`.
- **FILE-005**: `cmd/kubelynx/main.go` (modified): `--refresh-interval` flag, plus the `/healthz`, `/api/config` and `/` routes.
- **FILE-006**: `web/src/lib/topology.ts` (modified): `fetchConfig`.
- **FILE-007**: `web/src/App.tsx` (modified): the refresh interval is sourced from `/api/config` when there's no URL override.
- **FILE-008**: `Dockerfile` (new): the three-stage build.
- **FILE-009**: `.dockerignore` (new).
- **FILE-010**: `charts/kubelynx/Chart.yaml`, `values.yaml`, `.helmignore`, `templates/_helpers.tpl`, `templates/deployment.yaml`, `templates/service.yaml` and `templates/NOTES.txt` (all new).
- **FILE-011**: `Makefile` (modified): `image`, `kind-load`, `deploy-kubelynx`, `port-kubelynx` and `lint-chart`.
- **FILE-012**: `README.md` (modified): Install section.
- **FILE-013**: `internal/api/ui_test.go` and `internal/api/config_test.go` (new).

## 6. Testing

- **TEST-001**: `internal/api/config_test.go`: `ConfigHandler(30*time.Second)` returns `200`, `Content-Type: application/json` and `{"refreshIntervalMs":30000}`.
- **TEST-002**: `internal/api/ui_test.go`, using `fstest.MapFS{"index.html": ..., "assets/app-abc.js": ...}` as `assets`. Check that `GET /` returns `index.html` content with `Cache-Control: no-cache`; `GET /assets/app-abc.js` returns `200` with the `immutable` cache header; `GET /some/deep/link` returns `index.html`; and `GET /api/unknown` returns `404`, not `index.html`.
- **TEST-003**: `internal/api/ui_test.go`: `UIHandler(nil, false)` returns `503` with the "frontend not embedded" message.
- **TEST-004**: Chart object-count assertion. `helm template t charts/kubelynx | grep -E '^kind:' | sort | uniq -c` outputs exactly `1 kind: Deployment` and `1 kind: Service`. Running `grep -E 'kind: (ClusterRole|Role|ClusterRoleBinding|RoleBinding|ServiceAccount)'` on the same output returns no matches (SEC-001).
- **TEST-005**: Chart token wiring. `helm template t charts/kubelynx --set prometheus.bearerToken.existingSecret.name=prom-token` contains `--prometheus-bearer-token-file=/var/run/secrets/kubelynx/prometheus/token`, a `secretName: prom-token` volume, and no token literal. Without the value set, none of these three are present. `helm template t charts/kubelynx --set prometheus.url=` fails with `prometheus.url is required`.
- **TEST-006**: `helm lint charts/kubelynx` passes with zero errors.
- **TEST-007**: `go build ./... && go vet ./... && go test ./...` pass on a clean checkout without `web/dist` (CON-002). `go vet -tags embedui ./...` passes after `npm --prefix web run build`.
- **TEST-008** (manual e2e, REQ-006): Run `make setup`, `make deploy-kubelynx`, then `make port-kubelynx`. Use the Playwright MCP (Chromium) to open `http://localhost:8080`, confirm the graph renders `demo-frontend` → `demo-backend` workloads, confirm the favicon loads, and confirm the network log shows `/api/config` followed by `/api/topology` polling at the chart's interval. Repeat with `--set refreshInterval=5s` and confirm the polling cadence changes to ~5s.
- **TEST-009** (manual): `kubectl get pod -n kubelynx -o jsonpath='{.items[0].spec.automountServiceAccountToken}'` prints `false`. `kubectl exec` cannot run in distroless, so verify the absence of `/var/run/secrets/kubernetes.io` via `kubectl get pod -o yaml` (there must be no `kube-api-access-*` volume).

## 7. Risks & Assumptions

- **RISK-001**: #9 may pick a flag name or token mechanism different from `--prometheus-bearer-token-file`. Mitigation: DEP-001 isolates the token wiring to TASK-016. Comment on #9 before implementation to align on the file-based flag.
- **RISK-002**: `web/` becomes a Go package (`package web`) alongside `package.json`. Tooling that globs `web/**` (oxlint, tsc) ignores `.go` files. Low risk, but check `tsconfig.app.json`'s `include`.
- **RISK-003**: `readOnlyRootFilesystem: true` would break if the binary ever writes temp files. It writes none today. If a future change needs scratch space, add an `emptyDir` at `/tmp`.
- **RISK-004**: The `image.repository` default `ghcr.io/rafaelpissolatto/kubelynx` has no publish pipeline yet, so `helm install` outside the dev loop fails on image pull until CI publishes an image. Image and chart publishing is out of scope for #10 and is tracked in #52 (`plan/infrastructure-release-pipeline-1.md`).
- **ASSUMPTION-001**: The frontend is only ever served at the root path `/`. There is no sub-path/ingress-prefix support; Vite's `base` stays `/`.
- **ASSUMPTION-002**: A single replica is sufficient (ADR 0001), so there are no PodDisruptionBudget or HPA templates.
- **ASSUMPTION-003**: "Refresh interval" in issue #10 means the UI polling cadence. The backend does not poll Prometheus independently today; it queries on each `/api/topology` request. So the Helm value is delivered to the UI via `/api/config` and no backend poller is introduced.

## 8. Related Specifications / Further Reading

- Issue #10: https://github.com/rafaelpissolatto/kubelynx/issues/10
- Parent PRD, issue #1: https://github.com/rafaelpissolatto/kubelynx/issues/1
- Blocker, issue #9 (bearer-token auth): https://github.com/rafaelpissolatto/kubelynx/issues/9
- ADR 0001, `docs/adr/0001-single-image-packaging.md`
- Go `embed` package: https://pkg.go.dev/embed
- Helm chart best practices: https://helm.sh/docs/chart_best_practices/
- Distroless images: https://github.com/GoogleContainerTools/distroless
