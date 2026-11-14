#!/usr/bin/env bash
# Verifies Prometheus is actually receiving beyla_network_flow_bytes_total
# series carrying the attributes KubeLynx's spec requires.
set -euo pipefail

NAMESPACE="${NAMESPACE:-monitoring}"
PROM_SERVICE="${PROM_SERVICE:-prometheus-kube-prometheus-prometheus}"
LOCAL_PORT="${LOCAL_PORT:-9091}"

PF_LOG=$(mktemp)
cleanup() {
  if [[ -n "${PF_PID:-}" ]]; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
  rm -f "$PF_LOG"
}
trap cleanup EXIT

kubectl port-forward -n "$NAMESPACE" "svc/$PROM_SERVICE" "$LOCAL_PORT:9090" >"$PF_LOG" 2>&1 &
PF_PID=$!

READY=false
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$LOCAL_PORT/-/ready"; then
    READY=true
    break
  fi
  sleep 1
done

if [[ "$READY" != "true" ]]; then
  echo "FAIL: Prometheus never became ready via port-forward after 30s."
  cat "$PF_LOG"
  exit 1
fi

# Right after `make setup`, Beyla and Prometheus are up but the first scrape
# (15s interval) plus a few seconds of real demo traffic haven't necessarily
# landed yet. Poll instead of failing on the first empty result.
echo "Waiting for beyla_network_flow_bytes_total series for the demo-backend workload..."
DEMO_RESULT='{"data":{"result":[]}}'
DEMO_COUNT=0
for _ in $(seq 1 36); do
  DEMO_RESULT=$(curl -s "http://localhost:$LOCAL_PORT/api/v1/query" --data-urlencode 'query=beyla_network_flow_bytes_total{k8s_dst_namespace="demo-backend"}')
  DEMO_COUNT=$(echo "$DEMO_RESULT" | jq '.data.result | length')
  if [[ "$DEMO_COUNT" -gt 0 ]]; then
    break
  fi
  sleep 5
done

if [[ "$DEMO_COUNT" -eq 0 ]]; then
  echo "FAIL: no beyla_network_flow_bytes_total series found for the demo-backend workload after 3 minutes."
  echo "$DEMO_RESULT"
  exit 1
fi
echo "Found $DEMO_COUNT demo workload series."

# Keep this list in sync with the `select.beyla_network_flow_bytes.include`
# list in dev/beyla/10-configmap.yaml (Prometheus flattens Beyla's dotted
# attribute names to underscores, e.g. k8s.src.owner.name -> k8s_src_owner_name).
REQUIRED_LABELS=(k8s_src_owner_name k8s_src_namespace k8s_src_owner_type k8s_dst_owner_name k8s_dst_namespace k8s_dst_owner_type transport dst_port direction)

# Not every capture point for a given flow carries every label (e.g. a
# pre-NAT view of Service traffic can be missing the source side) — that's
# expected Beyla behavior. What matters is that at least one series for the
# demo workload carries the full set KubeLynx depends on.
FULLY_LABELED=$(echo "$DEMO_RESULT" | jq -c --argjson required "$(printf '%s\n' "${REQUIRED_LABELS[@]}" | jq -R . | jq -s .)" \
  '.data.result | map(.metric) | map(select(. as $m | $required | all(. as $r | $m | has($r)))) | .[0]')

if [[ "$FULLY_LABELED" == "null" ]]; then
  echo "FAIL: none of the $DEMO_COUNT demo workload series carry the full required label set."
  echo "Sample: $(echo "$DEMO_RESULT" | jq -c '.data.result[0].metric')"
  exit 1
fi

echo "PASS: found a fully-labeled beyla_network_flow_bytes_total series: $FULLY_LABELED"

# The demo's Istio ambient copy (dev/istio/): KubeLynx's Istio source
# (internal/topology/istio.go) reads istio_requests_total from the waypoint
# and istio_tcp_sent/received_bytes_total from ztunnel, keyed by the
# source/destination workload labels, with connection_security_policy for the
# per-edge mTLS status. Polls like the Beyla check: the waypoint and ztunnel
# need a scrape or two after `make setup` before their series show up.
prom_wait() {
  local name="$1" query="$2" result count
  echo "Waiting for $name..."
  for _ in $(seq 1 36); do
    result=$(curl -s "http://localhost:$LOCAL_PORT/api/v1/query" --data-urlencode "query=$query")
    count=$(echo "$result" | jq '.data.result | length')
    if [[ "$count" -gt 0 ]]; then
      echo "PASS: $name: $(echo "$result" | jq -c '.data.result[0].metric')"
      return 0
    fi
    sleep 5
  done
  echo "FAIL: no series for $name after 3 minutes."
  echo "  query: $query"
  exit 1
}

prom_wait "Istio waypoint requests, mesh frontend -> backend over mTLS" \
  'sum by (source_workload, source_workload_namespace, destination_workload, destination_workload_namespace, request_protocol, connection_security_policy) (istio_requests_total{source_workload_namespace="mesh-frontend", destination_workload_namespace="mesh-backend", connection_security_policy="mutual_tls"})'
prom_wait "ztunnel L4 bytes for the mesh demo" \
  'sum by (source_workload, destination_workload, destination_workload_namespace, request_protocol, connection_security_policy) (istio_tcp_sent_bytes_total{job="istio/ztunnel", destination_workload_namespace="mesh-backend"})'

echo "PASS: Beyla and Istio telemetry for the demo workloads (plain and Istio ambient) are in Prometheus."

# The HTTPS gateway (dev/gateway/): each route answers over TLS with a cert
# that verifies against the local CA (no -k), and plain HTTP redirects.
# *.localhost resolves to 127.0.0.1 in curl, as in browsers.
CA_CERT="${CA_CERT:-dev/gateway/certs/ca.crt}"
HTTP_PORT="${GATEWAY_HTTP_PORT:-80}"
HTTPS_PORT="${GATEWAY_HTTPS_PORT:-443}"
KUBELYNX_NAMESPACE="${KUBELYNX_NAMESPACE:-kubelynx}"

gw_check() {
  local name="$1" url="$2" want="$3" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert "$CA_CERT" "$url" || true)
  if [[ "$code" != "$want" ]]; then
    echo "FAIL: gateway $name: $url returned ${code:-no response}, want $want."
    exit 1
  fi
  echo "PASS: gateway $name: $url -> $code"
}

gw_check "Prometheus" "https://prometheus.localhost:$HTTPS_PORT/-/ready" 200
gw_check "plain demo backend" "https://demo.localhost:$HTTPS_PORT/" 200
gw_check "mesh demo backend" "https://mesh.localhost:$HTTPS_PORT/" 200
gw_check "HTTP -> HTTPS redirect" "http://prometheus.localhost:$HTTP_PORT/-/ready" 302
LOCATION=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "http://prometheus.localhost:$HTTP_PORT/-/ready")
if [[ "$LOCATION" != https://prometheus.localhost* ]]; then
  echo "FAIL: HTTP redirect points at '$LOCATION', want https://prometheus.localhost..."
  exit 1
fi
# Only once `make deploy-kubelynx` has installed KubeLynx and its route.
if kubectl get httproute/kubelynx -n "$KUBELYNX_NAMESPACE" >/dev/null 2>&1; then
  gw_check "KubeLynx" "https://kubelynx.localhost:$HTTPS_PORT/healthz" 200
else
  echo "SKIP: gateway KubeLynx (run make deploy-kubelynx for https://kubelynx.localhost)."
fi

echo "PASS: the HTTPS gateway serves the dev apps with a certificate from the local CA."
