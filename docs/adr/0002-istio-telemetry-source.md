# A selectable telemetry source (Beyla or Istio), same Graph shape, Workload-only identity

KubeLynx gets a second data source: Istio's mesh telemetry (`istio_requests_total` for HTTP/gRPC, `istio_tcp_sent_bytes_total`/`istio_tcp_received_bytes_total` for raw TCP), selectable from the UI like Kiali's metric-source picker, alongside the existing Beyla source. We considered three designs and picked the first.

1. **One `Graph`/`Workload`/`Flow` shape, a `source` selector, source-specific query builders.** `BuildTopology` is generalized to take a `source` parameter (`beyla` | `istio`); each source has its own PromQL and label mapping but produces the identical `Graph` JSON shape. `/api/topology` gains `?source=`, and a new `/api/sources` (mirroring `/api/namespaces` and `/api/protocols`) reports which sources are actually observed in Prometheus, so the UI only offers a toggle when there's a real second source to switch to. **Chosen** — keeps the frontend source-agnostic (no `if (source === 'istio')` branching in rendering code) and reuses every existing seam (swimlanes, filters, flow table, PromQL-behind-the-edge panel).
2. **Separate endpoint per source (`/api/topology/istio`).** Rejected — doubles the API surface for no benefit, and would need its own namespace/protocol-filter wiring duplicated.
3. **Merge both sources into one combined graph.** Rejected — Beyla and Istio observe overlapping but differently-shaped traffic (mesh-only vs. all network traffic); silently merging them risks double-counting or misleading combined edges. A side-by-side comparison view is a future enhancement, not v1.

Two consequences of option 1:

- **`Flow` generalizes its rate field.** Beyla's edges are always a byte rate. Istio's HTTP/gRPC edges (`istio_requests_total`) are a *request* rate, not bytes — there is no standard byte-rate metric for HTTP traffic in Istio's default telemetry. `Flow.BytesPerSecond` becomes `Flow.Rate` (`float64`) plus `Flow.Metric` (`"bytes"` | `"requests"`), so the frontend's edge-thickness scaling and labels key off `Metric` instead of assuming bytes. Istio's TCP edges keep `Metric: "bytes"` (`istio_tcp_sent_bytes_total` + `istio_tcp_received_bytes_total`, matching Beyla's shape).
- **Node identity stays Workload-only for both sources, even though Istio also reports real Service identity** (`destination_service_name`). Per `CONTEXT.md`, a graph node is always a Workload. The Istio source builds nodes from `source_workload`/`source_workload_namespace` → `destination_workload`/`destination_workload_namespace`, discarding `destination_service_name` for node identity — the same Workload shape Beyla produces, from a different label set. Rendering Services as a distinct node kind (which Istio, unlike Beyla, could actually support) is deferred: it's a bigger change to `CONTEXT.md`'s vocabulary and the graph model than "add a second source," and isn't needed to ship the source switch.

Exact label names on `istio_requests_total`/`istio_tcp_*` (e.g. how a destination port surfaces, if at all, in default Istio standard metrics) are confirmed against a real `istioctl install --set profile=demo` mesh during implementation, not assumed here.

## Amendment: per-Flow mTLS status (issue #90)

Istio's metrics carry `connection_security_policy`, which KubeLynx used to drop when summing samples into a `Flow`. Issue #90 keeps it through aggregation and adds two **optional** fields to `Flow`. This is an additive, backward-compatible change to the shared `/api/topology` contract: existing fields are untouched, and a client that ignores the new fields sees the same graph as before.

```go
// Flow (internal/topology/graph.go), new fields only
Security  string  `json:"security,omitempty"`  // "mutual_tls" | "none" | "mixed" | "unknown"; omitted for Beyla
MTLSRatio float64 `json:"mtlsRatio,omitempty"` // share of Rate that was mutual_tls, (0,1); only set when Security == "mixed"
```

`BuildTopology` sums each edge's rate per policy (per `edgeKey`, the same grouping as `Rate`) and derives one value per edge:

| Per-policy rate on the edge | `security` | `mtlsRatio` |
| --- | --- | --- |
| only `mutual_tls` > 0 | `mutual_tls` | omitted |
| only `none` > 0 | `none` | omitted |
| `mutual_tls` > 0 and `none` > 0 | `mixed` | `mutual_tls / (mutual_tls + none)` |
| neither (label missing, `unknown`, or zero rate) | `unknown` | omitted |

Samples labelled `unknown` (or missing the label) don't count toward either side, so an edge with `mutual_tls` traffic plus some unlabelled traffic is still `mutual_tls`. The `querySource` seam returns the sample's policy from `mapSample`; Beyla returns `""` and its Flows never set `security`, so the frontend shows nothing for Beyla rather than a misleading "unknown".

Observed on the ambient lab mesh (ztunnel + one waypoint): the waypoint's `istio_requests_total` and ztunnel's in-mesh `istio_tcp_*` hops report `mutual_tls`, and every hop into or out of the mesh reports `unknown`. `none` never appeared, because in ambient mode a plaintext hop to a non-mesh workload is reported as `unknown`. On such a mesh the UI shows those edges as unknown, not plaintext; `none` still renders as plaintext wherever Istio reports it.

Example (`source=istio`):

```json
{"source":"mesh-frontend/frontend","target":"mesh-backend/backend","protocol":"tcp","rate":5120,"metric":"bytes","query":"…","security":"mutual_tls"}
{"source":"mesh-backend/backend","target":"mesh-backend/db","protocol":"http","rate":12.5,"metric":"requests","query":"…","security":"mixed","mtlsRatio":0.8}
```

Example (`source=beyla`), unchanged: `{"source":"demo/frontend","target":"demo/api","protocol":"TCP","port":"8080","rate":1200,"metric":"bytes","query":"…"}`

