# KubeLynx

A lightweight, open-source visualization UI that renders in-cluster Kubernetes network traffic by reading eBPF network telemetry that Grafana Beyla already exports to Prometheus. It is a pure consumer of existing telemetry — it does not scrape endpoints, generate new metrics, or add agents/sidecars to the cluster.

## Language

**Workload**:
The canonical identity of a node in KubeLynx's graph — a Kubernetes owner object (Deployment, ReplicaSet, DaemonSet, or StatefulSet) plus its namespace, matching exactly what Beyla's network flow metrics report (`k8s.owner.name` + `k8s.namespace`). This is what KubeLynx actually observes traffic between.
_Avoid_: Service — see below, a distinct and currently unobserved concept.

**Service**:
The Kubernetes API object (`Service`) that provides stable networking/load-balancing in front of a workload. KubeLynx's data source (Beyla's network flow metrics) does not report Service identity at all — no Service name, no ClusterIP. The UI and docs must never label a graph node "Service"; a node is always a Workload.
_Avoid_: Using this term for anything KubeLynx renders — reserve it strictly for the K8s API object, which is out of scope for the graph until/unless a data source that observes it is added.

**Flow security** (mTLS status):
Whether a Flow's traffic was mutually-TLS-encrypted, as reported by Istio's `connection_security_policy` label. Only the Istio source can observe it; Beyla can't, so a Beyla Flow has no security value at all (absent, not "unknown"). One of:
- `mutual_tls`: all of the Flow's rate carried `connection_security_policy="mutual_tls"`.
- `none`: all of it carried `none` (plaintext).
- `mixed`: both `mutual_tls` and `none` carried non-zero rate; `mtlsRatio` gives the `mutual_tls` share.
- `unknown`: the label was missing or `unknown` on every sample.
_Avoid_: "secure"/"insecure" in the UI; say mTLS / plaintext. Added to the `/api/topology` contract by issue #90 as optional fields (see ADR 0002's amendment).

