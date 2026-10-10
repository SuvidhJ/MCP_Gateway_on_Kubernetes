# experiments/ (round 6 spikes)

Throwaway code used to run experiments E1–E17 (+ Helm probe, DoD walk) on 2026-10-10. Results and their meaning live
in [`planning/07-experiment-results.md`](../planning/07-experiment-results.md). **This is not the product.** It's
the evidence behind the product decisions, and a source of verified snippets (SSRF guard, error classifier, WC REST
calls, bootstrap steps, DoD script).

## Layout

| Path | What it is | Used by |
|---|---|---|
| `spike/upstream.mjs` | Dual-era test MCP server (`echo`, `slow`, `search`, `fail`, `whoami`); `MODE=stateful` = legacy sessionful | E1, E3, E13, E14, E17 |
| `spike/gateway.mjs` | Spike gateway: `createMcpHandler` + low-level `Server`, API-key gate (`AUTH_STYLE`), request/audit log, per-upstream SDK clients (`auto`), fetch deadlines, SSRF guard + 2 s connect timeout, failure classifier, per-upstream health loops with fast retry, 404 re-init, admin endpoints (`/admin/state|revoke|unrevoke|disable|enable|notify|mem`) | all |
| `spike/woo-mcp.mjs` | 5 WooCommerce tools over WC REST (Basic + `X-Forwarded-Proto`, `?rest_route=`, `_fields`, `*_gmt+'Z'` dates, error mapping) | E5, DoD walk, E8 |
| `spike/ssrf-guard.mjs` | undici Agent that validates the dialled address (literals + every DNS answer), allow-list for in-cluster names | E15, gateway |
| `spike/client-test.mjs` | Downstream SDK client in `legacy`/`auto` mode; exercises routing/errors | E1, E12 |
| `spike/compliance.sh` | 18 raw curl wire checks against the gateway | wire compliance |
| `spike/errshapes.mjs` | What the SDK client throws per failure class | classifier |
| `spike/soak.mjs` | N requests at concurrency C; samples heap after forced GC | E13 |
| `spike/one-call.mjs` | Single tools/call through the gateway | E14 |
| `spike/e3-streams.mjs`, `spike/e3b-idle.mjs` | Long calls + idle listen streams through Traefik; who cuts idle streams | E3 |
| `spike/e12-github.mjs`, `spike/e12-github-size.mjs` | GitHub remote MCP in both eras; tool-list size by field | E12 |
| `spike/e15-ssrf.mjs` | SSRF vectors, redirects, rebinding | E15 |
| `spike/e17-watch.mjs` | Timeline of gateway status / pod / EndpointSlice / calls around a pod kill | E17 |
| `spike/e5-rest.mjs`, `spike/e5-orders.mjs`, `spike/e5-checkout.mjs` | WC REST battery (in-cluster), order tests, guest Store API checkout (host) | E5 |
| `spike/e8-chat.mjs` | AI SDK 7 + `@ai-sdk/mcp` tool loop with approvals, pass^k evals, any OpenAI-compatible model | E8 |
| `spike/e8-langgraph.mjs` | Same eval with LangChain 1 `createAgent` + `humanInTheLoopMiddleware` + `@langchain/mcp-adapters` (set `prefixToolNameWithServerName:false`) | E8 |
| `Modelfile.agent` | `qwen3.5:9b` + `num_ctx 8192` + `temperature 0` → `ollama create qwen3.5-agent -f Modelfile.agent` | E8 |
| `demo-check.sh` | Scripted DoD (Inspector CLI exit codes + gateway state) | E16 |
| `k8s/spike.yaml` | ns `exp`: demo/ship upstreams, spike gateway, Ingress `gw.127.0.0.1.nip.io` | E3, E7, E16, E17 |
| `k8s/e3.yaml` | two gateway variants (keep-alive on/off) behind Traefik | E3 |
| `k8s/netpol.yaml`, `k8s/netpol-test.sh` | default-deny + allow rules + rogue pod; probe matrix | E7 |
| `k8s/store.yaml`, `k8s/store-bootstrap.sh`, `k8s/e5-keys.php` | MariaDB + WordPress in ns `store`; idempotent bootstrap; key diagnostics | E5 |
| `k8s/woo-mcp.yaml` | woo-mcp Deployment in ns `exp` | DoD walk |
| `k8s/watch-rbac.yaml` | ServiceAccount + Role (get/list/watch endpointslices) for the gateway's `K8S_WATCH` EndpointSlice watcher | E17 G/H |
| `helm-e/` | Helm 4 behaviour probe chart | Helm probe |
| `Dockerfile.spike` | `urumi-spike:dev` image (node:24.21.0-alpine + spike/) | in-cluster spikes |

