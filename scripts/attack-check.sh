#!/usr/bin/env bash
# Adversarial checks against the deployed chart: authentication and sessions, authorization (what a member must not
# be able to do), input validation, secret exposure, the MCP endpoint's guards, rug pulls, upstream failure modes.
# Complements demo-check.sh (the happy path). Re-runnable; cleans up what it creates.
# Usage: bash scripts/attack-check.sh            Env: CTX, NS, GW
set -u
export PYTHONIOENCODING=utf-8
cd "$(dirname "$0")/.."
CTX=${CTX:-k3d-urumi-dev}; NS=${NS:-urumi}; G=${GW:-http://gateway.127.0.0.1.nip.io:8080}
K="kubectl --context $CTX -n $NS"
NODE="fnm exec --using=24.21.0 node"
TMP=$(mktemp -d); command -v cygpath >/dev/null && TMP=$(cygpath -m "$TMP"); pass=0; fail=0; t0=$(date +%s)
ok()  { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
py()  { python -c "$@"; }
jget() { py "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
# req <jar|-> <csrf|-> <method> <path> [body] -> "<status> <body>" (body saved to $TMP/body)
req() {
  local jar=$1 csrf=$2 m=$3 p=$4 b=${5-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$m" -H 'content-type: application/json')
  [ "$jar" != - ] && args+=(-b "$jar" -c "$jar")
  [ "$csrf" != - ] && args+=(-H "x-csrf-token: $csrf")
  [ -n "$b" ] && args+=(--data-binary "$b")
  curl "${args[@]}" "$G/api$p"
}
is() { local want=$1 got=$2 label=$3; [ "$got" = "$want" ] && ok "$label ($got)" || bad "$label (want $want, got $got: $(head -c 160 "$TMP/body"))"; }
login() { curl -s -c "$3" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" "$G/api/auth/login" | jget 'd.get("csrf","")' 2>/dev/null; }
mcp() { local a=${3:-}; [ -n "$a" ] || a='{}'; $NODE scripts/mcp-call.mjs "$G/mcp" "$2" "$a" "$1" >"$TMP/mcp.out" 2>&1; echo $?; }
rpc() { # rpc <key> <json> [extra curl args] -> status (body in $TMP/body)
  local k=$1 j=$2; shift 2
  curl -s -o "$TMP/body" -w '%{http_code}' -H "Authorization: Bearer $k" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' "$@" -d "$j" "$G/mcp"
}
sid() { req "$TMP/admin" "$ACSRF" GET /servers >/dev/null; jget "next((x['id'] for x in d if x['slug']=='$1'), '')" < "$TMP/body"; }
mid() { req "$TMP/admin" "$ACSRF" GET /members >/dev/null; jget "next((x['id'] for x in d if x['email']=='$1'), '')" < "$TMP/body"; }
# newmember <email> <role> -> sets NEWPW (temporary password)
newmember() { local id; id=$(mid "$1"); [ -n "$id" ] && req "$TMP/admin" "$ACSRF" DELETE "/members/$id" >/dev/null
  req "$TMP/admin" "$ACSRF" POST /members "{\"email\":\"$1\",\"name\":\"t\",\"role\":\"$2\"}" >/dev/null; NEWPW=$(jget 'd["password"]' < "$TMP/body"); }

APW=$($K get secret gateway-app -o jsonpath='{.data.admin-password}' | base64 -d)
ACSRF=$(login admin@urumi.local "$APW" "$TMP/admin"); [ -n "$ACSRF" ] || { echo "admin login failed"; exit 1; }

echo "== A. authentication and sessions"
is 401 "$(req - - GET /servers)" "no session -> 401"
is 403 "$(req "$TMP/admin" - POST /keys '{"name":"x"}')" "admin cookie but no CSRF header -> 403"
is 403 "$(req "$TMP/admin" wrong POST /keys '{"name":"x"}')" "wrong CSRF token -> 403"
is 401 "$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'content-type: application/json' -d '{"email":"nobody@x.y","password":"whatever-123"}' "$G/api/auth/login")" "unknown email -> 401 (same answer as a wrong password)"
newmember brute@urumi.local member
codes=""; for i in $(seq 1 12); do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d '{"email":"brute@urumi.local","password":"wrong-guess-'$i'"}' "$G/api/auth/login")"; done
echo "$codes" | grep -q 429 && ok "password guessing is throttled (codes:$codes)" || bad "no 429 after 12 wrong passwords (codes:$codes)"
is 429 "$(curl -s -o "$TMP/body" -w '%{http_code}' -H 'content-type: application/json' -d "{\"email\":\"brute@urumi.local\",\"password\":\"$NEWPW\"}" "$G/api/auth/login")" "even the right password waits while the account is throttled"

newmember mallory@urumi.local member; MPW=$NEWPW
MC=$(login mallory@urumi.local "$MPW" "$TMP/m")
is 403 "$(req "$TMP/m" "$MC" GET /servers)" "temporary password: everything but changing it -> 403"
is 403 "$(req "$TMP/m" "$MC" POST /keys '{"name":"k"}')" "temporary password: cannot create keys"
is 403 "$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$TMP/m" -H "x-csrf-token: $MC" -H 'content-type: application/json' -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"hi"}]}]}' "$G/api/chat")" "temporary password: no chat"
is 403 "$(req "$TMP/m" "$MC" POST /auth/password '{"current":"wrong","password":"mallory-long-password"}')" "password change with a wrong current password -> 403"
is 400 "$(req "$TMP/m" "$MC" POST /auth/password "{\"current\":\"$MPW\",\"password\":\"short\"}")" "too-short new password -> 400"
MC2=$(login mallory@urumi.local "$MPW" "$TMP/m2")
is 204 "$(req "$TMP/m" "$MC" POST /auth/password "{\"current\":\"$MPW\",\"password\":\"mallory-long-password\"}")" "password changed"
is 200 "$(req "$TMP/m" "$MC" GET /servers)" "the changing session keeps working"
is 401 "$(req "$TMP/m2" "$MC2" GET /servers)" "the user's other sessions end on a password change"
MID=$(mid mallory@urumi.local)
req "$TMP/admin" "$ACSRF" POST "/members/$MID/reset-password" >/dev/null; RPW=$(jget 'd["password"]' < "$TMP/body")
is 401 "$(req "$TMP/m" "$MC" GET /servers)" "admin reset ends the member's sessions"
MC=$(login mallory@urumi.local "$RPW" "$TMP/m")
is 403 "$(req "$TMP/m" "$MC" GET /servers)" "the reset password is temporary too"
req "$TMP/m" "$MC" POST /auth/password "{\"current\":\"$RPW\",\"password\":\"mallory-long-password-2\"}" >/dev/null

