---
goal: Generalize BuildTopology/the Graph shape to support a selectable telemetry source (Beyla or Istio), and add the Istio query builder
version: 1
date_created: 2026-11-07
last_updated: 2026-11-07
owner: rafaelpissolatto
status: 'Completed'
tags: [feature, istio, backend, telemetry]
persona: Senior SRE — Telemetry & Backend
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implements GitHub issue #60 (parent #59). Architecture decision: ADR 0002 (`docs/adr/0002-istio-telemetry-source.md`) — read before starting; this plan doesn't re-derive those decisions, only breaks them into tasks.

Today `internal/topology.BuildTopology` is hard-wired to one metric (`beyla_network_flow_bytes_total`) and one label set. This plan extracts that into a per-source seam, adds an Istio implementation, and widens `Flow` to carry a rate unit (`bytes` or `requests`) instead of assuming bytes everywhere. The result is additive: `source` defaults to `beyla`, so every existing caller and test keeps working unchanged.

## 1. Requirements & Constraints

- **REQ-001**: `Flow.BytesPerSecond float64` becomes `Flow.Rate float64` + `Flow.Metric string` (`"bytes"` | `"requests"`). Every existing Beyla call site sets `Metric: "bytes"` — behavior is unchanged for Beyla, only the field name/shape moves.
- **REQ-002**: `BuildTopology` takes a new `source string` parameter (`"beyla"` | `"istio"`). An empty string is treated as `"beyla"` so no internal caller breaks silently if one is missed during the refactor — but every caller must be updated to pass it explicitly; the empty-string fallback is a safety net, not the intended call convention.
- **REQ-003**: Beyla's existing query-building and label-mapping logic (today inline in `topology.go`: `metricName`, `buildTopologyQuery`, `protocolMatcher`, the per-sample label reads, `edgeQuery`) is extracted behind a seam shaped so a second source can plug in without touching `BuildTopology`'s control flow. Suggested shape: a small internal interface or struct-of-functions with `buildQuery(namespaces, protocol) string` and `mapSample(metric model.Metric) (src, dst Workload, protocol, port, metricKind string, ok bool)` — exact shape is the implementer's call, but it must not require `BuildTopology` itself to branch on source beyond selecting which implementation to use.
- **REQ-004**: The Istio source builds HTTP/gRPC flows from `istio_requests_total` (`Metric: "requests"`) and TCP flows from `rate(istio_tcp_sent_bytes_total[...]) + rate(istio_tcp_received_bytes_total[...])` (`Metric: "bytes"`), using `source_workload`/`source_workload_namespace`/`destination_workload`/`destination_workload_namespace` for node identity (discarding `destination_service_name`, per ADR 0002).
- **REQ-005**: `/api/topology` accepts `?source=`, validated against a new `topology.ValidSources`/`IsValidSource` (mirroring `ValidProtocols`/`IsValidProtocol`), defaulting to `beyla`, returning `400` with the existing error-message style on an invalid value.
- **REQ-006**: New `GET /api/sources` (`internal/api/sources.go`) reports which source(s) currently have data in Prometheus — not a static list. Response shape mirrors `protocolsResponse`/`namespacesResponse` (e.g. `{"sources": [...], "default": "beyla"}`); field names are the implementer's call but must follow that existing naming convention.
- **REQ-007**: Detecting whether a source "has data" is a cheap Prometheus query per source (e.g. `count(beyla_network_flow_bytes_total)` / `count(istio_requests_total) or count(istio_tcp_sent_bytes_total)`), not a hardcoded assumption.
- **VERIFY-001**: Exact Istio label names/presence (especially whether any destination-port signal exists on these metrics) are confirmed against a real mesh before the Istio query/mapping is finalized — do not ship label names asserted only from this plan or issue #60's description.
- **ENV-001**: There's already a running lab cluster for this: `/home/rafael/local/k8s/openobserve` (kind cluster, Istio **ambient** mode — ztunnel + CNI + istiod, no sidecars — plus Beyla via Alloy, all feeding OpenObserve). Use it instead of standing up a fresh cluster. Key facts from its `README.md`:
  - Metrics live in **OpenObserve**, which serves a Prometheus-compatible query API at `/api/default/prometheus` (confirmed in that README as the same API Radar/other Prometheus clients use) — so `internal/promclient` can point at it via the existing `--prometheus-url` flag once auth is sorted (OpenObserve's query API takes HTTP Basic auth from the `openobserve-credentials` Secret, `root@example.com`/`Complexpass#123` by default — KubeLynx today only supports a bearer-token file; adding Basic-auth support to `internal/promclient` may be a small prerequisite for live end-to-end testing against this lab, not required for issue #60's unit-test-level acceptance criteria).
  - Ambient mode means **L7 metrics (`istio_requests_total`, `istio_request_duration_milliseconds`) only exist where a waypoint proxy is deployed** — in this lab, only `mesh-backend` has one (`istio.io/use-waypoint=waypoint`); `mesh-frontend` has none, since its traffic arrives from outside the mesh via the NGINX gateway. `ztunnel` gives the L4 view (`istio_tcp_*`) mesh-wide regardless of waypoints. The Istio source's mapping and its tests must account for this: namespaces/workloads with no waypoint produce only `istio_tcp_*`-sourced `Flow`s, not `istio_requests_total` ones.
  - Real workload/namespace names to query against: namespaces `mesh-frontend`/`mesh-backend`, services `frontend`/`backend`.
  - Alloy already scrapes Istio's `prometheus.io/*`-annotated pods as jobs `istio/istiod`, `istio/ztunnel`, `istio/istio-cni-node`, `istio/istio-waypoint` — the metrics are already flowing; no new collection config should be needed to read labels, only to query them.
  - **Workflow preference**: if anything about the lab's config needs to change to support this work (e.g. enabling an attribute, adjusting a scrape job), make that change in `/home/rafael/local/k8s/openobserve` first, verify it there, and only then port the equivalent setting into KubeLynx's own `dev/` fixtures — this is the same direction the existing Beyla config already took (the lab's `alloy/config.alloy` network-flow attribute list is explicitly "copied from KubeLynx's Beyla config"; new Istio-related fixtures should flow lab → `dev/`, keeping the two in sync).
- **CON-001**: No change to Beyla's observed behavior: same PromQL, same `Graph` output for `source=beyla` (modulo the `Flow` field rename), same tests passing.
- **GUD-001**: Testing convention stays seam-level: assert on the `Graph`/response JSON produced from a fake Prometheus (`httptest.Server`) with canned responses, never on PromQL string construction (see `internal/topology/topology_test.go`).

## 2. Implementation Phases

### Phase 1 — Widen `Flow`, extract the Beyla seam (no behavior change)

- GOAL-001: `Flow.Rate`/`Flow.Metric` replace `BytesPerSecond` everywhere; Beyla's query/mapping logic sits behind the new seam with identical output. Complete when `go test ./...` passes unchanged in substance (only field names differ in assertions).

| Task | Description |
|------|-------------|
| TASK-001 | `internal/topology/graph.go`: replace `Flow.BytesPerSecond` with `Flow.Rate float64` + `Flow.Metric string`, with doc comments naming the two valid `Metric` values. |
| TASK-002 | Update every `Flow{...}` literal and assertion in `internal/topology/topology_test.go` and `internal/api/topology_test.go` to the new fields (`Metric: "bytes"` for all current Beyla cases). |
| TASK-003 | Extract Beyla's query construction and per-sample mapping out of `BuildTopology` into the seam described in REQ-003, with zero behavior change — confirm by running the full existing test suite before adding anything Istio-specific. |
| TASK-004 | Add `source string` to `BuildTopology`'s signature; wire it to select the Beyla seam for `""`/`"beyla"`. Update `internal/api/topology.go`'s call site. |

### Phase 2 — Istio source

- GOAL-002: `source=istio` produces a correct `Graph` against a real mesh. Complete when `go test ./...` passes and a manual query against the dev cluster's Istio install returns a non-empty, correctly-labeled graph.

| Task | Description |
|------|-------------|
| TASK-005 | Query the existing lab cluster (`/home/rafael/local/k8s/openobserve`, ENV-001) directly — e.g. `curl -u root@example.com:Complexpass#123 'https://openobserve.localhost/api/default/prometheus/api/v1/series?match[]=istio_requests_total'` (and the same for `istio_tcp_sent_bytes_total`/`istio_tcp_received_bytes_total`) against its real `mesh-frontend`/`mesh-backend` traffic — to validate actual label names (VERIFY-001) before writing the mapping. Generate traffic first if needed (the lab's `loadgen` hits `https://mesh.localhost/api/users` continuously per its README, so there should already be live series). |
| TASK-006 | Implement the Istio query builder + sample mapper per REQ-004, using whatever labels TASK-005 confirms. Note any divergence from this plan's assumed label names in the PR/commit description. |
| TASK-007 | `internal/topology/topology_test.go`: add Istio-shaped test cases (canned `istio_requests_total`/`istio_tcp_*` responses via `httptest.Server`) covering HTTP, gRPC, and TCP flows, plus a partial-attribute/degraded case mirroring the existing Beyla graceful-degradation tests. |

### Phase 3 — API surface

- GOAL-003: `?source=` and `/api/sources` are live and tested. Complete when `go build ./... && go vet ./... && go test ./...` pass.

| Task | Description |
|------|-------------|
| TASK-008 | Add `topology.ValidSources`/`IsValidSource` (mirror `ValidProtocols`/`IsValidProtocol`). |
| TASK-009 | `internal/api/topology.go`: parse/validate `?source=`, default `beyla`, `400` on invalid (REQ-005). Add/extend `internal/api/topology_test.go` for the new param. |
| TASK-010 | Add `internal/api/sources.go` (`SourcesHandler`) and wire it into `cmd/kubelynx/main.go`'s mux, per REQ-006/REQ-007. Add `internal/api/sources_test.go` against a fake Prometheus covering: both sources present, only one present, neither present. |

## 3. Acceptance Criteria (from issue #60)

- [x] `go build ./... && go vet ./... && go test ./...` passes.
- [x] Beyla behavior unchanged.
- [x] `source=istio` against the dev cluster's real mesh produces a non-empty `Graph` with correct `Metric` per flow kind. Verified by running the generated PromQL directly against the lab cluster's OpenObserve Prometheus-compatible API (promclient doesn't yet support Basic auth, so the full binary wasn't run end-to-end against it — see implementer's note below).
- [x] `/api/sources` reflects only sources with actual Prometheus data. Verified the underlying `count()` presence queries directly against the lab cluster.

### Implementer's notes (Senior SRE — Telemetry & Backend)

- Label names/shape confirmed against the lab cluster (`/home/rafael/local/k8s/openobserve`), matching this plan's assumptions exactly: `istio_requests_total` carries `source_workload`/`source_workload_namespace`/`destination_workload`/`destination_workload_namespace`/`request_protocol` (values seen: `http`; no `grpc` traffic was live, so gRPC is covered by a canned-response unit test only, not live-verified); `istio_tcp_sent_bytes_total`/`istio_tcp_received_bytes_total` carry the same identity labels plus `request_protocol="tcp"`. No destination-port label exists on any of the three metrics — confirmed, not assumed (VERIFY-001). `destination_service_name` is present but unused for node identity, per ADR 0002.
- One real-world nuance not previously called out: ztunnel reports the literal string `"unknown"` (not an empty label) for an endpoint it can't resolve — observed on live TCP series for traffic leaving the mesh. `istioSource.mapSample` treats `"unknown"` the same as a missing attribute (no edge drawn), not as a literal Workload.
- `internal/promclient` still only supports a bearer-token file, not HTTP Basic auth, so the `kubelynx` binary wasn't run end-to-end against the lab's OpenObserve endpoint (which requires Basic auth). Per this plan's ENV-001, that's explicitly not required for issue #60's acceptance criteria. Instead, the exact PromQL `BuildTopology` generates for `source=istio` (all four namespace/protocol combinations) was extracted via a temporary test and run directly against OpenObserve's Prometheus-compatible API with `curl -u`, confirming non-empty, correctly-shaped results. The `/api/sources` presence-detection `count()` queries were verified the same way. Adding Basic-auth support to `internal/promclient` remains open as a small follow-up for true end-to-end manual testing.
- Everything else in REQ-001 through REQ-007 and TASK-001 through TASK-010 was implemented as specified; no deviation needed raising to the Lead persona.
