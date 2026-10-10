#!/usr/bin/env bash
# One command from a clean machine to a running local stack on k3d:
#   cluster (if missing) -> images (build + import) -> helm upgrade --install -> wait -> print URLs and logins.
# Usage: bash scripts/up.sh [--no-build]
# Needs: docker, k3d, helm, kubectl (k3d/helm also looked up in ~/bin). Optional: Ollama on the host for the chat agent.
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=${CLUSTER:-urumi-dev}; NS=${NS:-urumi}; CTX="k3d-$CLUSTER"
K3D=$(command -v k3d || echo ~/bin/k3d.exe); HELM=$(command -v helm || echo ~/bin/helm.exe)
BUILD=1; [ "${1:-}" = "--no-build" ] && BUILD=0
step() { printf '\n== %s\n' "$*"; }

step "cluster $CLUSTER"
if ! "$K3D" cluster list -o json | grep -q "\"name\":\"$CLUSTER\""; then
  # conntrack arg: k3s in Docker Desktop can't set nf_conntrack_max (kube-proxy crash loop otherwise)
  "$K3D" cluster create "$CLUSTER" --image rancher/k3s:v1.36.5-k3s1 -p "8080:80@loadbalancer" -p "8443:443@loadbalancer" \
    --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:*" --wait
else
  "$K3D" cluster start "$CLUSTER" >/dev/null 2>&1 || true
fi

if [ $BUILD = 1 ]; then
  step "images"
  bash scripts/fetch-store-assets.sh
  docker build -t urumi/wordpress:dev images/wordpress
  for pkg in woo-mcp demo-upstream gateway; do
    docker build -f images/node/Dockerfile --build-arg PKG=$pkg -t urumi/$pkg:dev .
  done
  for img in mariadb:11.4.13 postgres:18.6-alpine; do docker image inspect $img >/dev/null 2>&1 || docker pull $img; done
  "$K3D" image import -c "$CLUSTER" urumi/wordpress:dev urumi/woo-mcp:dev urumi/demo-upstream:dev urumi/gateway:dev mariadb:11.4.13 postgres:18.6-alpine
fi

step "helm upgrade --install urumi (values-local.yaml)"
"$HELM" upgrade --install urumi charts/urumi -n "$NS" --create-namespace --kube-context "$CTX" -f charts/urumi/values-local.yaml
# images keep their :dev tag across rebuilds, so restart to pick up a fresh import
[ $BUILD = 1 ] && kubectl --context "$CTX" -n "$NS" rollout restart deploy/gateway deploy/woo-mcp deploy/demo-upstream >/dev/null
for d in mariadb wordpress postgres woo-mcp demo-upstream gateway; do
  kubectl --context "$CTX" -n "$NS" rollout status deploy/$d --timeout=300s
done

step "ready"
secret() { kubectl --context "$CTX" -n "$NS" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }
cat <<EOF
Dashboard + MCP gateway : http://gateway.127.0.0.1.nip.io:8080   (MCP endpoint: /mcp)
  admin login           : admin@urumi.local / $(secret gateway-app admin-password)
Storefront              : http://store.127.0.0.1.nip.io:8080/shop/
  WooCommerce admin     : http://store.127.0.0.1.nip.io:8080/wp-admin/  admin / $(secret store-app admin-password)
Chat LLM                : Ollama at http://host.k3d.internal:11434/v1 (model qwen3.5-agent); see README to change
Check everything        : bash scripts/demo-check.sh
EOF
