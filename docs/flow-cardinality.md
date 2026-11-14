# Beyla flow-cardinality profile

KubeLynx doesn't deploy or configure Beyla. You run your own Beyla (standalone, or through Grafana Alloy), and KubeLynx reads whatever `beyla_network_flow_bytes_total` series your Prometheus holds. This page is the collection profile we recommend for that Beyla. The decision behind it is [ADR 0003](adr/0003-flow-cardinality-profile.md) (issue #48). The dev cluster's [`dev/beyla/10-configmap.yaml`](../dev/beyla/10-configmap.yaml) is the worked example, tested against `grafana/beyla:3.28.0`.

## Why it matters

KubeLynx needs `dst.port` on `beyla_network_flow_bytes_total` for port badges and the HTTP/gRPC protocol filter. On reply traffic, though, `dst.port` is the client's ephemeral port, so every new connection creates a new series. Without a filter, the series count grows with connection count, not with the number of workloads.

Issue #48 measured this on the 7-workload dev cluster: about 99% of `beyla_network_flow_bytes_total` series were reply-direction series keyed by an ephemeral port, adding about 18,700 new series per hour. Prometheus stores those series before KubeLynx ever queries them, so nothing inside KubeLynx can undo the cost. It has to be bounded where Beyla produces the metric. This applies to small clusters too, so the profile below is recommended for every cluster.

KubeLynx's `-tcp-port-allowlist-file` flag works on a different axis. It limits how many ports a single `/api/topology` response itemizes (the rest fold into a `multiple` edge). It doesn't reduce what Prometheus stores.

## Recommended default profile

Keep the attributes KubeLynx needs, and drop every flow whose destination port is in Linux's ephemeral range, except for listed server ports. This is the dev cluster's `beyla-config.yml` with comments and the cosmetic `cluster_name` removed:

```yaml
attributes:
  kubernetes:
    enable: true
  select:
    beyla_network_flow_bytes:
      include:
        - k8s.src.owner.name
        - k8s.src.namespace
        - k8s.src.owner.type
        - k8s.dst.owner.name
        - k8s.dst.namespace
        - k8s.dst.owner.type
        - transport
        - dst.port
        - direction

filter:
  network:
    dst_port:
      match: "{?,??,???,????,[12]????,3[01]???,32[0-6]??,327[0-5]?,3276[0-7],50051}"

network:
  enable: true

prometheus_export:
  port: 9090
  path: /metrics
  features:
    - network
```