echo "== B. what a member must not be able to do"
DEMO=$(sid demo); AID=$(mid admin@urumi.local)
is 403 "$(req "$TMP/m" "$MC" POST /servers '{"name":"x","slug":"xx","url":"https://example.com/mcp"}')" "member: add a server"
is 403 "$(req "$TMP/m" "$MC" PATCH "/servers/$DEMO" '{"enabled":false}')" "member: disable a server"
is 403 "$(req "$TMP/m" "$MC" DELETE "/servers/$DEMO")" "member: delete a server"
is 403 "$(req "$TMP/m" "$MC" PUT "/servers/$DEMO/tools/echo/access" '{"access":"off"}')" "member: change tool access"
is 403 "$(req "$TMP/m" "$MC" POST "/servers/$DEMO/tools/echo/approve")" "member: approve a tool definition"
is 403 "$(req "$TMP/m" "$MC" POST /members '{"email":"evil@x.y","role":"admin"}')" "member: invite (an admin)"
is 403 "$(req "$TMP/m" "$MC" PATCH "/members/$MID" '{"role":"admin"}')" "member: promote themselves"
is 403 "$(req "$TMP/m" "$MC" POST "/members/$AID/reset-password")" "member: reset the admin's password"
is 403 "$(req "$TMP/m" "$MC" POST /keys "{\"name\":\"k\",\"userId\":$AID}")" "member: issue a key for the admin"
req "$TMP/admin" "$ACSRF" POST /keys '{"name":"admin-attack"}' >/dev/null; AKEY=$(jget 'd["secret"]' < "$TMP/body"); AKID=$(jget 'd["key"]["id"]' < "$TMP/body")
is 404 "$(req "$TMP/m" "$MC" DELETE "/keys/$AKID")" "member: revoke someone else's key (not found for them)"
req "$TMP/m" "$MC" GET '/keys?all=1' >/dev/null; n=$(jget "sum(1 for k in d if k['userEmail']!='mallory@urumi.local')" < "$TMP/body")
[ "$n" = 0 ] && ok "member: ?all=1 still lists only their own keys" || bad "member sees $n other keys"
req "$TMP/m" "$MC" GET '/audit?user=admin@urumi.local' >/dev/null; n=$(jget "sum(1 for i in d['items'] if i['userEmail']!='mallory@urumi.local')" < "$TMP/body")
[ "$n" = 0 ] && ok "member: audit shows only their own calls, even when filtering for another user" || bad "member sees $n audit rows of others"
req "$TMP/m" "$MC" POST /keys '{"name":"mallory-k"}' >/dev/null; MKEY=$(jget 'd["secret"]' < "$TMP/body")
is 201 "$(req "$TMP/admin" "$ACSRF" POST /keys "{\"name\":\"for-mallory\",\"userId\":$MID}")" "admin issues a key for a member"
[ "$(jget 'd["key"]["userEmail"]' < "$TMP/body")" = mallory@urumi.local ] && ok "that key belongs to the member" || bad "issued key owner: $(head -c 120 "$TMP/body")"

