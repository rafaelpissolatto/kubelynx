---
goal: Optional bearer-token authentication from the KubeLynx backend to Prometheus, read from a file so Kubernetes Secret rotation works without a restart
version: 1
date_created: 2026-09-27
last_updated: 2026-09-27
owner: rafaelpissolatto
status: 'Planned'
tags: [feature, security, prometheus, backend]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Implements GitHub issue #9 (parent #1). It unblocks #10 (`plan/feature-packaging-helm-1.md`, TASK-016), which in turn blocks #52.

Today `cmd/kubelynx/main.go` builds the Prometheus client with `promapi.NewClient(promapi.Config{Address: *promURL})`, which sends no credentials. That client is shared by `/api/topology`, `/api/namespaces` and every other Prometheus query. This plan adds one flag, `--prometheus-bearer-token-file=<path>`, as agreed in the #9 alignment comment (https://github.com/rafaelpissolatto/kubelynx/issues/9#issuecomment-5858448221). When it's set, every Prometheus request carries `Authorization: Bearer <token>`, with the token read from the file on each request.

The implementation reuses `github.com/prometheus/common/config`, already a direct dependency (`go.mod`, `v0.71.0`). `config.NewFileSecret(path)` re-reads the file and trims whitespace on every `Fetch`. `config.NewAuthorizationCredentialsRoundTripper("Bearer", secret, next)` sets the header unless it's already present, and never forwards it on cross-host redirects. These are the same semantics as Prometheus's own `bearer_token_file`.

## 1. Requirements & Constraints