The `match` value is a [gobwas/glob](https://github.com/gobwas/glob) pattern. Beyla can't combine a numeric bound such as `less_than: 32768` with a list of extra ports on one attribute, so the bound is spelled out as a glob. Read the alternatives left to right:

| Alternative | Ports kept |
| --- | --- |
| `?`, `??`, `???`, `????` | 0–9999 |
| `[12]????` | 10000–29999 |
| `3[01]???` | 30000–31999 (includes the NodePort range start) |
| `32[0-6]??`, `327[0-5]?`, `3276[0-7]` | 32000–32767 |
| `50051` | gRPC's conventional port, above the bound |

Flows that don't match are **dropped**, not aggregated.

If you run Beyla through Grafana Alloy's `beyla.ebpf` component, the equivalent block goes inside `beyla.ebpf` (the `attributes { select { ... } }` block carries the same `include` list):

```alloy
filters {
  network {
    attr  = "dst.port"
    match = "{?,??,???,????,[12]????,3[01]???,32[0-6]??,327[0-5]?,3276[0-7],50051}"
  }
}
```

The KubeLynx repo doesn't ship this Alloy snippet. It comes from a reference lab cluster that runs Alloy, Beyla and Istio ambient (described below).

### What to expect

With the profile applied, the series count should be roughly proportional to the number of workload pairs times the server ports they talk on, and stable over time. You can check it with:

```promql
count(beyla_network_flow_bytes_total)
count(count by (dst_port) (beyla_network_flow_bytes_total))
count by (direction) (beyla_network_flow_bytes_total)
```

For reference, the lab cluster that ADR 0003 used to re-check the profile (more workloads than the dev cluster, plus an Istio ambient mesh) holds 133 series across 24 distinct `dst_port` values, with only 2 series having `direction="response"`. If your count keeps climbing while the set of workloads stays the same, the filter isn't being applied, or ephemeral ports are leaking through (next section).

KubeLynx runs the first of these queries itself at startup and every 5 minutes, and logs a `flow series over budget` warning when the count exceeds `-flow-series-budget` (Helm value `flowSeriesBudget`, default 1000; `0` turns it off).

## The ephemeral-range assumption

The pattern assumes clients pick source ports from Linux's default `net.ipv4.ip_local_port_range`, `32768 60999`. Check a node with:

```sh
sysctl net.ipv4.ip_local_port_range
```

Change the glob if any of these apply:

- **The range is wider.** If a node's range starts below 32768 (for example `1024 65535`), replies to those ports pass the filter and series start growing again. Lower the bound in the glob to match the start of your range. Make sure no server ports you care about sit between the new bound and 32768, or add them as explicit alternatives.
- **Source ports are rewritten (SNAT).** Connections that go through the node's IP (kubelet, host-network pods, NodePort traffic, some CNI and mesh setups) can get a source port outside the pod's range. A few such ports then show up below 32768. In the lab cluster this appears as a handful of single-series ports (`18209`, `20580`) on flows between node-level owners, mostly with `direction="response"` or `"unknown"`. A few stable series like that are harmless. A steadily growing number is not, and means you should lower the bound or exclude those owners (see [Namespace scoping](#namespace-scoping-for-large-clusters)).

Also note that `50051` is inside the default ephemeral range, so a reply to a client that happened to use port 50051 is kept. That costs at most one extra series per affected pair.

## Adding server ports ≥ 32768

Any server port at or above 32768 is dropped unless you list it. Add it as another comma-separated alternative at the end of the glob. For example, to also keep `50052` and `61000`:

```yaml
filter:
  network:
    dst_port:
      match: "{?,??,???,????,[12]????,3[01]???,32[0-6]??,327[0-5]?,3276[0-7],50051,50052,61000}"
```

If a newly kept port is HTTP or gRPC and isn't one of KubeLynx's defaults, also add it to the file passed to `-protocol-ports-file` so the protocol filter classifies it. The flag's defaults are HTTP `80, 443, 3000, 5000, 8000, 8080, 8443` and gRPC `50051, 9090`. To keep it as its own edge instead of folding it into `multiple`, add it to `-tcp-port-allowlist-file` as well.

## Namespace scoping for large clusters

On large clusters, scope collection by namespace on top of the port filter. The two are independent. Beyla's `filter.network` accepts `k8s_src_namespace` and `k8s_dst_namespace` with the same `match` / `not_match` globs. All entries under `filter.network` are ANDed, so a flow must pass every one of them.

The simplest form excludes namespaces you never want in the graph. With `not_match` on both sides, any flow that touches an excluded namespace is dropped:

```yaml
filter:
  network:
    dst_port:
      match: "{?,??,???,????,[12]????,3[01]???,32[0-6]??,327[0-5]?,3276[0-7],50051}"
    k8s_src_namespace:
      not_match: "{kube-system,monitoring}"
    k8s_dst_namespace:
      not_match: "{kube-system,monitoring}"
```

Using `match` on both sides instead keeps only flows where **both** ends are in the listed namespaces, so traffic crossing into or out of that set disappears from the graph. Choose `match` only if that is what you want.

The namespace snippets above aren't part of the dev config. They follow the same `filter.network` syntax as the `dst_port` filter it ships.

## Advanced: full-fidelity profile

The default profile drops reply-direction bytes. If you need them (for example for byte accounting in other dashboards), you can skip the `dst_port` filter in Beyla and bound cardinality in an OpenTelemetry Collector instead:

1. Export Beyla's metrics over OTLP to a Collector instead of (or in addition to) `prometheus_export`.
2. In the Collector, use the `transform` processor to rewrite the ephemeral `dst.port` on response-direction data points, then `aggregate_on_attributes` to merge the points that now share the same attributes.
3. Export the aggregated metric to Prometheus.

The Collector is a component on **your** stack. KubeLynx doesn't ship, deploy or manage it, and stays a read-only Prometheus consumer either way. Most operators don't need this, which is why it's not the default (see ADR 0003, rejected alternative 3).

## Known limitation: request direction only

With the default profile, KubeLynx's byte rates reflect request-direction traffic: in the dev cluster about 15% of raw bytes. Reverse "reply" edges don't appear. KubeLynx's topology query also excludes `direction="response"` series on its own, so the graph shows request-direction edges even with the full-fidelity profile. That is enough for KubeLynx's purpose, which is to show which workloads talk to which and on what ports, not billing-grade byte counts.

## Istio source

None of this applies to KubeLynx's Istio source. `istio_requests_total` and `istio_tcp_*` don't carry a raw ephemeral port by default, so their cardinality stays low without a profile ([ADR 0002](adr/0002-istio-telemetry-source.md)).
