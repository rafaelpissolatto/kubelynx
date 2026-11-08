# CLUSTER_NAME is safe to override (only controls the kind cluster's own
# name). NAMESPACE is NOT safely overridable: dev/beyla/*.yaml hardcode
# `namespace: monitoring` directly, so overriding this would install
# Prometheus into one namespace while Beyla stays in another, breaking
# ServiceMonitor discovery.
CLUSTER_NAME ?= kubelynx-dev
NAMESPACE = monitoring
# IMAGE_REPO/IMAGE_TAG are safe to override (e.g. to test a registry image);
# KUBELYNX_NAMESPACE is too, as long as port-kubelynx uses the same value.
IMAGE_REPO ?= kubelynx
IMAGE_TAG ?= dev
IMAGE = $(IMAGE_REPO):$(IMAGE_TAG)
KUBELYNX_NAMESPACE ?= kubelynx

.PHONY: cluster deploy-prometheus deploy-beyla demo-traffic setup test \
        port-prometheus logs-beyla clean all \
        image kind-load deploy-kubelynx port-kubelynx lint-chart \
        scan scan-tools scan-suppressions scan-govulncheck scan-deps scan-gosec \
        scan-sast scan-secrets scan-image lint-workflows

all: setup

# --- Cluster ---
cluster:
	@if kind get clusters 2>/dev/null | grep -q "^$(CLUSTER_NAME)$$"; then \
		echo "Cluster '$(CLUSTER_NAME)' already exists, skipping creation."; \
	else \
		kind create cluster --name $(CLUSTER_NAME) --config dev/kind/kind-config.yaml; \
	fi

# --- Prometheus (kube-prometheus-stack, Beyla-discoverable) ---
deploy-prometheus:
	helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update
	helm repo update
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
		--namespace $(NAMESPACE) \
		--values dev/prometheus/values.yaml \
		--wait --timeout 5m

# --- Beyla (eBPF network telemetry source) ---
deploy-beyla:
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f dev/beyla/00-rbac.yaml
	kubectl apply -f dev/beyla/10-configmap.yaml
	kubectl apply -f dev/beyla/20-daemonset.yaml
	kubectl apply -f dev/beyla/30-service-servicemonitor.yaml
	kubectl rollout status ds/beyla -n $(NAMESPACE) --timeout=180s

# --- Demo traffic (two-namespace client/server) ---
demo-traffic:
	kubectl apply -f dev/beyla/40-demo-traffic.yaml
	kubectl wait --for=condition=available deployment/backend -n demo-backend --timeout=120s
	kubectl wait --for=condition=available deployment/frontend -n demo-frontend --timeout=120s

# --- Full setup ---
setup: cluster deploy-prometheus deploy-beyla demo-traffic
	@echo ""
	@echo "Setup complete."
	@echo "Prometheus: make port-prometheus"
	@echo "Validate:   make test"

# --- KubeLynx (single image + Helm chart) ---
image:
	docker build -t $(IMAGE) .

kind-load:
	kind load docker-image $(IMAGE) --name $(CLUSTER_NAME)

# Installs the locally built image; pullPolicy=Never so kind never tries to
# fetch kubelynx:dev from a registry. The tag never changes between rebuilds,
# so the rollout restart is what makes a redeploy pick up the new image.
deploy-kubelynx: image kind-load
	helm upgrade --install kubelynx charts/kubelynx \
		--namespace $(KUBELYNX_NAMESPACE) --create-namespace \
		--set image.repository=$(IMAGE_REPO) \
		--set image.tag=$(IMAGE_TAG) \
		--set image.pullPolicy=Never \
		--wait --timeout 2m
	kubectl rollout restart deployment/kubelynx -n $(KUBELYNX_NAMESPACE)
	kubectl rollout status deployment/kubelynx -n $(KUBELYNX_NAMESPACE) --timeout=2m

port-kubelynx:
	kubectl port-forward -n $(KUBELYNX_NAMESPACE) svc/kubelynx 8080:80

lint-chart:
	helm lint charts/kubelynx
	./dev/scripts/check-chart.sh