## Prerequisites (as installed on the dev box)

- Docker Desktop running; `~/bin/k3d.exe` 5.9.0; `~/bin/helm.exe` 4.3.0; `kubectl` 1.36.
- Node 24 via fnm. All commands use `fnm exec --using=24.21.0 node …`. The default Node 22.16 is too old for
  `undici` 8.11.
- `npm install` in this folder (pins: SDK 2.3.1/2.1.1, Inspector 2.10.1, ai 7.0.137, @ai-sdk/mcp 2.0.73, langchain
  1.5.16, …).
- Git Bash quirks: prefix `MSYS_NO_PATHCONV=1` to `kubectl exec … /bin/bash` commands; pipe scripts via stdin
  (`kubectl exec -i … -- node --input-type=module - < file.mjs`).

## Re-run recipes

```bash
# local (no cluster): two upstreams + gateway with public upstreams
spike/run-local.sh                         # starts :7802 demo, :7803 shipping (token s3cret), :7801 gateway
fnm exec --using=24.21.0 node spike/client-test.mjs auto k1     # modern client
fnm exec --using=24.21.0 node spike/client-test.mjs legacy k2   # legacy client
spike/compliance.sh                        # wire checks
spike/restart-gw.sh AUTH_STYLE=403         # restart gateway with env (plain401|bearer401|bearer401meta|403)
fnm exec --using=24.21.0 node spike/soak.mjs 20000 20   # needs gateway started with --expose-gc for /admin/mem GC
fnm exec --using=24.21.0 node spike/e15-ssrf.mjs
spike/killport.sh 7801 7802 7803           # stop local spike processes

# cluster
k3d cluster create urumi --image rancher/k3s:v1.36.5-k3s1 -p "8080:80@loadbalancer" -p "8443:443@loadbalancer" \
  --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:*" --wait
docker build -t urumi-spike:dev -f Dockerfile.spike . && k3d image import urumi-spike:dev -c urumi
kubectl apply -f k8s/spike.yaml
kubectl apply -f k8s/store.yaml && kubectl -n store rollout status deploy/wordpress
kubectl -n store exec -i deploy/wordpress -- bash -s < k8s/store-bootstrap.sh
kubectl -n exp exec -i deploy/spike-gateway -- node --input-type=module - < spike/e5-rest.mjs
fnm exec --using=24.21.0 node spike/e5-checkout.mjs http://store.127.0.0.1.nip.io:8080 10 "note"
kubectl apply -f k8s/woo-mcp.yaml   # then set spike-gateway UPSTREAMS to include store (see 07 §16)
kubectl apply -f k8s/netpol.yaml && bash k8s/netpol-test.sh
./demo-check.sh                     # 11 DoD checks
kubectl -n exp port-forward svc/spike-gateway 7901:80 &   # then: node spike/e17-watch.mjs http://127.0.0.1:7901 20 1

# Claude Code (from a scratch folder; local scope only)
claude mcp add --transport http --scope local urumi http://gw.127.0.0.1.nip.io:8080/mcp --header "Authorization: Bearer k2"
claude mcp list
claude -p "Which orders are processing? …" --model haiku --allowedTools "mcp__urumi__store__list_orders"

# E8 (local GPU model; or set BASE_URL/API_KEY/MODEL for Groq/NVIDIA/OpenRouter)
ollama pull qwen3.5:9b && ollama create qwen3.5-agent -f Modelfile.agent
REASONING=none K=3 GW=http://gw.127.0.0.1.nip.io:8080/mcp fnm exec --using=24.21.0 node spike/e8-chat.mjs
REASONING=none K=3 fnm exec --using=24.21.0 node spike/e8-langgraph.mjs
# hosted: BASE_URL=https://api.groq.com/openai/v1 API_KEY=... MODEL=... node spike/e8-chat.mjs
```

Spike keys: gateway `k1` (alice, admin), `k2` (bob, member); upstream `shipping` token `s3cret`; WC RW key
`ck_e5rw…0001` / `cs_e5rw…0002`, RO key `ck_e5readonly…0002`; WP admin `admin` / `admin-e5-pass`. All are local test
values. Never reuse them.
