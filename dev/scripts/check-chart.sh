#!/usr/bin/env bash
# Verifies the rendered Helm chart keeps the promises KubeLynx makes about
# itself: exactly one Deployment and one Service, no RBAC, no Kubernetes API
# token, and the Prometheus bearer token / Basic-auth password wired as
# rotatable file mounts that can't both be configured, plus the optional
# port-file ConfigMaps (absent by default, directory-mounted when set).
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

if grep -q -- '--prometheus-basic-auth' <<<"$MANIFESTS"; then
  fail "basic auth flags rendered with default values"
fi
if grep -q -- '--prometheus-basic-auth' <<<"$WITH_TOKEN"; then
  fail "basic auth flags rendered with only a bearer token configured"
fi
if grep -q 'prometheus-basic-auth' <<<"$WITH_TOKEN"; then
  fail "basic auth volume rendered with only a bearer token configured"
fi

if ! WITH_BASIC=$(render --set prometheus.basicAuth.username=root@example.com \
  --set prometheus.basicAuth.existingSecret.name=prom-basic-auth); then
  echo "FAIL: chart doesn't render with basic auth configured"
  exit 1
fi
if ! grep -q -- '"--prometheus-basic-auth-username=root@example.com"' <<<"$WITH_BASIC"; then
  fail "basic auth username flag missing when basic auth is configured"
fi
if ! grep -q -- '--prometheus-basic-auth-password-file=/var/run/secrets/kubelynx/prometheus-basic-auth/password' <<<"$WITH_BASIC"; then
  fail "basic auth password file flag missing when basic auth is configured"
fi
if ! grep -q 'secretName: prom-basic-auth' <<<"$WITH_BASIC"; then
  fail "basic auth Secret volume missing when basic auth is configured"
fi
if ! grep -q 'key: password' <<<"$WITH_BASIC"; then
  fail "basic auth Secret key must default to password"
fi
if grep -qE '^ *subPath:' <<<"$WITH_BASIC"; then
  fail "basic auth password is mounted with subPath; Secret rotation needs a directory mount"
fi
if grep -q -- '--prometheus-bearer-token-file' <<<"$WITH_BASIC"; then
  fail "bearer token flag rendered with only basic auth configured"
fi
if ! WITH_BASIC_KEY=$(render --set prometheus.basicAuth.username=root@example.com \
  --set prometheus.basicAuth.existingSecret.name=openobserve-credentials \
  --set prometheus.basicAuth.existingSecret.key=ZO_ROOT_USER_PASSWORD) \
  || ! grep -q 'key: ZO_ROOT_USER_PASSWORD' <<<"$WITH_BASIC_KEY"; then
  fail "basic auth Secret key isn't configurable"
fi

# Half-configured or ambiguous auth must fail at render time.
if render --set prometheus.basicAuth.username=root@example.com >/dev/null 2>&1; then
  fail "chart accepted prometheus.basicAuth.username without existingSecret.name"
fi
if render --set prometheus.basicAuth.existingSecret.name=prom-basic-auth >/dev/null 2>&1; then
  fail "chart accepted prometheus.basicAuth.existingSecret.name without username"
fi
if render --set prometheus.bearerToken.existingSecret.name=prom-token \
  --set prometheus.basicAuth.username=root@example.com \
  --set prometheus.basicAuth.existingSecret.name=prom-basic-auth >/dev/null 2>&1; then
  fail "chart accepted bearer token and basic auth together"
fi

# Optional port files: absent by default, rendered as directory-mounted
# ConfigMaps (no subPath) whose key matches the path the flag points at.
for needle in 'kind: ConfigMap' 'tcp-port-allowlist' 'protocol-ports' 'configMap:' '/var/run/kubelynx/'; do
  if grep -q -- "$needle" <<<"$MANIFESTS"; then
    fail "default render contains '$needle'; port file options must be opt-in"
  fi
done
for with in "$WITH_TOKEN" "$WITH_BASIC"; do
  if grep -qE 'kind: ConfigMap|port-allowlist|protocol-ports' <<<"$with"; then
    fail "port file wiring rendered when only auth is configured"
  fi
done

if ! WITH_TCP=$(render --set-json 'cardinality.tcpPortAllowlist={"tcp":["80",8081]}'); then
  echo "FAIL: chart doesn't render with cardinality.tcpPortAllowlist"
  exit 1
fi
if ! grep -q -- '--tcp-port-allowlist-file=/var/run/kubelynx/cardinality/tcp-port-allowlist.json' <<<"$WITH_TCP"; then
  fail "tcp allowlist flag missing when cardinality.tcpPortAllowlist is set"
