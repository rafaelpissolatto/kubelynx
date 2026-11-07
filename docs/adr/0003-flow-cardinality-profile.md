# Bound flow cardinality at the Beyla collection profile, not inside KubeLynx

KubeLynx's flow-metric cardinality problem (issue #48) sits at the Prometheus
storage layer, not inside KubeLynx: `beyla_network_flow_bytes_total`'s
`dst.port` carries the client's ephemeral port on reply traffic, so every
connection mints a fresh series — ~18,700 new series/hour on a 7-workload dev
cluster, before any mitigation. By the time a sample reaches `BuildTopology`,
Prometheus has already paid that storage cost, so a toggle inside KubeLynx
can't fix it. The fix has to live where Beyla produces the metric, as a
deploy-time collection profile — KubeLynx then adapts to whatever labels and
metrics the operator's Prometheus actually holds.

This is a distinct axis from KubeLynx's existing `PortCardinality`
(`internal/topology/cardinality.go`, `--tcp-port-allowlist-file`): that
mechanism bounds how many distinct ports a query *response* itemizes
(aggregating the rest into a `"multiple"` edge), after Prometheus has already
stored every series. It doesn't touch storage cardinality and isn't changed
by this decision, beyond closing a wiring gap noted below.

**Decision**: the dst_port glob filter already in `dev/beyla/10-configmap.yaml`
(#48's option 5) is the default collection profile for every cluster size,
small or large — the dev cluster's own 7-workload numbers show this isn't a
large-cluster-only problem. We re-checked it against a comparable lab
cluster (OpenObserve playground, Beyla/Alloy config intentionally copied
from KubeLynx's) running more workloads plus an Istio ambient mesh: 142
active `beyla_network_flow_bytes_total` series, 25 distinct `dst_port`
values, and `direction="response"` down to 4 of 142 series — consistent with
#48's post-mitigation numbers, confirming the filter still holds at larger,
more varied scale.

Answering #48's four open questions:

- **Default profile, small vs. large clusters**: the same profile for both —
  the port filter, always on. There's no cluster small enough to skip it
  safely.
- **Request-direction-only byte volume**: accepted as the default trade-off.
  It's adequate for KubeLynx's purpose (traffic topology visualization, not
  billing-grade byte accounting). Documented as a known limitation.
- **Where profiles live**: as operator-facing documentation for users' own
  Beyla deployment, not a KubeLynx Helm value — KubeLynx doesn't deploy or
  manage Beyla (CON-001: pure consumer, no new agents/RBAC). KubeLynx's own
  `dev/` fixtures keep demonstrating the recommended profile as the worked
  example. Namespace scoping (option 4: Beyla's `k8s_src_namespace`/
  `k8s_dst_namespace` filters) is recommended alongside it for large
  clusters, since it's orthogonal and combines for free with any option.
  Separately, KubeLynx's own `--tcp-port-allowlist-file` is currently only
  reachable via `extraArgs`, which can't mount a file
  (`charts/kubelynx/values.yaml`'s own comment notes this) — a follow-up
  closes that gap so operators can tune *response* cardinality from Helm
  values too, independent of this decision.
- **Cardinality budget warning**: yes — a periodic `count(beyla_network_flow_bytes_total)`
  check with a `slog.Warn` above a configurable budget is a plain read-only
  Prometheus query, so it fits the pure-consumer posture. Specified as a
  follow-up issue, not required to close #48.

Rejected alternatives:

1. **Ports as a flag (option 1), default off.** Rejected as the default:
   dropping `dst.port` from `attributes.select` loses port badges and the
   HTTP/gRPC protocol filter (which keys off `dst_port`) for every cluster,
   not just ones at risk of explosion. The targeted glob gets the same
   cardinality win while keeping ports for well-known traffic.
2. **Service-to-service across availability zones (option 2).** Out of
   scope for a cardinality fix — it's a different visualization axis (a
   cross-AZ cost signal), not a response to #48, and needs cloud zone labels
   unavailable on kind. A candidate future feature, not part of this
   decision.
3. **Collector-side aggregation (option 3) as the default.** Rejected as
   default: it adds a whole OpenTelemetry Collector to every deployment for
   full fidelity most operators won't need. Kept as a documented, optional
   advanced profile for operators who need response-direction bytes too —
   entirely on the operator's side of CON-001's line, never a KubeLynx
   component.

**Istio note**: once the Istio telemetry source (ADR 0002) ships, its
`istio_requests_total`/`istio_tcp_*` metrics are comparatively low-cardinality
by default — no raw ephemeral-port explosion like Beyla's network flow
metric — so none of this applies to it. Worth keeping explicit so the two
sources' cardinality stories don't get decided inconsistently later.