echo "== C. input validation (never a 500)"
is 404 "$(req "$TMP/admin" "$ACSRF" PATCH /servers/abc '{"enabled":true}')" "non-numeric server id"
is 404 "$(req "$TMP/admin" "$ACSRF" DELETE /servers/99999999)" "unknown server id"
is 404 "$(req "$TMP/admin" "$ACSRF" DELETE /members/1e3)" "malformed member id"
is 404 "$(req "$TMP/admin" "$ACSRF" DELETE '/keys/-1')" "negative key id"
is 200 "$(req "$TMP/admin" "$ACSRF" GET '/audit?limit=-5')" "audit with a negative limit"
is 400 "$(req "$TMP/admin" "$ACSRF" GET '/audit?before=abc')" "audit with a malformed cursor"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{not json')" "malformed JSON body"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"inj1","url":"http://demo-upstream/mcp","credential":"Bearer a\r\nX-Evil: 1"}')" "credential with a line break (header injection)"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"inj2","url":"http://demo-upstream/mcp","authHeader":"Host","credential":"evil.example"}')" "credential header 'Host' is reserved"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"inj3","url":"https://user:pass@example.com/mcp"}')" "URL with user:password@"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"inj4","url":"javascript:alert(1)"}')" "javascript: URL"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"inj5","url":"file:///etc/passwd"}')" "file: URL"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"Bad_Slug","url":"https://example.com/mcp"}')" "invalid slug"
is 400 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"gateway","url":"https://example.com/mcp"}')" "reserved slug 'gateway'"
is 409 "$(req "$TMP/admin" "$ACSRF" POST /servers '{"name":"x","slug":"demo","url":"https://example.com/mcp"}')" "duplicate slug"
for i in 1 2 3; do req "$TMP/admin" "$ACSRF" POST /servers '{"name":"race","slug":"race-dup","url":"http://demo-upstream/mcp"}' > "$TMP/race$i" & done; wait
codes=$(cat "$TMP"/race1 "$TMP"/race2 "$TMP"/race3 | tr -d '\n' | fold -w3 | sort | tr '\n' ' ')
[ "$codes" = "201 409 409 " ] && ok "3 concurrent adds of one slug: one 201, two 409 ($codes)" || bad "concurrent adds: $codes"
RD=$(sid race-dup); [ -n "$RD" ] && req "$TMP/admin" "$ACSRF" DELETE "/servers/$RD" >/dev/null
big=$(py "print('{\"name\":\"' + 'x'*300000 + '\"}')")
is 413 "$(printf '%s' "$big" > "$TMP/big.json"; curl -s -o "$TMP/body" -w '%{http_code}' -b "$TMP/admin" -H "x-csrf-token: $ACSRF" -H 'content-type: application/json' --data-binary @"$TMP/big.json" "$G/api/keys")" "300 KB API body -> 413"
py "import json; print(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'demo__echo','arguments':{'message':'x'*5000000}}}))" > "$TMP/big-mcp.json"
c=$(curl -s -o "$TMP/body" -w '%{http_code}' -H "Authorization: Bearer $AKEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary @"$TMP/big-mcp.json" "$G/mcp")
# refused unread: 413, or the connection closes mid-upload (curl reports the 100-continue, or Traefik a 502)
{ [ "$c" = 413 ] || [ "$c" = 100 ] || [ "$c" = 502 ]; } && ok "5 MB MCP body refused ($c)" || bad "5 MB MCP body: $c"
c=$(curl -s -o /dev/null -w '%{http_code}' "$G/api/info"); is 200 "$c" "the next request through the proxy is unaffected (no 502 from a reused connection)"
is 400 "$(curl -s -o "$TMP/body" -w '%{http_code}' -b "$TMP/admin" -H "x-csrf-token: $ACSRF" -H 'content-type: application/json' -d '{oops' "$G/api/chat")" "chat with malformed JSON -> 400"

echo "== D. secrets never leave the gateway"
req "$TMP/admin" "$ACSRF" POST /servers '{"name":"Leak test","slug":"leak","url":"http://demo-upstream/mcp?api_key=QS-CANARY-1","credential":"Bearer HDR-CANARY-2"}' >/dev/null
LK=$(sid leak)
req "$TMP/admin" "$ACSRF" GET /servers >/dev/null; grep -q 'QS-CANARY-1' "$TMP/body" && ok "admin sees the full URL (they entered it)" || bad "admin URL redacted"
grep -q 'HDR-CANARY-2' "$TMP/body" && bad "credential in the admin's server list" || ok "credential not in the admin's server list"
req "$TMP/m" "$MC" GET /servers >/dev/null; grep -qE 'QS-CANARY-1|HDR-CANARY-2' "$TMP/body" && bad "member sees a secret: $(grep -o '.\{40\}CANARY.\{10\}' "$TMP/body" | head -2)" || ok "member's server list: no query-string key, no credential"
req "$TMP/m" "$MC" GET "/servers/$LK/events" >/dev/null; grep -qE 'QS-CANARY-1|HDR-CANARY-2' "$TMP/body" && bad "member sees a secret in status history" || ok "member's status history: no secrets"
mcp "$MKEY" --list >/dev/null; grep -qE 'CANARY' "$TMP/mcp.out" && bad "secret in tools/list" || ok "tools/list carries no upstream secret"
is 400 "$(req "$TMP/admin" "$ACSRF" PATCH "/servers/$LK" '{"url":"https://example.com/mcp"}')" "moving a server with a credential to another host needs the credential re-entered"
n=$($K exec deploy/postgres -- psql -U urumi -d urumi -tAc "select count(*) from upstreams where credential like '%CANARY%'")
[ "$n" = 0 ] && ok "credential encrypted at rest (no plaintext in Postgres)" || bad "plaintext credential in the database"
req "$TMP/admin" "$ACSRF" DELETE "/servers/$LK" >/dev/null

echo "== E. the MCP endpoint's guards"
is 401 "$(rpc '' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'Authorization:')" "no token -> 401"
grep -qi 'www-authenticate' <(curl -s -D - -o /dev/null -X POST "$G/mcp") && ok "401 carries a WWW-Authenticate challenge" || bad "no WWW-Authenticate on 401"
is 401 "$(rpc urumi_not-a-real-key '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" "made-up key -> 401"
# a foreign Host never gets past Traefik (no route); check the gateway's own guard from inside its pod
h=$($K exec deploy/gateway -- node -e "const r=require('http').request({host:'127.0.0.1',port:8080,path:'/mcp',method:'POST',headers:{host:'evil.example',authorization:'Bearer $MKEY','content-type':'application/json',accept:'application/json, text/event-stream'}},x=>console.log(x.statusCode));r.end('{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}')")
is 403 "$h" "foreign Host header (DNS rebinding) -> 403 at the gateway"
is 404 "$(rpc "$MKEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'Host: evil.example')" "...and Traefik has no route for it at all"
is 403 "$(rpc "$MKEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'Origin: http://evil.example')" "foreign browser Origin -> 403"
is 403 "$(rpc "$MKEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -H 'Origin: null')" "Origin: null (sandboxed iframe) -> 403"
r=$(mcp "$MKEY" store__does_not_exist '{}'); [ "$r" = 5 ] && grep -q 'does not exist' "$TMP/mcp.out" && ok "unknown tool -> clear isError" || bad "unknown tool: exit $r $(head -c 120 "$TMP/mcp.out")"
r=$(mcp "$MKEY" no_slug_tool '{}'); [ "$r" = 5 ] && ok "tool name without a server prefix -> clear isError" || bad "no-slug tool: exit $r"
# shared rate limit: one fresh key, 70 quick requests across both replicas (burst 40 + refill 2/s)
req "$TMP/m" "$MC" POST /keys '{"name":"rate"}' >/dev/null; RKEY=$(jget 'd["secret"]' < "$TMP/body"); RKID=$(jget 'd["key"]["id"]' < "$TMP/body")
for i in $(seq 1 70); do curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $RKEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$G/mcp" & done > "$TMP/rate" ; wait
okn=$(grep -c '^200' "$TMP/rate"); lim=$(grep -c '^429' "$TMP/rate")
[ "$lim" -ge 20 ] && [ "$okn" -le 48 ] && ok "rate limit is shared by the replicas ($okn allowed, $lim got 429, burst 40)" || bad "rate limit: $okn allowed, $lim limited"
req "$TMP/m" "$MC" DELETE "/keys/$RKID" >/dev/null
DIS=$(mid brute@urumi.local); req "$TMP/admin" "$ACSRF" POST /keys "{\"name\":\"brute-k\",\"userId\":$DIS}" >/dev/null; BKEY=$(jget 'd["secret"]' < "$TMP/body")
req "$TMP/admin" "$ACSRF" PATCH "/members/$DIS" '{"disabled":true}' >/dev/null
is 401 "$(rpc "$BKEY" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" "a disabled member's key -> 401"
grep -q 'revoked\|disabled' "$TMP/body" && ok "the 401 says why" || bad "401 body: $(head -c 120 "$TMP/body")"

