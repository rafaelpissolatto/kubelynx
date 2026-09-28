#!/usr/bin/env bash
# Verifies the rendered Helm chart keeps the promises KubeLynx makes about
# itself: exactly one Deployment and one Service, no RBAC, no Kubernetes API
# token, and the Prometheus bearer token wired as a rotatable file mount.
# Needs only `helm` — no cluster. Run from the repo root (or set CHART).
set -euo pipefail

CHART="${CHART:-charts/kubelynx}"
FAILED=false

fail() {
  echo "FAIL: $*"
  FAILED=true
}

render() {
  helm template kubelynx "$CHART" "$@"
}

# helm's own error goes to stderr, right above the FAIL line.
if ! MANIFESTS=$(render); then
  echo "FAIL: chart doesn't render with default values"
  exit 1
fi

KINDS=$(grep -E '^kind:' <<<"$MANIFESTS" | sort -u || true)
if [[ "$KINDS" != $'kind: Deployment\nkind: Service' ]]; then
  fail "chart must render exactly a Deployment and a Service, got: $(tr '\n' ' ' <<<"$KINDS")"
fi
if [[ $(grep -cE '^kind:' <<<"$MANIFESTS") -ne 2 ]]; then
  fail "chart must render one object of each kind"
fi
if grep -qE '^kind: (ClusterRole|Role|ClusterRoleBinding|RoleBinding|ServiceAccount)$' <<<"$MANIFESTS"; then
  fail "chart renders RBAC or a ServiceAccount; KubeLynx needs no Kubernetes API access"
fi
if ! grep -q 'automountServiceAccountToken: false' <<<"$MANIFESTS"; then
  fail "pod must set automountServiceAccountToken: false"
fi
if grep -q -- '--prometheus-bearer-token-file' <<<"$MANIFESTS"; then
  fail "bearer token flag rendered without prometheus.bearerToken.existingSecret.name"
fi

if ! WITH_TOKEN=$(render --set prometheus.bearerToken.existingSecret.name=prom-token); then
  echo "FAIL: chart doesn't render with a bearer token Secret"
  exit 1
fi
if ! grep -q -- '--prometheus-bearer-token-file=/var/run/secrets/kubelynx/prometheus/token' <<<"$WITH_TOKEN"; then
  fail "bearer token flag missing when a Secret is referenced"
fi
if ! grep -q 'secretName: prom-token' <<<"$WITH_TOKEN"; then
  fail "bearer token Secret volume missing when a Secret is referenced"
fi
# kubelet never updates subPath mounts, which would break token rotation.
if grep -qE '^ *subPath:' <<<"$WITH_TOKEN"; then
  fail "bearer token is mounted with subPath; Secret rotation needs a directory mount"
fi

# Values the chart must reject at render time rather than crash-loop on.
for bad in 'prometheus.url=' 'refreshInterval=abc' 'refreshInterval=30'; do
  if render --set "$bad" >/dev/null 2>&1; then
    fail "chart accepted --set $bad"
  fi
done
if ! render --set refreshInterval=1m30s >/dev/null 2>&1; then
  fail "chart rejected --set refreshInterval=1m30s"
fi

if [[ "$FAILED" == "true" ]]; then
  exit 1
fi
echo "PASS: chart renders one Deployment + one Service, no RBAC, and wires the bearer token and refresh interval correctly."
