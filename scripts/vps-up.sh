#!/usr/bin/env bash
# Production-like install on a fresh Ubuntu VM (single-node k3s with its bundled Traefik): the same chart as local,
# only values-prod.yaml + a few --set values differ. Images are built on the VM and imported into k3s (no registry);
# cert-manager issues one Let's Encrypt certificate per host (gateway, store, every provisioned store).
#
# Usage (on the VM, from the repo root):
#   read -rs LLM_API_KEY && export LLM_API_KEY      # paste the LLM key (not echoed, not in shell history)
#   DOMAIN=urumi-xyz.duckdns.org EMAIL=you@example.com bash scripts/vps-up.sh
# Re-run any time (e.g. after pulling new code): it rebuilds, re-imports and upgrades. LLM_API_KEY is only needed the
# first time; the key is kept in the gateway-app Secret across upgrades.
# Env: DOMAIN, EMAIL (required); TAG (image tag, default 0.1.0); SKIP_BUILD=1; LLM_BASE_URL, LLM_MODEL,
#      LLM_REASONING_EFFORT (default: values-prod.yaml); CERT_MANAGER (version, default below).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DOMAIN:?set DOMAIN, e.g. urumi-xyz.duckdns.org}" "${EMAIL:?set EMAIL, the Lets Encrypt account contact}"
TAG=${TAG:-0.1.0}; NS=urumi; CERT_MANAGER=${CERT_MANAGER:-v1.19.6}
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
step() { printf '\n== %s\n' "$*"; }
SUDO=; [ "$(id -u)" = 0 ] || SUDO=sudo

step "DNS: gateway, store and store hosts must point at this VM"
ip=$(curl -fsS -4 --max-time 10 https://api.ipify.org || true)
for h in gateway store "check-$RANDOM"; do
  got=$(getent ahostsv4 "$h.$DOMAIN" | awk 'NR==1{print $1}')
  echo "  $h.$DOMAIN -> ${got:-unresolved} (this VM: ${ip:-unknown})"
  [ -n "$got" ] || { echo "  $h.$DOMAIN does not resolve: fix DNS first (a wildcard *.$DOMAIN is needed for stores)" >&2; exit 1; }
done

step "swap (4 GB VMs: image builds and WordPress stores need headroom)"
if ! swapon --show | grep -q .; then
  $SUDO fallocate -l 4G /swapfile && $SUDO chmod 600 /swapfile && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi
free -h | sed -n 1,3p

step "tools: docker (image builds), k3s, helm"
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | $SUDO sh; }
command -v k3s >/dev/null || { curl -sfL https://get.k3s.io | $SUDO sh -s - --write-kubeconfig-mode 644; }
command -v helm >/dev/null || { curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash; }
for _ in $(seq 1 60); do kubectl get nodes 2>/dev/null | grep -q ' Ready' && break; sleep 2; done
kubectl get nodes

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  step "images (built here, imported into k3s's containerd)"
  bash scripts/fetch-store-assets.sh
  $SUDO docker build --provenance=false -t urumi/wordpress:$TAG images/wordpress
  for pkg in woo-mcp demo-upstream provisioner gateway; do
    $SUDO docker build --provenance=false -f images/node/Dockerfile --build-arg PKG=$pkg -t urumi/$pkg:$TAG .
  done
  $SUDO docker save urumi/wordpress:$TAG urumi/woo-mcp:$TAG urumi/demo-upstream:$TAG urumi/provisioner:$TAG urumi/gateway:$TAG \
    | $SUDO k3s ctr -n k8s.io images import -
  for img in wordpress woo-mcp demo-upstream provisioner gateway; do
    $SUDO k3s crictl images | grep -q "docker.io/urumi/$img .*$TAG" || { echo "urumi/$img:$TAG missing in k3s after import" >&2; exit 1; }
  done
fi

step "cert-manager $CERT_MANAGER + Let's Encrypt issuer (HTTP-01 through Traefik)"
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER/cert-manager.yaml" >/dev/null
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=300s
for _ in $(seq 1 30); do
  kubectl apply -f - <<EOF >/dev/null 2>&1 && break || sleep 5
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: $EMAIL
    privateKeySecretRef: { name: letsencrypt-prod-account }
    # ClusterIP: the solver's default NodePort Service is refused by the store namespaces' quota (services.nodeports: 0)
    solvers: [ { http01: { ingress: { ingressClassName: traefik, serviceType: ClusterIP } } } ]
EOF
done
kubectl get clusterissuer letsencrypt-prod

step "helm upgrade --install urumi (values-prod.yaml)"
args=(--set "baseDomain=$DOMAIN" --set tls.clusterIssuer=letsencrypt-prod --set images.pullPolicy=IfNotPresent)
for img in wordpress wooMcp:woo-mcp demoUpstream:demo-upstream provisioner gateway; do
  key=${img%%:*}; name=${img#*:}; args+=(--set "images.$key=urumi/$name:$TAG")
done
[ -n "${LLM_API_KEY:-}" ] && args+=(--set-string "gateway.llm.apiKey=$LLM_API_KEY")
[ -n "${LLM_BASE_URL:-}" ] && args+=(--set "gateway.llm.baseUrl=$LLM_BASE_URL")
[ -n "${LLM_MODEL:-}" ] && args+=(--set-string "gateway.llm.model=${LLM_MODEL//,/\\,}")  # a comma list = fallbacks
[ -n "${LLM_REASONING_EFFORT+x}" ] && args+=(--set-string "gateway.llm.reasoningEffort=$LLM_REASONING_EFFORT")
helm upgrade --install urumi charts/urumi -n $NS --create-namespace -f charts/urumi/values-prod.yaml "${args[@]}" --timeout 15m
# same image tag on a rebuild: restart so pods run the fresh import
[ "${SKIP_BUILD:-0}" != 1 ] && kubectl -n $NS rollout restart deploy/wordpress deploy/gateway deploy/woo-mcp deploy/demo-upstream deploy/provisioner >/dev/null
for d in mariadb wordpress postgres woo-mcp demo-upstream provisioner gateway; do kubectl -n $NS rollout status deploy/$d --timeout=600s; done

step "certificates (Let's Encrypt; usually under 2 minutes)"
for _ in $(seq 1 60); do
  kubectl -n $NS get certificate -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' | grep -qv True || break
  sleep 5
done
kubectl -n $NS get certificate

secret() { kubectl -n $NS get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
cat <<EOF

Ready.
  Dashboard + MCP : https://gateway.$DOMAIN   (MCP endpoint https://gateway.$DOMAIN/mcp)
  Storefront      : https://store.$DOMAIN/shop/
  Dashboard login : admin@urumi.local / $(secret gateway-app admin-password)
  WooCommerce     : https://store.$DOMAIN/wp-admin/  admin / $(secret store-app admin-password)
  Chat model      : $(kubectl -n $NS get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LLM_MODEL")].value}') (key set: $( [ "$(secret gateway-app llm-api-key)" = none ] && echo no || echo yes ))
EOF
