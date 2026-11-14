<p align="center">
  <img src="web/public/logo.svg" alt="KubeLynx logo" width="96" height="96">
</p>

<h1 align="center">KubeLynx</h1>

<p align="center">
  A lightweight Kubernetes network topology UI that turns the eBPF flow metrics Grafana Beyla exports to Prometheus into a live workload-to-workload traffic graph.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-6b3fd4"></a>
  <img alt="Go 1.26" src="https://img.shields.io/badge/go-1.26-6b3fd4">
  <img alt="React 19" src="https://img.shields.io/badge/react-19-6b3fd4">
</p>

<p align="center">
  <img src="docs/images/topology-dark.png" alt="KubeLynx topology view: workloads grouped by namespace, with live traffic edges and a flows table" width="100%">
</p>

## How it works

KubeLynx only reads telemetry that already exists. It doesn't scrape endpoints, create new metrics, or add agents or sidecars to your cluster.

```mermaid
flowchart LR
  beyla["Grafana Beyla<br/>(eBPF)"] -- network flow metrics --> prom[(Prometheus)]
  prom -- PromQL --> api["KubeLynx backend<br/>/api/*"]
  api --> ui["KubeLynx UI"]
  classDef lynx fill:#2a2342,stroke:#b79cff,color:#e6e6ef
  class beyla,prom,api,ui lynx
```

Each node in the graph is a **workload**: a Deployment, ReplicaSet, DaemonSet or StatefulSet plus its namespace, as Beyla reports it. Nodes are never Kubernetes Services, because Beyla's flow metrics carry no Service identity. [CONTEXT.md](CONTEXT.md) has the full domain vocabulary.

You run Beyla yourself. To keep its flow metrics from growing a new Prometheus series per connection, apply the collection profile in [docs/flow-cardinality.md](docs/flow-cardinality.md).

## Features

- **Live topology.** Workloads are grouped into namespace bands. Traffic shows as moving dots along edges, and inbound ports appear as badges on each workload.
- **Filters.** Pick one or more namespaces, or narrow the graph to HTTP, gRPC or TCP traffic.
- **Layout.** Choose vertical, horizontal or automatic band arrangement. Dragged positions are remembered; **Rearrange** resets them.
- **Flows table.** Search flows by source or destination. Selecting one shows the PromQL query behind it.
- **Refresh and theme.** Pause and resume live refresh, and switch between dark, light or system themes.
- **Bounded cardinality.** TCP ports outside a known-ports allowlist, and UDP ports other than 53, are grouped into a single `multiple` flow.

## Development

