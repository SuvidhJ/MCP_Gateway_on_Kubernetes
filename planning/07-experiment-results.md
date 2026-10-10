# 07 — Experiment Results (round 6, 2026-10-10)

Round 6 ran the experiments that round 5 left open (06-depth/00-index §5). Everything here was **executed on this
machine** (Windows 11, Docker Desktop 29.7.2, k3d 5.9.0 → k3s v1.36.5, Node 24.21.0) against real software:
- MCP SDK v2 (`@modelcontextprotocol/server|client` 2.3.1, `/node` 2.1.1);
- Claude Code 2.1.296 and Inspector 2.10.1;
- WordPress 7.1.3 + WooCommerce 11.2.0 + MariaDB 11.4.13 in-cluster;
- Traefik 3.7.13;
- live public MCP servers.

All code is in [`experiments/`](../experiments/README.md). It's throwaway spike code, not the product, but every
result below can be re-run from it.

Status legend: **PASS** = behaved as the design needs. **FINDING** = behaved differently from what we assumed, and
the design must change. **NOT RUN** = reason given.

---

## 0. Summary

| # | Experiment | Status | One-line result | Design consequence |
|---|---|---|---|---|
| E1 | Claude Code ↔ our gateway, both eras, listen push, disable | **PASS** | CC 2.1.296 negotiates **modern** (`server/discover` → `tools/list` → `subscriptions/listen {toolsListChanged:true}`). On disable, our `toolsChanged` push made CC re-fetch `tools/list` **within 5 ms**. | `listChanged: true` + `handler.notify.toolsChanged()` is enough for CC. Push works end to end. |
| — | Wire compliance of `createMcpHandler` (18 raw curl cases) | **PASS** | Every 06·01/06·02 prediction held (-32020, -32022 with `supported`, 404/-32601, 405, 415, legacy over SSE). **`Origin: https://evil.example` accepted.** | Mount our own Host/Origin guard (already a settled constraint; now observed). |
| E3 | Streams through k3s Traefik | **PASS + FINDING** | 90 s tool calls (both eras) pass Traefik; a listen stream with 15 s keep-alives survived **400 s idle** and got the push. Without keep-alives the stream died at **~300 s**, and the cause is **Node's fetch (undici `bodyTimeout` 300 s) on the client**, not Traefik (E3b: Traefik + `bodyTimeout:0` survived 340 s). | Keep `keepAliveMs` 15 s (default). Our *upstream* listen streams need `bodyTimeout: 0` (or > keep-alive) or re-listen on `remote`. |
| E4 | Revocation UX | **PASS** | CC on 401 *and* 403 (any `WWW-Authenticate` variant): "✘ Failed to connect — Server rejected the configured Authorization header … OAuth fallback is disabled", **showing our JSON-RPC error text verbatim**. Mid-session: the next call fails and the model is told to re-auth. Inspector CLI: exit **3**. | Plain 401 + a human-readable message. Also **close the revoked key's open listen streams** (they stayed open). Inspector scripts must pass `--stored-auth-only`. |
| E5 | WooCommerce in-cluster: auth, role, REST, checkout | **PASS + 4 FINDINGS** | Basic over in-cluster HTTP works **only with `X-Forwarded-Proto: https`**; key scope per method and WC-namespace-only confirmed; `mcp_store_agent` can do the 5 tools and nothing else; guest COD checkout → `processing`; order edit needs `edit_others_shop_orders` under HPOS. Findings: HPOS **off** after WP-CLI install; coming-soon **unset** right after activation; `consumer_secret` is `char(43)` (longer key = silent INSERT failure); XFP makes WP emit **`https://` links** on an http site. | Bootstrap: enable HPOS explicitly, set coming-soon explicitly, generate WC-format keys and check INSERT, set timezone. Tool rewrites permalinks to the public base URL. |
| E7 | k3d on this box | **PASS** | serverlb works on `:8080` (no WSL2 LB bug); `winnat` excludes nothing near 8080/8443; `*.localtest.me`, `nip.io`, `sslip.io` resolve on this network; **`*.localhost` does NOT resolve from Node** (curl and browsers special-case it). NetworkPolicy enforced **~1.3 s after apply**, still enforced after `k3d cluster stop/start`. Denials show up as **ECONNREFUSED** (REJECT), not timeouts. | Local hostnames: `*.127.0.0.1.nip.io` or `*.localtest.me`, never `*.localhost` (Node clients break). Restart caveat didn't reproduce. |
| E8 | LLM tool loop through the gateway (local GPU model) | **PASS** | Qwen 3.5 9B (Q4_K_M, Ollama 0.40.2, RTX 4060 8 GB, 8 K ctx, ~37–40 tok/s) via the OpenAI-compatible API: **AI SDK 7 + `@ai-sdk/mcp`: pass^3 6/6; LangChain 1 `createAgent` + HITL + `@langchain/mcp-adapters`: pass^3 6/6.** Both approval flows (pause → approve → resume → write executed) work. 1.5–4 s per case (cross-server 13 s, DeepWiki). All 18 tools: still 6/6 but input tokens ×1.8 (cross-server 6.2 K). Thinking on: same accuracy, 2–2.5× slower. Pods reach host Ollama via `host.k3d.internal:11434`. | The framework choice isn't decided by reliability. A local GPU model is a free, keyless dev/eval/local-demo LLM. Tool selection matters for token budget. Turn reasoning off. Hosted free tiers need keys (not tested). |
| E12 | Public upstreams through our client | **PASS + FINDING** | One SDK client config (`versionNegotiation: 'auto'`) handled modern (Cloudflare Docs), legacy no-session (DeepWiki 2025-11-25) and legacy+session (MS Learn 2025-06-18). **GitHub's remote MCP is now dual-era (modern 2026-07-28)**; calls worked in both eras with no Mcp-Param errors. Its read-only list = 29 tools ≈ 19 K tokens (legacy) / 36 K (modern), of which **icons 44 KB, outputSchemas 66 KB**. | GitHub is a viable read-only upstream. The gateway should strip `icons`/`outputSchema` before tools reach an LLM. Per-upstream timeouts (DeepWiki `ask_wiki_question` took 8.5 s). |
| E13 | Soak through per-request low-level `Server` | **PASS** | 40 k mixed-era requests: heap after GC **flat at ~32–34 MB**; RSS plateau ~310–330 MB; 0 errors; ~640 req/s single process. | No leak. Pod memory limit ≥ 512 Mi. |
| E14 | Upstream restart → 404 → re-init → retry | **PASS** | SDK client throws `SdkHttpError` 404 (not handled, #1708 still open). Our wrapper re-initialised and retried: the call succeeded on the new process in 33 ms. A **wrong URL also returns 404 with the same SDK code**, so re-init only when we hold a session id. | Keep our 404 path, gated on `transport.sessionId`. |
| E15 | SSRF vectors + redirects | **PASS** | 24 vectors (ToolHive#6197 forms, decimal/octal/hex, `::ffff:` forms, NAT64, 6to4, AWS IPv6 IMDS, `*.nip.io`, trailing dot): all blocked at connect; **victim hits 0**. Node's WHATWG URL parser rejects empty host and zone IDs outright. SDK client refuses cross-origin redirects by default; the guard blocks the second hop anyway. | `ssrf-guard.mjs` is the reference implementation (add 6to4/Teredo ranges). DNS-rebinding service test inconclusive (rbndr.us unresolvable); mechanism is safe by construction. |
| E16 | Scripted DoD check | **PASS** | `experiments/demo-check.sh`: 11/11 checks in 12–18 s, idempotent across runs (list, call as A and B, cross-server, revoke→exit 3, disable→gone + exit 5, kill→unreachable, others OK, recovery). | Ship the same script in the product repo (`make demo-check`). |
| E17 | Kill-pod detection timing | **FINDING** | Replacement pod Ready **~1.9–2.2 s** after `kubectl delete pod`. A 5 s tick **never** showed "unreachable". Endpoint transitions black-hole one connect (conntrack) → **undici's default 10 s connect timeout**. With 1–2 s tick + 2 s connect timeout: unreachable visible ~0.8 s (pod kill) or held correctly (scale to 0, detected in 2.9–3.8 s). | Needs: short connect timeout (2 s), fast re-probe after failure, event-driven detection (EndpointSlice watch: **verified in-gateway, unreachable in ~0.2 s** with a read-only namespace Role) or a status history so a 2 s outage is visible. Demo: show both `delete pod` (self-heal) and `scale --replicas=0` (sustained). |
| E18 | Cursor header bug | **NOT RUN** | Cursor isn't installed on this machine (needs a login). Forum thread status (checked today): a Cursor staff reply on 2026-08-21 says current builds attach configured headers to every request and suspects duplicate server configs; no confirmed bug or fix. | Use Claude Code + Inspector as the demo clients; if Cursor is shown, define the server in one config location only. |
| E11 | Azure VM + k3s + DNS + cert-manager | **NOT RUN** | Needs the user's Azure account and a DNS decision. | Deferred to build week. |
| new | SDK client error shapes | **PASS** | Refused/NXDOMAIN at connect = `SdkError ERA_NEGOTIATION_FAILED` wrapping `TypeError: fetch failed`; at call time = raw `TypeError` (`cause.code ECONNREFUSED`); blackhole = `REQUEST_TIMEOUT`; 401 = `SdkHttpError CLIENT_HTTP_AUTHENTICATION`; 404/405 = `CLIENT_HTTP_NOT_IMPLEMENTED`. | Classifier: hard (refused/DNS/reset/connect-timeout/ESSRF) → unreachable now; soft (timeouts) → strikes; auth → `auth_failed`. |
| new | Helm 4.3.0 behaviour | **FINDING** | `lookup`+`randAlphaNum` secret **stable** across upgrade and rollback; failed upgrade with `--rollback-on-failure` **rolled back to the previous revision**; on a *first install* it **uninstalls**. **With `--wait` (= `watcher`) post-install hooks start immediately**, not after readiness (`--wait=legacy` waits). A hook pod is refused by NetworkPolicy for its first ~1 s. | Hooks/Jobs must retry their dependencies. Prefer migrations at app startup under advisory lock (10 §4). |
| new | DoD walk with real Claude Code through Traefik | **PASS** | Guest checkout on the storefront → CC (via Traefik → gateway → woo-mcp → WordPress) listed processing orders, completed one, verified ($0.005). Cross-server prompt (DeepWiki + store) worked ($0.004). Audit rows: `user=bob via=claude-code`. | The whole path works with the chosen pieces. |

---

## 1. Environment set up in this round (still installed)

| Item | Detail |
|---|---|
| k3d / Helm | `~/bin/k3d.exe` 5.9.0, `~/bin/helm.exe` 4.3.0 (sha256 verified). Note: **k3d 5.9.0's default k3s is v1.35.5-k3s1** (06·00 §4 said 1.32.5; corrected). |
| Cluster (**stopped at the end of round 6**; `k3d cluster start urumi` restores it in ~20 s, PVC data kept) | `k3d cluster create urumi --image rancher/k3s:v1.36.5-k3s1 -p "8080:80@loadbalancer" -p "8443:443@loadbalancer" --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:*" --wait` (45 s). Namespaces `exp` (spike gateway, upstreams, woo-mcp, NetworkPolicies) and `store` (WordPress + MariaDB). Stop with `k3d cluster stop urumi`; delete with `k3d cluster delete urumi`. |
| Node | fnm: `fnm exec --using=24.21.0 node …` (default Node is still 22.16; `undici` 8.11 needs ≥ 22.19). |
| Claude Code | VS Code extension binary `…/anthropic.claude-code-2.1.296-win32-x64/resources/native-binary/claude.exe`. The local-scope test entry `urumi` was removed after the tests (user config left clean). |
| Ollama | 0.40.2 (winget), models in `E:\ollama\models` (user env `OLLAMA_MODELS`). GPU: RTX 4060 Laptop 8 GB. |
| Images | `urumi-spike:dev` (built from `experiments/Dockerfile.spike`), `wordpress:7.1.3-php8.4-apache`, `mariadb:11.4.13`, `rancher/k3s:v1.36.5-k3s1`. |
| Bandwidth | ~1.5 MB/s shared. Large pulls (models, images) take tens of minutes. Pre-pull before demo recording. |
| Disk | **C: went from ~30 GB to ~12 GB free** during this round. Causes: the Docker Desktop disk image grew (k3s/WordPress/MariaDB/Node images and the copies imported into the k3d node; Docker data dir now 8.2 GB) and the Ollama app (2.8 GB of CUDA runtime). Models are on E: (6.6 GB). To reclaim later: `k3d cluster delete urumi`, `docker image prune`, then compact the Docker VHDX or move Docker's disk image to E: (Docker Desktop → Settings → Resources → Advanced). Not done automatically because it touches the user's Docker data. |

---

## 2. E1: Claude Code 2.1.296 against our gateway

**Setup:** `spike/gateway.mjs` (createMcpHandler + low-level Server, API-key gate, request logger), 2 local
upstreams + DeepWiki + MS Learn + Cloudflare Docs. `claude mcp add --transport http --scope local urumi
http://127.0.0.1:7801/mcp --header "Authorization: Bearer k2"`.

**What CC sends on connect** (from the gateway's request log):
1. `POST server/discover`: headers `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: server/discover`; `_meta`
   with `clientInfo {name:"claude-code", title:"Claude Code", version:"2.1.296", …}` and `clientCapabilities
   {roots:{listChanged:true}, elicitation:{form:{}, url:{}}}`; `User-Agent: claude-code/2.1.296 (claude-vscode,
   agent-sdk/0.3.288)`; `Accept: application/json, text/event-stream`.
2. `POST tools/list` (modern).
3. `POST subscriptions/listen` with `notifications: {toolsListChanged: true}`. It stays open for the session.

`claude mcp list` connects twice (health check, then `get`). On a modern 401 it **retries with legacy `initialize`**
before reporting failure.

**Push test:** `claude -p` called `demo__slow(10)`; 14 s in, `/admin/disable?slug=shipping`. Gateway log:
`16:56:14.615 notify toolsChanged` → `16:56:14.620 POST tools/list` (CC re-fetched in **5 ms**). The model then
reported "`mcp__urumi__shipping__echo` is no longer available". Cost $0.0045 (Haiku).

**Implications:**
- Modern-first is real; the gateway's modern face is the main path for CC. The legacy face is the path for
  Inspector CLI, VS Code and others.
- Our audit `via` can come from `_meta` clientInfo (`claude-code`), display-only.
- Call-time denial for stale clients is still needed (Inspector pre-checks `tools/list`, other clients may not).

## 3. Wire compliance (`spike/compliance.sh`, 18 cases)

| Case | Result |
|---|---|
| modern discover / tools/list / tools/call (correct headers) | 200 JSON; discover carries `ttlMs:0, cacheScope:"private"` |
| modern without `MCP-Protocol-Version` | 400 `-32020` "header … absent" |
| `Mcp-Method` mismatch / missing `Mcp-Name` on tools/call | 400 `-32020` with `data.mismatch` |
| `_meta` names 2027-01-01 | 400 `-32022`, `data:{supported:["2026-07-28"], requested}` |
| unknown method / `ping` on modern | 404 `-32601` |
| modern header but no `_meta` | 400 `-32602` |
| legacy `initialize`, `tools/list`, `ping` | 200 `text/event-stream`, one `event: message` |
| GET / DELETE | 405 `-32000` "Method not allowed." |
| `Content-Type: text/plain` | 415 |
| `Origin: https://evil.example` | **200 (accepted)**: no Origin validation in the handler |

## 4. E3: long-lived responses through Traefik 3.7.13 (k3s default config)

Two gateway Deployments behind one Ingress: `gw-e3` (keep-alive 15 s) and `gw-e3-noka` (`KEEPALIVE_MS=0`),
`CALL_TIMEOUT_MS=150000`.

| Test (client on host → Traefik :8080 → gateway pod) | keep-alive 15 s | keep-alive off |
|---|---|---|
| modern `tools/call demo__slow(90)` (JSON response, no bytes for 90 s) | ok at 90.5 s | ok at 90.5 s |
| legacy `tools/call demo__slow(90)` (SSE) | ok at 90.5 s | ok at 90.5 s |
| listen stream idle 400 s, then push | **push received**, still open | **closed `remote` at 304 s** |

**E3b (who closed it?):**
- via Traefik with an undici Agent `bodyTimeout: 0`: survived 340 s, received the push;
- direct (port-forward, no Traefik) with default `fetch`: closed at 305 s.

So **Traefik cut nothing** (≥ 400 s idle, ≥ 90 s silent responses). The 300 s cut is the **client's** undici
`bodyTimeout` default (300 000 ms), which applies to any Node `fetch` client, including the gateway's own upstream
connections.

## 5. E4: revocation

| Client | Server answer | What the user sees |
|---|---|---|
| CC `mcp list` (plain 401 / 401 + `WWW-Authenticate: Bearer error="invalid_token"` / + `resource_metadata` / 403) | identical in all four | `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: key revoked"},"id":null}` |
| CC mid-session (key revoked during a call) | next `tools/call` → 401 | model is told: `MCP server "urumi" rejected the Authorization header in its config (update it, then run /mcp to reconnect)` |
| Inspector CLI 2.10.1 (401) | — | exit 3; without `--stored-auth-only` it tries interactive OAuth ("requires a TTY"); with it, our message is shown |
| Inspector CLI (403) | — | exit 3, no OAuth attempt |

No `/.well-known/*` requests were made by either client. The revoked key's **open listen stream stayed open** until
the session ended. **Decision input:** 401 with `{"code":-32001,"message":"API key revoked — ask your admin for a
new key"}`, no `WWW-Authenticate` needed; track listen responses per key and end them on revoke.

Inspector exit codes from source (`clients/cli/build/index.js` `EXIT_CODES`): 0 OK, 1 USAGE, 2 NO_APP, 3
AUTH_REQUIRED, 4 UNREACHABLE, 5 TOOL_ERROR (`tool_is_error` and `tool_not_found`), 6 SCHEMA_UNPORTABLE. The CLI
connects with legacy `initialize` (`clientInfo inspector-cli 2.10.1`). It checks `tools/list` before a call, so a
removed tool is `tool_not_found` (exit 5) without reaching the gateway.

## 6. E5: WooCommerce 11.2.0 on WordPress 7.1.3 in k3s

**Deploy** (`k8s/store.yaml`): MariaDB Ready at 109 s, WordPress at 179 s (first boot, PVCs, slow network).
**Bootstrap** (`k8s/store-bootstrap.sh`, run as uid 33 inside the WP container): 39 s first run, 15 s re-run.

Observed defaults and traps:

| What | Observed | vs 06·04 |
|---|---|---|
| `permalink_structure` after `wp core install` | `''` (plain) | as predicted |
| `woocommerce_coming_soon` right after `wp plugin activate` | **unset** | 06·04 said `yes`; WC adds it later on `woocommerce_newly_installed`. Setting `no` first still wins (it's `add_option`). |
| HPOS (`woocommerce_custom_orders_table_enabled`) after CLI install | **`no`** | 06·04 said new shops get HPOS. Via WP-CLI it stays off; `wp wc hpos enable` turns it on. |
| COD | disabled until `wp wc payment_gateway update cod --enabled=true` | as predicted |
| site timezone | `timezone_string=''`, `gmt_offset=0` (UTC) | new: set `Asia/Kolkata` (or the store's) in bootstrap |
| mail | `/usr/sbin/sendmail: not found`; order notes "Email … failed to send" | as predicted (quiet failure) |
| WC key insert with a 44-char secret | **silent failure** (`consumer_secret char(43)`), only the RO key existed | new: generate `ck_`/`cs_` + 40 hex and check `$wpdb->insert` |

REST battery as `mcp-agent` (`spike/e5-rest.mjs`, in-cluster):

| Request | Result |
|---|---|
| RW key, Basic, **no** `X-Forwarded-Proto` | 401 `woocommerce_rest_cannot_view` (anonymous) |
| RW key + `X-Forwarded-Proto: https` (`?rest_route=` and `/wp-json`) | 200 |
| wrong secret | 401 `woocommerce_rest_authentication_error: Consumer secret is invalid.` |
| read-only key POST | 401 `…does not have write permissions.` |
| WC key on `/wp/v2/users/me`, `/wp/v2/settings`, `POST /wp/v2/posts` | 401 (key not honoured outside WC routes) |
| create product `status: draft` / no status | 201 / 201 with **`status: publish`** |
| duplicate SKU / `regular_price: 12` (number) | 400 `product_invalid_sku` / 400 `rest_invalid_param` |
| DELETE product, settings, customers, coupons, reports | 403 each |
| unknown product / order id | 404 `…invalid_id` |
| `_fields=id,name,price` | trimmed objects |
| product `permalink` in responses | **`https://store.127.0.0.1.nip.io:8080/…`** (scheme forced by XFP; broken on a plain-http local site) |

Storefront checkout as a guest through Traefik (`spike/e5-checkout.mjs`, Store API):
- `GET /wp-json/wc/store/v1/cart` → `Cart-Token` + `Nonce`;
- `add-item` → 201 (totals in minor units: `99800` INR = ₹998.00);
- `free_shipping` rate available;
- `checkout {payment_method:"cod"}` → 200, `status: processing`.

Orders (`spike/e5-orders.mjs`):
- `date_created` and `date_created_gmt` **have no offset**; `created_via: "store-api"`; `customer_id: 0`;
- `customer_note` carries the buyer's free text ("Please gift wrap"): the injection path is real;
- `PUT {status:"completed", manual_update:true}` → note "Order status changed from Processing to Completed."
  with **author `mcp-agent`**;
- `completed → pending` → **200** (no transition rules);
- without `edit_others_shop_orders`, editing a guest order → **403 `woocommerce_rest_cannot_edit`**; with it → 200
  (HPOS on).

`spike/woo-mcp.mjs` (5 tools over the same REST) then served Claude Code end to end (§16).

## 7. E7: k3d on this Windows box

| Check | Result |
|---|---|
| `winnat` excluded TCP ranges | 28385, 28390, 50000–50059, 50128 → 8080/8443 free |
| serverlb `localhost:8080` | 404 from Traefik once Traefik was up (~9 min on the first boot due to slow image pulls) |
| Name resolution from **Node** (`dns.lookup`) | `store.localtest.me`, `store.127.0.0.1.nip.io`, `store.127-0-0-1.sslip.io` → 127.0.0.1; **`store.localhost` → ENOTFOUND**; `host.k3d.internal` → ENOTFOUND on the host |
| curl | resolves `*.localhost` itself (special-cased) |
| NetworkPolicy baseline (none) | rogue pod reaches upstream and gateway |
| after apply | **enforced ~1.3 s after `kubectl apply`**; denied = `ECONNREFUSED` (kube-router REJECT) |
| allowed paths | gateway → upstreams OK; Traefik → gateway OK (namespaceSelector `kubernetes.io/metadata.name: kube-system` + `app.kubernetes.io/name: traefik`) |
| `k3d cluster stop && start` (22 s) | policies still enforced (one restart, single node); Traefik needed ~20 s to serve again; a bare Pod (`rogue`) did not survive the restart |

## 8. E12: public upstreams and GitHub through the SDK client

| Upstream | Negotiated | Session | Calls through gateway (modern and legacy clients) |
|---|---|---|---|
| Cloudflare Docs | 2026-07-28 | no | ok (search 6–8 s) |
| DeepWiki | 2025-11-25 | no | ok (`read_wiki_structure` 0.4–2.6 s; `ask_wiki_question` 8.5 s) |
| MS Learn | 2025-06-18 | yes | ok (0.6–1.1 s) |
| GitHub `/mcp/readonly` (gh OAuth token) | **2026-07-28** (auto) / 2025-11-25 (legacy, session) | legacy only | `get_me`, `search_repositories` ok in both eras |

GitHub list composition (29 tools, chars): name 469, description 4 157, inputSchema 24 198, **icons 44 224**, modern
**outputSchema 65 834**, annotations 2 183. 22 tools carry `x-mcp-header`. The LLM-relevant part (name + description
+ inputSchema) ≈ 29 K chars ≈ 7 K tokens: still near a free tier's 8 K TPM by itself.

## 9. E8: LLM tool loop (local model on the RTX 4060)

**Setup:**
- Ollama 0.40.2; `qwen3.5:9b` (Q4_K_M, 6.6 GB download, ~45 min on this link).
- The variant `qwen3.5-agent` adds `num_ctx 8192` and `temperature 0` (`experiments/Modelfile.agent`).
  - Default context is 4 096, too small.
  - 16 K didn't fit in 8 GB (16 %/84 % CPU/GPU); 8 K runs 12 %/88 % at **36.6 tok/s** (100 % GPU at 4 K: ~40 tok/s).
- **Thinking is on by default**: a two-sentence answer took 800–1 181 tokens versus 43–55. On the OpenAI-compatible
  endpoint, `reasoning_effort: "none"` turns it off (AI SDK: `providerOptions.<name>.reasoningEffort`; LangChain:
  `modelKwargs.reasoning_effort`).
- The agent connects to the **in-cluster gateway through Traefik** as user `k1` and sees the real store
  (woo-mcp → WordPress) plus DeepWiki. Tools are selected to `store__*` + `deepwiki__ask_wiki_question`
  (6 tools, ~667 schema tokens).
- Write tools need approval. The harness auto-approves to test the resume path.

**Cases** (each run K times; pass^k = all K runs pass):
1. list products;
2. processing orders (must pass `status:["processing"]`);
3. get order 15;
4. complete order 16 (must request approval with `{id:16,status:"completed"}`);
5. create a draft product at 99 (approval with `status:"draft"`, `regular_price:"99"`);
6. cross-server: DeepWiki, then the store's on-hold orders.

| Harness | Tools | Reasoning | pass^k | Avg latency per case | Avg input / output tokens per case |
|---|---|---|---|---|---|
| AI SDK 7 (`generateText` + `toolApproval` + `@ai-sdk/mcp`) | 6 | off | **6/6 (k=3)** | 1.5–4.3 s; cross-server 13.7 s | 1.9–2.3 K / 40–117 |
| LangChain 1 (`createAgent` + `humanInTheLoopMiddleware` + MemorySaver + `@langchain/mcp-adapters`) | 6 | off | **6/6 (k=3)** | 1.5–3.1 s; cross-server 13.0 s | 1.9–2.4 K / 40–128 |
| AI SDK 7 | **18 (no selection)** | off | 6/6 (k=2) | similar | **3.3–6.2 K** / 40–130 |
| AI SDK 7 | 6 | **on** | 6/6 (k=1) | **2–2.5× slower** (3.7–19.5 s) | 1.9–2.6 K / 109–360 |

**Observations:**
- **Approval flows work in both frameworks.**
  - AI SDK: `result.content` holds `tool-approval-request {approvalId, toolCall}`; resume by appending a
    `{role:"tool", content:[{type:"tool-approval-response", approvalId, approved:true}]}` message.
  - LangChain: `result.__interrupt__[0].value.actionRequests`; resume with `new Command({resume:{decisions:
    [{type:"approve"}]}})` on the same `thread_id` (needs a checkpointer).
- **`@langchain/mcp-adapters` prefixes tool names with the server key by default** (`gw_store__list_orders`).
  Set `prefixToolNameWithServerName: false`, or match prefixed names in `interruptOn`. My first LangChain run had
  tools=0 because of this. With no tools bound, the model *claimed* "Order #16 has been marked as completed" without
  doing anything: the hallucinated-action failure mode that evals must catch.
- The spike's 10 s per-call timeout cut DeepWiki's `ask_wiki_question` in some runs; the model reported "the
  deepwiki query timed out". That's more evidence for per-upstream timeouts (≥ 30 s for AI-backed public tools).
- The model priced products in "$": `list_products` doesn't return the currency. Tools should carry it. Drafts
  appear in product lists unless filtered.
- **Pods reach the host's Ollama** at `http://host.k3d.internal:11434/v1` (Docker Desktop forwards to host
  loopback even though Ollama binds 127.0.0.1). The in-cluster chat backend can use the GPU model for the local demo
  with no extra setup.
- Hosted free tiers (Groq, Gemini, NVIDIA, OpenRouter) were **not tested**: there are no API keys on this machine.
  `spike/e8-chat.mjs` runs against any of them with `BASE_URL`, `API_KEY`, `MODEL` (and `REASONING` if supported).
- Token budget: at 2–6 K input tokens per *turn*, an 8 K-TPM tier allows roughly 1–3 agent turns per minute. Tool
  selection plus stripping icons and outputSchema is required for hosted free tiers; local Ollama has no such
  limit.

## 10. E13: soak

`spike/soak.mjs` against the gateway (`node --expose-gc`, `/admin/mem` forces GC), 1/3 each modern `tools/call`,
modern `tools/list`, legacy `tools/call`:

| Run | Requests | Concurrency | Errors | req/s | p50 / p95 / p99 ms | heapUsed after GC (MB) | RSS (MB) |
|---|---|---|---|---|---|---|---|
| 1 | 20 000 | 20 | 0 | 637 | 36 / 47 / 54 | 19.6 → 31.8 → 32.5 → 31.5 → 32.0 | 82 → 313 |
| 2 | 20 000 | 50 | 0 | 643 | 91 / 109 / 135 | 35.1 → 33.7 | 330 → 331 |

Heap is flat (no #2607-style growth). Throughput is bounded by one event loop plus the spike's synchronous audit
writes.

## 11. E14: legacy session loss

Sessionful upstream (`MODE=stateful`, `NodeStreamableHTTPServerTransport` with `sessionIdGenerator`) → gateway
connected (legacy, session) → upstream restarted → next call: SDK throws `SdkHttpError` status 404 → gateway
`reinit: session 404 -> reconnect + retry once` → ok (new pid, 33 ms total).

## 12. E15: SSRF (`spike/ssrf-guard.mjs`, `spike/e15-ssrf.mjs`)

All of these were blocked with `ESSRF` at connect (DNS answers checked inside the connector, literals checked
before dialing):
- `localhost.`, `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, `127.000.000.001`, `0`, `0.0.0.0`;
- `[::]`, `[::1]`, `[::ffff:127.0.0.1]`, `[0:0:0:0:0:ffff:7f00:1]`, `[::ffff:a9fe:a9fe]`, `[64:ff9b::7f00:1]`;
- `[2002:7f00:1::]`, `[fd00:ec2::254]`, `169.254.169.254`, `localhost`, `localtest.me`, `127.0.0.1.nip.io`.

The rest:
- `http://:8099/` and `[fe80::1%25eth0]` are rejected by the URL parser;
- `metadata.google.internal` → ENOTFOUND;
- `example.com` → 200.

Redirects:
- 302 from an allowed host to metadata/loopback → second hop `ESSRF`;
- the SDK transport refuses with "Redirect to … not followed".

Victim server hits: **0**.

## 13. E16: `experiments/demo-check.sh`

```
== 1. user A sees tools from every enabled server        PASS (store__ 5, deepwiki__ 3)
== 2. orders question works                               PASS exit 0
== 3. user B can call                                     PASS exit 0
== 4. cross-server                                        PASS exit 0
== 5. revoke B                                            PASS exit 3; A unaffected exit 0
== 6. disable deepwiki                                    PASS tools gone; call exit 5
== 7. kill upstream (scale 0)                             PASS unreachable after 3761 ms; store still works; back after 5636 ms
RESULT: 11 passed, 0 failed in 18s   (re-run: 11/0 in 12s)
```

## 14. E17: kill-pod detection (in-cluster, `spike/e17-watch.mjs`)

Timeline columns are seconds after the kill command.

| Scenario | Endpoint not-ready | Old pod gone | New pod Ready | Gateway "unreachable" | Gateway "connected" again |
|---|---|---|---|---|---|
| A: `delete pod`, 5 s tick, user calls every 0.5 s | +0.06 | +0.42 | +2.2 | +2.8 (a call failed with `fetch failed` / `Connection closed`; calls in the gap hung up to 1.6 s) | +7.8 (next tick) → **5 s of false outage after the pod was back** |
| B: `delete pod`, 5 s tick, no calls | +0.07 | +0.45 | +2.0 | **never** | — |
| D: `delete pod`, 5 s tick + fast retry, calls | +0.07 | +0.43 | +1.4 | brief (< 200 ms, between polls) | immediately (52 ms reconnect) |
| C: `scale 0` 11 s, 5 s tick, no calls | +0.05 | +0.34 | — | **never** (probe hung 10 s on a black-holed connect → soft strike) | — |
| E: `delete pod`, 1 s tick + 2 s connect timeout | +0.05 | +0.41 | +3.3 | +3.1 | +3.9 |
| F: `scale 0`, 1 s tick + 2 s connect timeout | +0.07 | +0.35 | (+11.3 scale-up → Ready +12.1) | +2.9 | +15.3 |
| **G: `delete pod`, 5 s tick + EndpointSlice watch**, no calls | +0.06 | +0.49 | +1.8 | **+0.23** (watch event; observer polls every 200 ms) | +3.1 |
| **H: `scale 0`, 5 s tick + EndpointSlice watch**, no calls | +0.08 | +0.38 | (scale-up → Ready +11.5) | **+0.23** | ~+13.5–14 (first probe after the ready event hit a 2 s connect timeout during the rule rewrite, the next one connected) |

Isolated in-pod fetch loop during scale-down:
- refusals in 27–120 ms;
- **one request started 0.4 s after scale-down hung 10 075 ms (`UND_ERR_CONNECT_TIMEOUT`)**: its SYN hit the
  window where kube-proxy rewrote rules, and conntrack pinned the dead path.

A ClusterIP with zero endpoints is REJECTed instantly once the rule exists (`iptables … "has no endpoints" -j
REJECT`).

**EndpointSlice watch (G/H):** `spike/gateway.mjs` with `K8S_WATCH=exp/demo-upstream=demo` streams
`/apis/discovery.k8s.io/v1/namespaces/exp/endpointslices?labelSelector=kubernetes.io/service-name=demo-upstream&watch=true`
with the pod's ServiceAccount token. RBAC: `k8s/watch-rbac.yaml` (a namespace Role with get/list/watch on
`discovery.k8s.io/endpointslices`). This worked on k3s with no other permissions.
- Ready count 0 → `unreachable` immediately ("no ready endpoints").
- Ready count > 0 → probe now.
- Refinement: wait ~0.5 s (or use a 1 s connect timeout) before that probe, to step over the kube-proxy rewrite
  window.

This makes the dashboard exact for in-cluster upstreams with no probing load. External upstreams still rely on the
tick plus call-time failures.

## 15. Helm 4.3.0 probe (`experiments/helm-e/`)

| Test | Result |
|---|---|
| `helm template` with `lookup` | lookup empty offline → random value each render |
| install → upgrade | `apiKeyPepper` from `lookup`+`randAlphaNum` **identical** across upgrade and after rollback |
| `--dry-run=server` / `--dry-run=client` / `helm template` | server: **same value as live** (lookup applied); client and template: a new random value each time |
| post-install hook vs `--wait` (watcher) | hook Job created in the **same second** as the app pod → hook hit ECONNREFUSED → failed |
| `--wait=legacy` | hook created ~3 s after the app pod started (after readiness), but a single-attempt hook still failed (new pod's IP not yet in the NetworkPolicy allow set) |
| retrying hook (60 × 1 s) | install, upgrade ok |
| broken upgrade (bad image) + `--rollback-on-failure --timeout 40s` | `UPGRADE FAILED … rolled back`; history: rev 3 failed, **rev 4 "Rollback to 2"**, image restored |
| failed *first* install + `--rollback-on-failure` | release **uninstalled** (nothing left to debug) |
| chart's own deny-all NetworkPolicy | applied before workloads/hooks, so it blocks the hook unless a rule allows it |

## 16. DoD walk with Claude Code through Traefik

Gateway Ingress `gw.127.0.0.1.nip.io:8080`, upstreams `store` (woo-mcp, modern), `demo`, `shipping`, `deepwiki`
(legacy). User B (`k2`).

1. Guest bought product 12 on the storefront → order 17 `processing`, note "Leave at the door".
2. `claude -p "Which orders … processing … mark the most recent as completed …"` → `store__list_orders` →
   `store__get_order` → `store__update_order_status` → `store__get_order`: "Only one order is currently in
   processing status: 17 | INR 1300.00 | Leave at the door … marked as completed … confirms `completed`". $0.0051.
3. `claude -p "Use deepwiki to ask woocommerce/woocommerce what on-hold means … then list on-hold orders"` →
   `deepwiki__ask_wiki_question` (8.5 s) + `store__list_orders` (87 ms): correct answer + order 16. $0.0038.
4. Audit rows: `{"user":"bob","era":"modern","tool":"store__update_order_status","outcome":"ok","ms":103,"via":"claude-code"}`.

---

## 17. Corrections to earlier docs

| Doc | Was | Now |
|---|---|---|
| 06·00 §4, 06·05 | k3d default k3s image v1.32.5 | **v1.35.5-k3s1** (k3d 5.9.0 `version`). Still pin v1.36.5 |
| 06·04 §5.2 | coming-soon `yes` right after install | unset right after WP-CLI activation; set later by a hook. Set `no` explicitly (as planned) |
| 06·04 §2.3 | HPOS enabled for new shops | **not via WP-CLI install**; `wp wc hpos enable` |
| 06·04 §1.3 | key sketch | key/secret must be exactly 43 chars; check `$wpdb->insert` |
| 06·05 §3 | Traefik/SSE "confirmation test" | confirmed; plus the client-side undici 300 s `bodyTimeout` |
| 06·10 §1 | GitHub legacy + Mcp-Param risk | GitHub remote MCP is **dual-era**; read-only calls work in both eras |
| 05 §6 E12 | GitHub only if E12 passes | passes |
| 06·09 §1 | Inspector exit codes | confirmed from 2.10.1 source; add `--stored-auth-only` |

## 18. New design requirements found by experiment

1. **Connect timeout ~2 s** on every upstream dispatcher (undici default 10 s turns a dead pod into a 10 s hang).
2. **Failure classifier:** hard → unreachable now + fast re-probe (250 ms → tick); soft → strikes; auth →
   `auth_failed`. A single slow call must not mark a server unreachable.
3. **Independent, non-overlapping health loop per upstream** (one slow public server must not delay others;
   `setInterval` + async overlaps).
4. **Per-upstream call timeout** (public AI-backed tools take 8+ s; local ones ~100 ms).
5. **Kill-pod visibility:** EndpointSlice watch (RBAC: get/list/watch `endpointslices` in the upstream namespace) or
   a status-history strip on the dashboard; demo both `delete pod` and `scale 0`.
6. **Upstream listen streams:** `bodyTimeout: 0` on that dispatcher, or re-listen on `closed === 'remote'`.
7. **On key revoke:** also terminate that key's open listen streams.
8. **Origin guard** in front of `createMcpHandler` (observed: evil Origin accepted).
9. **Strip `icons` and `outputSchema`** from tool definitions handed to the chat LLM; consider per-tool description
   overrides (GitHub ~7 K tokens of LLM-relevant schema alone).
10. **WooCommerce tool hygiene:** rewrite `permalink` to the public base URL; never pass `customer_note` to the model
    without marking it as untrusted data; send `manual_update: true`; our policy owns status transitions.
11. **Bootstrap hygiene:** HPOS enable, coming-soon `no`, timezone, WC-format keys with checked inserts, retries
    for DB and HTTP readiness; run as uid 33.
12. **Helm:** hooks retry; don't depend on `--wait` ordering; secrets via `lookup` are stable; first-install failure
    with `--rollback-on-failure` leaves nothing behind (use `--wait` without rollback while debugging).
13. **Local hostnames:** `*.127.0.0.1.nip.io` or `*.localtest.me`, not `*.localhost`.

## 19. Reproduce

See [`experiments/README.md`](../experiments/README.md) for the exact commands per experiment.
