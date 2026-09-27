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
        image kind-load deploy-kubelynx port-kubelynx lint-chart

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
