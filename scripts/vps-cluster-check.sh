#!/usr/bin/env bash
# Cluster-side checks for a VPS install (run on the VM; needs only kubectl and curl): what the remote suites can't
# see from outside. Workload health, requests/limits and probes, nothing exposed except through the ingress, TLS,
# storage, NetworkPolicy enforcement (tried from a throwaway pod), credentials at rest, a dead upstream, Helm history.
# Usage: bash scripts/vps-cluster-check.sh        Env: NS (default urumi), KUBECONFIG (default k3s), GW (gateway URL)
set -u
export KUBECONFIG=${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}
NS=${NS:-urumi}; K="kubectl -n $NS"; pass=0; fail=0
ok()  { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
sql() { $K exec deploy/postgres -- psql -U urumi -d urumi -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

echo "== 1. workloads"
notready=$($K get deploy -o jsonpath='{range .items[*]}{.metadata.name}={.status.readyReplicas}/{.spec.replicas}{"\n"}{end}' | awk -F'[=/]' '$2!=$3')
[ -z "$notready" ] && ok "every Deployment fully ready ($($K get deploy --no-headers | wc -l) deployments)" || bad "not ready: $notready"
restarts=$($K get pods -o jsonpath='{range .items[*]}{.metadata.name} {range .status.containerStatuses[*]}{.restartCount} {end}{"\n"}{end}' | awk '{s=0; for(i=2;i<=NF;i++) s+=$i; if(s>0) print $1"="s}')
[ -z "$restarts" ] && ok "no container restarts" || echo "  note  restarts (expected after deliberate kills): $(echo $restarts)"

echo "== 2. requests, limits and probes on every long-running container"
miss=$($K get deploy -o jsonpath='{range .items[*]}{range .spec.template.spec.containers[*]}{.name}|{.resources.requests.cpu}|{.resources.requests.memory}|{.resources.limits.cpu}|{.resources.limits.memory}|{.readinessProbe.periodSeconds}{.readinessProbe.httpGet.path}{.readinessProbe.exec.command[0]}{.readinessProbe.tcpSocket.port}|{.livenessProbe.periodSeconds}{.livenessProbe.httpGet.path}{.livenessProbe.exec.command[0]}{.livenessProbe.tcpSocket.port}{"\n"}{end}{end}' | awk -F'|' '$2==""||$3==""||$4==""||$5==""||$6==""||$7=="" {print $1}')
[ -z "$miss" ] && ok "requests + limits + readiness + liveness everywhere" || bad "missing on: $miss"
root=$($K get pods -o jsonpath='{range .items[*]}{.metadata.name} {.spec.securityContext.runAsNonRoot}{range .spec.containers[*]}{.securityContext.runAsNonRoot}{end}{"\n"}{end}' | grep -v true || true)
[ -z "$root" ] && ok "every pod runs as non-root" || bad "may run as root: $root"

echo "== 3. exposure: only the ingress is public"
svc=$($K get svc -o jsonpath='{range .items[*]}{.metadata.name}:{.spec.type}{"\n"}{end}' | grep -v ':ClusterIP$' || true)
[ -z "$svc" ] && ok "all Services are ClusterIP (no NodePort/LoadBalancer in $NS)" || bad "non-ClusterIP services: $svc"
echo "  info  ingress hosts: $($K get ingress -o jsonpath='{range .items[*]}{.spec.rules[*].host} {end}')"
certs=$(kubectl get certificate -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}={.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}')
echo "$certs" | grep -qv '=True$' && bad "certificates not ready: $(echo "$certs" | grep -v '=True$')" || ok "all certificates Ready ($(echo "$certs" | grep -c .))"
for h in $($K get ingress -o jsonpath='{range .items[*]}{.spec.rules[*].host} {end}'); do
  code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 "http://$h/")
  case "$code" in 30[178]\ https://*) ok "http://$h redirects to HTTPS";; *) bad "http://$h -> $code";; esac
done

echo "== 4. storage"
pvc=$($K get pvc -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}({.spec.resources.requests.storage}) {end}')
echo "$pvc" | grep -q 'Pending\|Lost' && bad "PVCs: $pvc" || ok "PVCs bound: $pvc"

echo "== 5. NetworkPolicies, tried from a throwaway pod (no labels the policies allow)"
img=$($K get deploy postgres -o jsonpath='{.spec.template.spec.containers[0].image}')
out=$($K run netprobe-$RANDOM --rm -i --restart=Never --image="$img" --quiet \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":70,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"'"$img"'","command":["sh","-c","for t in woo-mcp:80 demo-upstream:80 mariadb:3306 postgres:5432 gateway:9091; do h=${t%:*}; p=${t#*:}; if nc -z -w 3 $h $p 2>/dev/null; then echo OPEN $t; else echo blocked $t; fi; done"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}' 2>&1)
echo "$out" | sed 's/^/        /'
[ "$(echo "$out" | grep -c '^blocked')" = 5 ] && ok "an unlabelled pod reaches none of woo-mcp, demo-upstream, MariaDB, Postgres, metrics" || bad "network policy gap"
via=$($K exec deploy/gateway -- node -e "require('net').connect(80,'woo-mcp').on('connect',()=>{console.log('ok');process.exit()}).on('error',e=>{console.log(e.code);process.exit()})" 2>&1)
[ "$via" = ok ] && ok "the gateway does reach woo-mcp (the one allowed path)" || bad "gateway -> woo-mcp: $via"
code=$($K exec deploy/gateway -- node -e "fetch('http://woo-mcp/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))" 2>&1)
[ "$code" = 401 ] && ok "woo-mcp still demands the gateway's token (401 without it)" || bad "woo-mcp without token: $code"

echo "== 6. credentials at rest"
n=$(sql "select count(*) from upstreams where credential is not null and credential not like 'v1.%'")
[ "$n" = 0 ] && ok "every stored upstream credential is sealed (v1. AES-256-GCM)" || bad "$n unsealed credentials"
n=$(sql "select count(*) from api_keys where hash like 'urumi_%'")
[ "$n" = 0 ] && ok "API keys stored as hashes only" || bad "$n API keys look like plaintext"

echo "== 7. a dead upstream: delete the demo-upstream pod"
APW=$($K get secret gateway-app -o jsonpath='{.data.admin-password}' | base64 -d)
GW=${GW:-https://$($K get ingress gateway -o jsonpath="{.spec.rules[0].host}")}; jar=$(mktemp)
csrf=$(curl -s -c "$jar" "$GW/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"admin@urumi.local\",\"password\":\"$APW\"}" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')
st() { curl -s -b "$jar" "$GW/api/servers" | tr '{' '\n' | grep '"slug":"demo"' | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p'; }
$K delete pod -l app=demo-upstream --wait=false >/dev/null; t0=$(date +%s%N); seen=""
for _ in $(seq 1 40); do s=$(st); [ "$s" != connected ] && [ -n "$s" ] && { seen=$s; break; }; sleep 0.25; done
[ -n "$seen" ] && ok "dashboard shows demo '$seen' $(( ($(date +%s%N)-t0)/1000000 )) ms after the kill" || bad "demo never left 'connected'"
for _ in $(seq 1 60); do [ "$(st)" = connected ] && break; sleep 1; done
[ "$(st)" = connected ] && ok "demo back to connected (new pod)" || bad "demo did not recover: $(st)"
rm -f "$jar"

echo "== 8. Helm"
helm -n "$NS" history urumi --max 5 2>/dev/null | sed 's/^/        /'
helm -n "$NS" status urumi 2>/dev/null | grep -q 'STATUS: deployed' && ok "release urumi deployed" || bad "release not in deployed state"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" = 0 ]