echo "== F. rug pull by addition: a tool that appears after approval"
NT=purge_cache_$RANDOM   # a new name each run (a tool that comes back with its approved definition is allowed again)
$K set env deploy/demo-upstream EXTRA_TOOL=$NT >/dev/null; $K rollout status deploy/demo-upstream --timeout=90s >/dev/null
for _ in $(seq 1 60); do req "$TMP/admin" "$ACSRF" GET /servers >/dev/null; jget "[t for s in d if s['slug']=='demo' for t in s['tools'] if t['name']=='$NT']" < "$TMP/body" | grep -q purge && break; sleep 0.5; done
st=$(jget "next((t.get('change'), t.get('changed')) for s in d if s['slug']=='demo' for t in s['tools'] if t['name']=='$NT')" < "$TMP/body")
[ "$st" = "('new', True)" ] && ok "new tool flagged for review ($st)" || bad "new tool state: $st"
sleep 1; mcp "$MKEY" --list >/dev/null; grep -q "^demo__$NT" "$TMP/mcp.out" && bad "unapproved new tool listed" || ok "unapproved new tool hidden from tools/list"
r=$(mcp "$MKEY" demo__$NT '{}'); [ "$r" = 5 ] && grep -q 'not yet approved' "$TMP/mcp.out" && ok "calling it is rejected (quarantined)" || bad "new tool call: exit $r $(head -c 120 "$TMP/mcp.out")"
req "$TMP/admin" "$ACSRF" POST "/servers/$DEMO/tools/$NT/approve" >/dev/null
for _ in $(seq 1 20); do mcp "$MKEY" --list >/dev/null; grep -q "^demo__$NT" "$TMP/mcp.out" && break; sleep 0.5; done
grep -q "^demo__$NT" "$TMP/mcp.out" && ok "after approval it is listed" || bad "approved tool not listed"
$K set env deploy/demo-upstream EXTRA_TOOL- >/dev/null; $K rollout status deploy/demo-upstream --timeout=90s >/dev/null

