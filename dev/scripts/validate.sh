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