- **REQ-001**: `--prometheus-url` stays the Prometheus base URL (default `http://localhost:9090`). Startup fails with `slog.Error` and exit 1 if the value is empty, fails `url.Parse`, or has a scheme other than `http`/`https`.
- **REQ-002**: The new flag `--prometheus-bearer-token-file` (string, default `""`) is optional. When it's empty or omitted, requests carry no `Authorization` header, which is identical to today's behavior.
- **REQ-003**: When the flag is set, every request made through the shared `promv1.API` includes `Authorization: Bearer <token>`, where `<token>` is the file content with surrounding whitespace trimmed. This covers every call site in `internal/topology` (`BuildTopology`, `ListNamespaces`).
- **REQ-004**: The token file is re-read on each request, so a rotated Kubernetes Secret (kubelet updates the mounted file in place) takes effect without a pod restart.
- **REQ-005**: At startup, when the flag is set, the file is read once. The process exits 1 with `slog.Error("reading prometheus bearer token file", "path", <path>, "error", <err>)` if the file is unreadable, and with `"prometheus bearer token file is empty"` if the trimmed content is empty.
- **REQ-006**: If the file becomes unreadable after startup, the affected request fails and surfaces through the existing error paths: `TopologyHandler` and `NamespacesHandler` log the error and return `502 failed to query prometheus`. The UI shows its existing "Prometheus unreachable" state (issue #8). The process does not crash.
- **SEC-001**: The token value never appears in logs, error messages, HTTP responses, or the PromQL shown in the flow detail panel. Only the file path may be logged.
- **SEC-002**: The token is accepted only from a file. No `--prometheus-bearer-token=<value>` flag and no env var are added, which keeps the token out of `ps`, the pod spec and `kubectl describe` (see ALT-001).
- **SEC-003**: When a token file is set and the `--prometheus-url` scheme is `http`, log `slog.Warn("sending prometheus bearer token over plain HTTP", "prometheus", <url>)` once at startup. This is a warning only, not an error, because in-cluster plain-HTTP Prometheus behind a network policy is a legitimate setup.
- **SEC-004**: The header is not sent on cross-host redirects. `NewAuthorizationCredentialsRoundTripper` already provides this, and TEST-006 locks it in.
- **CON-001**: mTLS and client certificates are out of scope (issue #9 AC). No TLS flags are added.
- **CON-002**: No new module dependencies. Only `github.com/prometheus/common/config` (already required) and the standard library are used.
- **CON-003**: The flag name must stay exactly `--prometheus-bearer-token-file`, because #10's chart (TASK-016) and `dev/scripts/check-chart.sh` in #52 (TASK-003) depend on it.
- **GUD-001**: Follow the existing flag style in `cmd/kubelynx/main.go` (`flag.String` with a descriptive help string), the existing `slog` key names (`"error"`, `"prometheus"`), and the `_test` external test package convention (`package promclient_test`).
- **PAT-001**: Client construction moves out of `main.go` into one small, testable seam, `internal/promclient.New`. This mirrors how `topology.LoadProtocolClasses` and `topology.LoadPortCardinality` take flag values and return a validated value or an error that `main` turns into exit 1.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: The `internal/promclient` package builds an authenticated or anonymous `promv1.API`. The phase is complete when `go test ./internal/promclient/...` passes TEST-001 through TEST-007.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `internal/promclient/promclient.go` (`package promclient`) with a package doc comment stating that it owns the Prometheus client and its optional bearer auth. Export `func New(baseURL, bearerTokenFile string) (promv1.API, error)`. | | |
| TASK-002 | In `New`, validate `baseURL`. Return `fmt.Errorf("prometheus URL is required")` when it's empty. Parse it with `url.Parse`, and return `fmt.Errorf("invalid prometheus URL %q: %w", baseURL, err)` on error or `fmt.Errorf("prometheus URL %q must use http or https", baseURL)` when `u.Scheme` is not `http`/`https` (REQ-001). | | |
| TASK-003 | In `New`, when `bearerTokenFile == ""`, return `promv1.NewAPI(client)` with `client, err := promapi.NewClient(promapi.Config{Address: baseURL})`. This is the current behavior (REQ-002). | | |
| TASK-004 | In `New`, when `bearerTokenFile != ""`, do the following. Set `secret := config.NewFileSecret(bearerTokenFile)`. Call `token, err := secret.Fetch(context.Background())` and, on error, return `fmt.Errorf("reading prometheus bearer token file %s: %w", bearerTokenFile, err)`. If `token == ""`, return `fmt.Errorf("prometheus bearer token file %s is empty", bearerTokenFile)` (REQ-005). Otherwise build `promapi.Config{Address: baseURL, RoundTripper: config.NewAuthorizationCredentialsRoundTripper("Bearer", secret, promapi.DefaultRoundTripper)}` (REQ-003, REQ-004). Never include `token` in any error or log (SEC-001). | | |
| TASK-005 | In `New`, after the token is validated, if the parsed scheme is `http`, emit `slog.Warn("sending prometheus bearer token over plain HTTP", "prometheus", baseURL)` (SEC-003). | | |
| TASK-006 | Create `internal/promclient/promclient_test.go` (`package promclient_test`) implementing TEST-001 through TEST-007. Each test uses an `httptest.NewServer` that records `r.Header.Get("Authorization")` and replies with a minimal valid label-values body, `{"status":"success","data":["a"]}`. The request is driven through `api.LabelValues(ctx, "__name__", nil, time.Time{}, time.Time{})`. This signature is verified against client_golang v1.24.1: `LabelValues(ctx, label string, matches []string, startTime, endTime time.Time, opts ...Option)`. Token files are written with `os.WriteFile(filepath.Join(t.TempDir(), "token"), ...)`. | | |

### Implementation Phase 2

- GOAL-002: `cmd/kubelynx` uses the new seam and exposes the flag. The phase is complete when `go build ./... && go vet ./... && go test ./...` pass and the TEST-008 manual check shows the header on the wire.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | In `cmd/kubelynx/main.go`, add the flag `promBearerTokenFile = flag.String("prometheus-bearer-token-file", "", "path to a file containing a bearer token sent as \"Authorization: Bearer <token>\" on every Prometheus request; re-read on each request so rotated Kubernetes Secrets apply without a restart; omit for an unauthenticated Prometheus")`. | | |
| TASK-008 | In `cmd/kubelynx/main.go`, replace the `promapi.NewClient(...)` / `promv1.NewAPI(client)` block with `prom, err := promclient.New(*promURL, *promBearerTokenFile)`. On error, call `slog.Error("creating prometheus client", "error", err)` and `os.Exit(1)`. Remove the now-unused `promapi` / `promv1` imports from `main.go`. | | |
| TASK-009 | In `cmd/kubelynx/main.go`, add `"prometheus_auth", auth` to the existing `slog.Info("kubelynx listening", ...)` line, where `auth` is `"bearer-file"` when `*promBearerTokenFile != ""` and `"none"` otherwise. Do not log the path at info level; the path is only logged in startup errors (SEC-001). | | |
| TASK-010 | In `README.md` under `### Backend flags`, add a table row for `-prometheus-bearer-token-file` (default: empty) with the description "File containing a bearer token for Prometheus/Thanos/Mimir; re-read per request (Secret rotation safe). Omit for no auth." Below the table, add a two-line local example: `echo -n "$TOKEN" > /tmp/prom-token && go run ./cmd/kubelynx -prometheus-url https://prom.example -prometheus-bearer-token-file /tmp/prom-token`. | | |

## 3. Alternatives

- **ALT-001**: A literal token flag (`--prometheus-bearer-token=<value>`) or an env var (`KUBELYNX_PROMETHEUS_BEARER_TOKEN`). Rejected (SEC-002). A flag value is visible in `ps` and in the pod spec. An env var via `secretKeyRef` can't rotate without a restart, and it gets exposed through `/proc/<pid>/environ` and crash dumps. A file read is also what the #10 chart mounts.
- **ALT-002**: A hand-written `http.RoundTripper` that sets the header. Rejected: `prometheus/common/config` already provides the round tripper plus a file-backed secret with trim, per-request re-read and cross-host-redirect protection, and it's already a dependency (CON-002).
- **ALT-003**: Building the whole client from `config.HTTPClientConfig` (`NewRoundTripperFromConfig`), which also gives TLS, basic auth and OAuth2 for free. Rejected for now: it widens the surface beyond issue #9 (CON-001, no mTLS) and would tempt exposing a YAML config file. It stays a natural upgrade path if more auth modes are requested later.
- **ALT-004**: Reading the token once at startup and caching it. Rejected: rotation would need a restart (REQ-004). A per-request `os.ReadFile` of a few-byte file is negligible next to a PromQL query, and Prometheus itself works the same way.
- **ALT-005**: A distinct UI error state for Prometheus auth failures (401/403). Deferred. client_golang reports those as `ErrBadResponse` with the message `bad response code 401`, which is already logged by the handlers, and the UI shows "Prometheus unreachable". A dedicated "Prometheus rejected credentials" state is a follow-up UX issue if operators find the current message confusing.

## 4. Dependencies

- **DEP-001**: `github.com/prometheus/common/config` v0.71.0 (already in `go.mod`): `NewFileSecret`, `NewAuthorizationCredentialsRoundTripper`.
- **DEP-002**: `github.com/prometheus/client_golang/api` v1.24.1 (already in `go.mod`): `promapi.Config.RoundTripper`, `promapi.DefaultRoundTripper`.
- **DEP-003**: Issue #3 (topology walking skeleton), which is closed and satisfied. The parent is #1.
- **DEP-004**: Downstream, #10 (TASK-016) mounts the Secret and passes `--prometheus-bearer-token-file=/var/run/secrets/kubelynx/prometheus/token`, and #52's `check-chart.sh` asserts that the flag is rendered. Both depend on CON-003.

## 5. Files

- **FILE-001**: `internal/promclient/promclient.go` (new): `New(baseURL, bearerTokenFile string) (promv1.API, error)`.
- **FILE-002**: `internal/promclient/promclient_test.go` (new): TEST-001 through TEST-007.
- **FILE-003**: `cmd/kubelynx/main.go` (modified): new flag, `promclient.New`, and `prometheus_auth` in the startup log.
- **FILE-004**: `README.md` (modified): Backend flags table row and local example.

## 6. Testing

- **TEST-001**: With no token file (`New(srv.URL, "")`), the recorded `Authorization` header is `""`.
- **TEST-002**: With a token file containing `"  s3cret-token\n"`, the recorded header is exactly `"Bearer s3cret-token"`.
- **TEST-003** (rotation): The token file starts as `"old"`. After one request, overwrite it with `"new"` and make another request. The headers are `"Bearer old"` and then `"Bearer new"`.
- **TEST-004** (startup errors): `New(srv.URL, "/nonexistent/token")` returns an error mentioning the path. `New(srv.URL, <file containing "  \n">)` returns an error containing `is empty`. Neither error string contains any token content.
- **TEST-005** (URL validation): `New("", "")`, `New("://bad", "")` and `New("ftp://prom:9090", "")` each return an error, while `New("https://prom.example", "")` returns no error.
- **TEST-006** (redirect safety): Server A responds with `302 Location: <server B URL>/api/v1/label/__name__/values`, where server B is a second `httptest.Server`. Server B records an empty `Authorization` header, confirming the credential isn't forwarded across hosts (SEC-004).
- **TEST-007** (file removed after startup): Build the client, delete the token file, and make a request. The call returns a non-nil error and the fake server receives no request (REQ-006).
- **TEST-008** (manual, wire check): Run `nc -l 9999` in one shell. In another, run `echo -n abc > /tmp/t && go run ./cmd/kubelynx -prometheus-url http://localhost:9999 -prometheus-bearer-token-file /tmp/t` followed by `curl localhost:8080/api/namespaces`. The `nc` output shows `Authorization: Bearer abc`, and the kubelynx log shows the SEC-003 plain-HTTP warning and `prometheus_auth=bearer-file`.
- **TEST-009** (regression): The existing `internal/api` and `internal/topology` tests pass unchanged, and `go run ./cmd/kubelynx -prometheus-url http://localhost:9090` against the dev cluster (`make port-prometheus`) still renders the topology with no token configured.

## 7. Risks & Assumptions

- **RISK-001**: Kubelet updates a mounted Secret with an atomic symlink swap (`..data`). `os.ReadFile` on the mounted path follows the symlink, so every read sees either the old or the new token, never a partial one. Using `subPath` mounts would break rotation, because subPath mounts are not updated. Mitigation: #10's TASK-016 mounts the whole volume directory, not a `subPath`, and that plan should keep it that way.
- **RISK-002**: The per-request file read adds one `open`/`read` syscall pair per Prometheus query. At a 15s refresh with 2 queries per poll this is negligible. The risk only matters if a future change fans out many queries per poll, and even then `FileSecret` could be swapped for a cached reader without changing `New`'s signature.
- **RISK-003**: Operators may point KubeLynx at an `http://` Prometheus across an untrusted network while sending a token. Mitigation: the SEC-003 startup warning. Hard enforcement is intentionally avoided.
- **ASSUMPTION-001**: Thanos Query, Mimir and Cortex front-ends accept `Authorization: Bearer` on the Prometheus HTTP API paths KubeLynx uses (`/api/v1/query`, `/api/v1/label/.../values`). Tenant headers such as Mimir's `X-Scope-OrgID` are out of scope for #9.
- **ASSUMPTION-002**: A single token is sufficient; there are no per-namespace or per-user credentials.

## 8. Related Specifications / Further Reading

- Issue #9: https://github.com/rafaelpissolatto/kubelynx/issues/9
- Flag alignment comment on #9: https://github.com/rafaelpissolatto/kubelynx/issues/9#issuecomment-5858448221
- Parent PRD, issue #1: https://github.com/rafaelpissolatto/kubelynx/issues/1
- Downstream plans: `plan/feature-packaging-helm-1.md` (#10) and `plan/infrastructure-release-pipeline-1.md` (#52)
- `prometheus/common/config` package docs: https://pkg.go.dev/github.com/prometheus/common/config
- Kubernetes: mounted Secrets are updated automatically: https://kubernetes.io/docs/concepts/configuration/secret/#mounted-secrets-are-updated-automatically