echo "== G. upstream failure modes"
req "$TMP/admin" "$ACSRF" POST /servers '{"name":"Crypto test","slug":"cryptotest","url":"http://demo-upstream/mcp","credential":"Bearer x"}' >/dev/null; CT=$(sid cryptotest)
$K exec deploy/postgres -- psql -U urumi -d urumi -qtAc "update upstreams set credential='v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' where slug='cryptotest'" >/dev/null
$K rollout restart deploy/gateway >/dev/null; $K rollout status deploy/gateway --timeout=180s >/dev/null && ok "gateway restarts fine with an undecryptable credential in the database" || bad "gateway rollout failed"
ACSRF=$(login admin@urumi.local "$APW" "$TMP/admin")
# old pods finish their requests while terminating: poll until both new replicas answer
for _ in $(seq 1 30); do req "$TMP/admin" "$ACSRF" GET /servers >/dev/null
  st=$(jget "next((s['status'], s['lastError'] or '') for s in d if s['slug']=='cryptotest')" < "$TMP/body"); echo "$st" | grep -q decrypt && break; sleep 1; done
echo "$st" | grep -q "auth_failed.*decrypt" && ok "that server shows auth_failed with the reason" || bad "undecryptable server: $st"
st=$(jget "next(s['status'] for s in d if s['slug']=='store')" < "$TMP/body"); [ "$st" = connected ] && ok "other servers unaffected (store $st)" || bad "store is $st"
is 200 "$(req "$TMP/admin" "$ACSRF" PATCH "/servers/$CT" '{"timeoutMs":5000}')" "set a per-server timeout"
is 200 "$(req "$TMP/admin" "$ACSRF" PATCH "/servers/$CT" '{"timeoutMs":null}')" "reset it to the default"
[ "$(jget 'd["timeoutMs"]' < "$TMP/body")" = None ] && ok "timeout back to default (null)" || bad "timeout: $(jget 'd["timeoutMs"]' < "$TMP/body")"
req "$TMP/admin" "$ACSRF" DELETE "/servers/$CT" >/dev/null

echo "== H. dashboard response headers"
h=$(curl -s -D - -o /dev/null "$G/")
echo "$h" | grep -qi "content-security-policy:.*frame-ancestors 'none'" && ok "CSP with frame-ancestors 'none'" || bad "no CSP"
echo "$h" | grep -qi 'x-frame-options: DENY' && ok "X-Frame-Options: DENY" || bad "no X-Frame-Options"
echo "$h" | grep -qi 'x-content-type-options: nosniff' && ok "nosniff" || bad "no nosniff"
is 404 "$(curl -s -o "$TMP/body" -w '%{http_code}' "$G/oauth/nothing-here")" "unknown /oauth path is a JSON 404, not the SPA"

# cleanup
for e in brute@urumi.local mallory@urumi.local; do id=$(mid $e); [ -n "$id" ] && req "$TMP/admin" "$ACSRF" DELETE "/members/$id" >/dev/null; done
req "$TMP/admin" "$ACSRF" DELETE "/keys/$AKID" >/dev/null
rm -rf "$TMP"
echo "RESULT: $pass passed, $fail failed in $(( $(date +%s)-t0 ))s"; [ $fail -eq 0 ]
