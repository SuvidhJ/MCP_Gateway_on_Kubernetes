#!/usr/bin/env bash
# E16: scripted Definition-of-Done check against the in-cluster spike (Traefik -> spike-gateway -> upstreams).
# Uses the Inspector CLI (2.10.1) exit codes: 0 ok, 3 auth, 4 unreachable, 5 tool error/not found.
# Usage: ./demo-check.sh [gatewayBase]   (spike: admin endpoints are unauthenticated; the product uses the dashboard API)
set -u
BASE=${1:-http://gw.127.0.0.1.nip.io:8080}; U="$BASE/mcp"
INSP="fnm exec --using=24.21.0 node $(dirname "$0")/node_modules/@modelcontextprotocol/inspector/clients/cli/build/index.js"
pass=0; fail=0; t0=$(date +%s)
ok()   { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
insp() { local key=$1; shift; $INSP "$U" --header "Authorization: Bearer $key" --stored-auth-only "$@" >/tmp/dc.out 2>/tmp/dc.err; echo $?; }
expect() { local want=$1 label=$2; shift 2; local got; got=$(insp "$@"); [ "$got" = "$want" ] && ok "$label (exit $got)" || bad "$label (want exit $want, got $got: $(head -c 160 /tmp/dc.err))"; }
state() { curl -s "$BASE/admin/state" | python -c "import json,sys; d={u['slug']:u['status'] for u in json.load(sys.stdin)}; print(d.get(sys.argv[1],'absent'))" "$1"; }
waitfor() { local slug=$1 want=$2 secs=$3 s=$(date +%s%N); for _ in $(seq 1 $((secs*5))); do [ "$(state $slug)" = "$want" ] && { echo $(( ($(date +%s%N)-s)/1000000 )); return 0; }; sleep 0.2; done; echo -1; }

echo "== 1. user A sees tools from every enabled server"
insp k1 --method tools/list >/dev/null; n_store=$(grep -c '"name": "store__' /tmp/dc.out); n_dw=$(grep -c '"name": "deepwiki__' /tmp/dc.out)
[ "$n_store" -ge 5 ] && [ "$n_dw" -ge 1 ] && ok "tools/list has store__ ($n_store) and deepwiki__ ($n_dw)" || bad "tools/list store=$n_store deepwiki=$n_dw"
echo "== 2. orders question works (store__list_orders)"
expect 0 "store__list_orders as A" k1 --method tools/call --tool-name store__list_orders --tool-arg 'status=["processing","on-hold","completed"]'
echo "== 3. user B (member key) can call too"
expect 0 "store__list_orders as B" k2 --method tools/call --tool-name store__list_orders
echo "== 4. cross-server: deepwiki + store in one session"
expect 0 "deepwiki__read_wiki_structure" k1 --method tools/call --tool-name deepwiki__read_wiki_structure --tool-arg repoName=woocommerce/woocommerce
echo "== 5. revoke B -> next call rejected"
curl -s "$BASE/admin/revoke?key=k2" >/dev/null
expect 3 "B after revoke is rejected" k2 --method tools/list
expect 0 "A unaffected by B's revocation" k1 --method tools/list
echo "== 6. disable deepwiki -> tools disappear for everyone"
curl -s "$BASE/admin/disable?slug=deepwiki" >/dev/null
insp k1 --method tools/list >/dev/null; grep -q '"name": "deepwiki__' /tmp/dc.out && bad "deepwiki tools still listed after disable" || ok "deepwiki tools gone from tools/list"
expect 5 "calling a disabled server's tool fails" k1 --method tools/call --tool-name deepwiki__read_wiki_structure --tool-arg repoName=x/y
echo "== 7. kill an upstream pod (scale demo-upstream to 0) -> others keep working, status unreachable"
kubectl -n exp scale deploy/demo-upstream --replicas=0 >/dev/null
ms=$(waitfor demo unreachable 20); [ "$ms" -ge 0 ] && ok "dashboard status demo=unreachable after ${ms}ms" || bad "demo never became unreachable"
expect 0 "store still works while demo is dead" k1 --method tools/call --tool-name store__list_products
kubectl -n exp scale deploy/demo-upstream --replicas=1 >/dev/null
ms=$(waitfor demo connected 60); [ "$ms" -ge 0 ] && ok "demo back to connected ${ms}ms after scale-up" || bad "demo did not recover"
echo "== cleanup (idempotent re-runs)"
curl -s "$BASE/admin/unrevoke?key=k2" >/dev/null; curl -s "$BASE/admin/enable?slug=deepwiki" >/dev/null
echo "RESULT: $pass passed, $fail failed in $(( $(date +%s)-t0 ))s"; [ $fail -eq 0 ]