# --- Security scanning (docs/security-scanning.md) ---
# CI runs these same targets, so a local run matches the gate. Scanners are
# pinned in scripts/security/install-tools.sh and installed into .bin/scan;
# reports (SARIF/JSON) land in scan-reports/.
SCAN_BIN := $(CURDIR)/.bin/scan
SCAN_OUT ?= scan-reports
SCAN_INSTALL = @BIN_DIR=$(SCAN_BIN) scripts/security/install-tools.sh
# Image to scan; SCAN_PLATFORM picks one platform of a multi-arch registry ref.
SCAN_IMAGE ?= $(IMAGE)
SCAN_PLATFORM ?=
# git log range for scan-secrets, e.g. origin/main..HEAD; empty = full history.
GITLEAKS_LOG_OPTS ?=
SEMGREP_IMAGE := semgrep/semgrep:1.182.0@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af
SEMGREP_CONFIGS := --config p/golang --config p/typescript --config p/javascript --config p/react --config p/dockerfile
TRIVY_FLAGS = --quiet --scanners vuln --ignorefile .trivyignore.yaml $(if $(SCAN_PLATFORM),--platform $(SCAN_PLATFORM))

# Everything except the image, which needs `make image` first.
scan: scan-suppressions scan-govulncheck scan-deps scan-gosec scan-sast scan-secrets

scan-tools:
	$(SCAN_INSTALL)

scan-suppressions:
	python3 scripts/security/check-suppressions.py

# Fails on vulnerabilities reachable from kubelynx's own call graph.
scan-govulncheck:
	$(SCAN_INSTALL) govulncheck >/dev/null
	@mkdir -p $(SCAN_OUT)
	$(SCAN_BIN)/govulncheck -format sarif ./... > $(SCAN_OUT)/govulncheck.sarif
	$(SCAN_BIN)/govulncheck ./...

# Fails on HIGH/CRITICAL fixable vulns in web/package-lock.json and go.mod.
scan-deps:
	$(SCAN_INSTALL) osv-scanner >/dev/null
	PATH="$(SCAN_BIN):$$PATH" scripts/security/osv-gate.sh $(SCAN_OUT)

scan-gosec:
	$(SCAN_INSTALL) gosec >/dev/null
	@mkdir -p $(SCAN_OUT)
	$(SCAN_BIN)/gosec -fmt sarif -out $(SCAN_OUT)/gosec.sarif -stdout -verbose text ./...

# SAST for Go, TypeScript/React and the Dockerfile. Unlike CodeQL it runs
# without GHAS; see docs/security-scanning.md.
scan-sast:
	@mkdir -p $(SCAN_OUT)
	docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp -e SEMGREP_SEND_METRICS=off \
		-v "$(CURDIR):/src" -w /src $(SEMGREP_IMAGE) \
		semgrep scan --metrics=off --error $(SEMGREP_CONFIGS) --sarif-output=$(SCAN_OUT)/semgrep.sarif

scan-secrets:
	$(SCAN_INSTALL) gitleaks >/dev/null
	@mkdir -p $(SCAN_OUT)
	$(SCAN_BIN)/gitleaks git --no-banner --redact --config .gitleaks.toml \
		--report-format sarif --report-path $(SCAN_OUT)/gitleaks.sarif \
		$(if $(GITLEAKS_LOG_OPTS),--log-opts="$(GITLEAKS_LOG_OPTS)") .

# Full report to SARIF, then the gate: HIGH/CRITICAL with a fix available.
scan-image:
	$(SCAN_INSTALL) trivy >/dev/null
	@mkdir -p $(SCAN_OUT)
	$(SCAN_BIN)/trivy image $(TRIVY_FLAGS) --format sarif --output $(SCAN_OUT)/trivy-image.sarif $(SCAN_IMAGE)
	$(SCAN_BIN)/trivy image $(TRIVY_FLAGS) --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 $(SCAN_IMAGE)

lint-workflows:
	$(SCAN_INSTALL) actionlint >/dev/null
	$(SCAN_BIN)/actionlint

# --- Validation ---
test:
	NAMESPACE=$(NAMESPACE) ./dev/scripts/validate.sh

# --- Utilities ---
port-prometheus:
	kubectl port-forward -n $(NAMESPACE) svc/prometheus-kube-prometheus-prometheus 9090:9090

logs-beyla:
	kubectl logs -n $(NAMESPACE) -l app.kubernetes.io/name=beyla -f

# --- Cleanup ---
clean:
	kind delete cluster --name $(CLUSTER_NAME)
