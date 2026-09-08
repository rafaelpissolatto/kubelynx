# kubelynx
KubeLynx is a lightweight Kubernetes network topology UI that transforms Prometheus metrics and eBPF telemetry into real-time service-to-port traffic flows

## Development

Spin up the dev cluster (kind + Beyla + Prometheus): `make setup`, then port-forward Prometheus with `make port-prometheus` (serves on `localhost:9090`).

Run the backend:

```
go run ./cmd/kubelynx -prometheus-url http://localhost:9090
```

Run the frontend (proxies `/api` to the backend on `:8080`):

```
cd web && npm install && npm run dev
```