Requirements: Go 1.26, Node.js with npm, Docker, [kind](https://kind.sigs.k8s.io/), kubectl and Helm.

1. Spin up the dev cluster (kind, Prometheus, Beyla and demo traffic):

   ```sh
   make setup
   ```

2. Port-forward Prometheus to `localhost:9090`:

   ```sh
   make port-prometheus
   ```

3. Run the backend (serves the API on `:8080`):

   ```sh
   go run ./cmd/kubelynx -prometheus-url http://localhost:9090
   ```

4. Run the frontend (proxies `/api` to the backend on `:8080`):

   ```sh
   cd web && npm install && npm run dev
   ```

Other make targets:

| Target | What it does |
| --- | --- |
| `make test` | Checks that Beyla flow metrics are reaching Prometheus |
| `make image` | Builds the `kubelynx:dev` container image |
| `make deploy-kubelynx` | Builds the image, loads it into kind and installs the Helm chart into the `kubelynx` namespace |
| `make port-kubelynx` | Port-forwards the in-cluster KubeLynx to `localhost:8080` |
| `make lint-chart` | Runs `helm lint` on the chart |
| `make logs-beyla` | Tails the Beyla logs |
| `make clean` | Deletes the kind cluster |

### Backend flags

| Flag | Default | Description |
| --- | --- | --- |
| `-listen-addr` | `:8080` | Address to serve the API on |
| `-prometheus-url` | `http://localhost:9090` | Base URL of the Prometheus server to query |
| `-refresh-interval` | `15s` | How often the UI polls for fresh topology. A `?refreshInterval=<ms>` URL param overrides it per browser tab |
| `-namespace-warn-threshold` | `6` | When the namespace picker shows a non-blocking "large graphs may render slowly" warning: at this many namespaces from different prefix groups (the part before the first `-`), or "All namespaces" on a cluster with at least this many. `0` turns it off. Selections are never capped |
| `-flow-series-budget` | `1000` | Logs a warning when `beyla_network_flow_bytes_total` holds more than this many series, a sign the [Beyla cardinality profile](docs/flow-cardinality.md) isn't applied. Checked at startup and every 5 minutes, independent of UI traffic; logs once when the count goes over and once when it drops back under. `0` turns it off |
| `-prometheus-bearer-token-file` | none | File containing a bearer token for Prometheus/Thanos/Mimir, sent as `Authorization: Bearer <token>`. Re-read on every request, so a rotated Secret applies without a restart. Omit for no auth. |
| `-prometheus-basic-auth-username` | none | Username for HTTP Basic auth (OpenObserve, Grafana Cloud, a Prometheus behind an auth gateway). Requires `-prometheus-basic-auth-password-file`. Can't be combined with `-prometheus-bearer-token-file` or credentials in `-prometheus-url`. |
| `-prometheus-basic-auth-password-file` | none | File containing the Basic-auth password (surrounding whitespace trimmed). Re-read on every request, so a rotated Secret applies without a restart. Requires `-prometheus-basic-auth-username`. There is deliberately no literal-password flag. |
| `-protocol-ports-file` | built-in defaults | JSON file overriding the HTTP/gRPC port classification, e.g. `{"http":["8081"],"grpc":["50052"]}` |
| `-tcp-port-allowlist-file` | built-in defaults | JSON file overriding the TCP known-ports allowlist, e.g. `{"tcp":["80","443","8080"]}` |

To query a secured Prometheus locally:

```sh
echo -n "$TOKEN" > /tmp/prom-token
go run ./cmd/kubelynx -prometheus-url https://prom.example -prometheus-bearer-token-file /tmp/prom-token
```

For a backend that uses HTTP Basic auth, such as the OpenObserve in the Istio lab cluster (`kubectl -n monitoring port-forward svc/openobserve 5080:5080`), pass a username and a password file rather than embedding credentials in the URL:

```sh
kubectl -n monitoring get secret openobserve-credentials -o jsonpath='{.data.password}' | base64 -d > /tmp/prom-password
go run ./cmd/kubelynx -prometheus-url http://localhost:5080/api/default/prometheus \
  -prometheus-basic-auth-username root@example.com -prometheus-basic-auth-password-file /tmp/prom-password
```

The startup log's `prometheus_auth` field shows which mode is active: `none`, `bearer-file`, `basic-file`, or `url-userinfo`. Credentials embedded in `-prometheus-url` (`http://user:pass@host`) still work, but the password is redacted wherever KubeLynx logs the URL.

## Install

KubeLynx ships as a single container image: the Go backend serves the API and the embedded frontend ([ADR 0001](docs/adr/0001-single-image-packaging.md)). The Helm chart installs one Deployment and one Service. Each release publishes both to GHCR under the same version: chart `X.Y.Z` runs image `ghcr.io/rafaelpissolatto/kubelynx:X.Y.Z`. Pick a version from the [releases page](https://github.com/rafaelpissolatto/kubelynx/releases).

```sh
helm install kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z \
  -n kubelynx --create-namespace \
  --set prometheus.url=http://prometheus-operated.monitoring.svc:9090
kubectl port-forward -n kubelynx svc/kubelynx 8080:80   # then open http://localhost:8080
```

To see every setting a version supports, run `helm show values oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z`. To install from a checkout instead, for example to try unreleased changes, point Helm at the local chart. It uses the image matching the chart's `appVersion`, so set `image.tag` if that version isn't published:

```sh
helm install kubelynx ./charts/kubelynx -n kubelynx --create-namespace \
  --set prometheus.url=http://prometheus-operated.monitoring.svc:9090
```

If your Prometheus (or Thanos/Mimir) needs a bearer token, put it in a Secret and reference it. It's mounted as a file and re-read on every request, so rotating the Secret needs no restart:

```sh
kubectl create secret generic prom-token -n kubelynx --from-literal=token=<token>
helm upgrade kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z -n kubelynx --reuse-values \
  --set prometheus.bearerToken.existingSecret.name=prom-token
```

If it needs HTTP Basic auth instead (OpenObserve, Grafana Cloud, or a Prometheus behind an auth gateway), put the password in a Secret and set the username. The password is mounted the same way, so rotation needs no restart. Bearer and Basic auth can't both be set, and the chart refuses to render with only one of `username` and `existingSecret.name`:

```sh
kubectl create secret generic prom-basic-auth -n kubelynx --from-file=password=./password
helm upgrade kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z -n kubelynx --reuse-values \
  --set prometheus.basicAuth.username=root@example.com \
  --set prometheus.basicAuth.existingSecret.name=prom-basic-auth
```

To tune which TCP ports keep their own edge, or which ports count as HTTP/gRPC, set them inline. The chart writes them to a ConfigMap and mounts it for the matching flag, and the pod restarts when they change. A list you set replaces the built-in one, so include every port you want:

```sh
helm upgrade kubelynx oci://ghcr.io/rafaelpissolatto/charts/kubelynx --version X.Y.Z -n kubelynx --reuse-values \
  --set-json 'cardinality.tcpPortAllowlist={"tcp":["80","443","8080","5432"]}' \
  --set-json 'protocol.ports={"http":["80","8081"],"grpc":["50052"]}'
```

Main values:

| Value | Default | Description |
| --- | --- | --- |
| `prometheus.url` | `http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090` | Prometheus base URL (required) |
| `prometheus.bearerToken.existingSecret.name` | `""` | Secret holding a bearer token; empty means no auth |
| `prometheus.bearerToken.existingSecret.key` | `token` | Key inside that Secret |
| `prometheus.basicAuth.username` | `""` | HTTP Basic-auth username; set together with `prometheus.basicAuth.existingSecret.name` |
| `prometheus.basicAuth.existingSecret.name` | `""` | Secret holding the Basic-auth password; empty means no Basic auth |
| `prometheus.basicAuth.existingSecret.key` | `password` | Key inside that Secret |
| `refreshInterval` | `15s` | How often the UI polls for fresh topology |
| `namespaceWarnThreshold` | `6` | Passed as `--namespace-warn-threshold`: how many namespaces from different prefix groups the namespace picker accepts before warning that the graph may render slowly; `0` turns it off |
| `flowSeriesBudget` | `1000` | Passed as `--flow-series-budget`: series count of `beyla_network_flow_bytes_total` above which KubeLynx logs a cardinality warning; `0` turns it off |
| `cardinality.tcpPortAllowlist` | `{}` | Inline `{"tcp": ["80","443"]}` rendered into a ConfigMap and passed as `--tcp-port-allowlist-file`; empty keeps the built-in allowlist. TCP ports outside it collapse into one `multiple` edge |
| `protocol.ports` | `{}` | Inline `{"http": ["80"], "grpc": ["50051"]}` rendered into a ConfigMap and passed as `--protocol-ports-file`; empty keeps the built-in HTTP/gRPC ports |

See [`values.yaml`](charts/kubelynx/values.yaml) for the rest (image, resources, security context, scheduling).

KubeLynx needs **no Kubernetes RBAC**: it only talks to Prometheus, so the chart creates no ServiceAccount, Role or ClusterRole and mounts no API token into the pod. It also has **no authentication of its own**. Before exposing it beyond the cluster network, put it behind your ingress auth or a NetworkPolicy.

To try a local build in the dev cluster, run `make setup` once, then `make deploy-kubelynx` and `make port-kubelynx`. To cut a release, see [docs/releasing.md](docs/releasing.md).

CI scans the code, dependencies, git history and image for vulnerabilities and secrets. `make scan` runs the same scanners locally. To see what runs, or to suppress a false positive, see [docs/security-scanning.md](docs/security-scanning.md).

## License

[Apache 2.0](LICENSE)