fi
if ! grep -q 'mountPath: /var/run/kubelynx/cardinality$' <<<"$WITH_TCP"; then
  fail "tcp allowlist mountPath must be the directory of the flag's file"
fi
# Ports must reach the file as strings, whatever YAML typed them as.
if ! grep -qF '  tcp-port-allowlist.json: "{\"tcp\":[\"80\",\"8081\"]}"' <<<"$WITH_TCP"; then
  fail 'tcp allowlist ConfigMap data must be {"tcp":["80","8081"]} with ports as strings'
fi
if ! grep -qE '^ *- key: tcp-port-allowlist.json$' <<<"$WITH_TCP" \
  || ! grep -qE '^ *path: tcp-port-allowlist.json$' <<<"$WITH_TCP"; then
  fail "tcp allowlist volume must project ConfigMap key tcp-port-allowlist.json to that file name"
fi
if grep -qE '^ *subPath:' <<<"$WITH_TCP"; then
  fail "tcp allowlist is mounted with subPath; use a directory mount"
fi
if grep -q -- '--protocol-ports-file' <<<"$WITH_TCP" || grep -q 'kubelynx/protocol' <<<"$WITH_TCP"; then
  fail "protocol ports wiring rendered with only the tcp allowlist set"
fi
if [[ $(grep -c '^kind: ConfigMap$' <<<"$WITH_TCP") -ne 1 ]]; then
  fail "expected exactly one ConfigMap with only the tcp allowlist set"
fi

if ! WITH_PROTO=$(render --set-json 'protocol.ports={"http":["80","8081"],"grpc":["50052"]}'); then
  echo "FAIL: chart doesn't render with protocol.ports"
  exit 1
fi
if ! grep -q -- '--protocol-ports-file=/var/run/kubelynx/protocol/ports.json' <<<"$WITH_PROTO"; then
  fail "protocol ports flag missing when protocol.ports is set"
fi
if ! grep -q 'mountPath: /var/run/kubelynx/protocol$' <<<"$WITH_PROTO"; then
  fail "protocol ports mountPath must be the directory of the flag's file"
fi
if ! grep -qF '  ports.json: "{\"grpc\":[\"50052\"],\"http\":[\"80\",\"8081\"]}"' <<<"$WITH_PROTO"; then
  fail "protocol ports ConfigMap data must carry http and grpc lists as strings"
fi
if ! grep -qE '^ *- key: ports.json$' <<<"$WITH_PROTO" || ! grep -qE '^ *path: ports.json$' <<<"$WITH_PROTO"; then
  fail "protocol ports volume must project ConfigMap key ports.json to that file name"
fi
if grep -qE '^ *subPath:' <<<"$WITH_PROTO"; then
  fail "protocol ports are mounted with subPath; use a directory mount"
fi
if grep -q -- '--tcp-port-allowlist-file' <<<"$WITH_PROTO" || grep -q 'kubelynx/cardinality' <<<"$WITH_PROTO"; then
  fail "tcp allowlist wiring rendered with only protocol.ports set"
fi

# Auth and both port files coexist, each as its own directory mount.
if ! WITH_ALL=$(render --set prometheus.basicAuth.username=root@example.com \
  --set prometheus.basicAuth.existingSecret.name=prom-basic-auth \
  --set-json 'cardinality.tcpPortAllowlist={"tcp":["80"]}' \
  --set-json 'protocol.ports={"http":["80"],"grpc":[]}'); then
  fail "chart doesn't render with auth and both port files"
else
  if [[ $(grep -cE '^ *mountPath:' <<<"$WITH_ALL") -ne 3 ]]; then
    fail "expected three independent mounts (basic auth, cardinality, protocol)"
  fi
  if grep -qE '^ *subPath:' <<<"$WITH_ALL"; then
    fail "combined render uses subPath"
  fi
fi

# A typo'd key would be silently ignored by the binary; fail the render.
if render --set-json 'cardinality.tcpPortAllowlist={"tpc":["80"]}' >/dev/null 2>&1; then
  fail "chart accepted an unknown key in cardinality.tcpPortAllowlist"
fi
if render --set-json 'protocol.ports={"htp":["80"]}' >/dev/null 2>&1; then
  fail "chart accepted an unknown key in protocol.ports"
fi
if render --set-json 'protocol.ports={"http":"80"}' >/dev/null 2>&1; then
  fail "chart accepted a non-list protocol.ports.http"
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
echo "PASS: chart renders one Deployment + one Service, no RBAC, and wires bearer/basic auth and the refresh interval correctly."
