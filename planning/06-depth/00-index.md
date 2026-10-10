# 06·00 — Depth Round: Index, the End-to-End Path, Settled Facts, Open Decisions

Round 5 (2026-10-09/10). The ask: "enough breadth, now depth … completely 100% knowledge … so we don't get confused or
move away from the path." This folder is the **reference for building**. Everything here comes from primary sources:
- spec source files, SDK source, WooCommerce/WordPress/Traefik/Go/Helm/k3s source;
- vendor docs;
- live probes and prototypes run on this machine.

Docs 01–05 remain the *why*; 06 is the exact *how it behaves*.

> **Round 6 (2026-10-10): experiments executed.** Results, numbers and new design requirements:
> [`../07-experiment-results.md`](../07-experiment-results.md). Code: [`../../experiments/`](../../experiments/README.md).
> Where 07 and this folder disagree, **07 wins** (it was measured). The corrections are already folded in below and
> in docs 01, 04, 05 and 10.

| Doc | Topic | Read it when |
|---|---|---|
| [01](01-mcp-protocol.md) | MCP wire protocol, both eras, exact (headers, errors, discover, caching, listen, MRTR, auth, translation table, compliance checklist) | implementing either face of the gateway |
| [02](02-ts-sdk-v2.md) | TypeScript SDK v2 from source (`createMcpHandler` pipeline, low-level `Server`, client negotiation, timeouts, errors, open bugs) | choosing/using the SDK |
| [03](03-gateway-mechanics.md) | How Kuadrant, agentgateway and MetaMCP implement managers, naming, listing, calls, health, notifications | designing gateway internals |
| [04](04-woocommerce-wordpress.md) | WooCommerce 11.2 / WP 7.1.3 from source (auth paths, REST for the 5 tools, roles, image internals, bootstrap, checkout) | store + woo-mcp + bootstrap Job |
| [05](05-kubernetes-helm-networking.md) | k3s/k3d/Traefik/NetworkPolicy/Helm 4 (versions, timeouts resolved from source, policy set, probes, secrets, VPS) | charts, cluster, ingress |
| [06](06-identity-access-audit.md) | Keys, passwords, sessions, CSRF, chat delegation, credential encryption, RBAC, audit, rate limits, schema | auth/team features |
| [07](07-chat-agent-llm.md) | Agent loop, AI SDK 7 vs LangChain 1/LangGraph, tool-schema conversion, approvals, providers, evals | chat agent |
| [08](08-security-threat-model.md) | Threat model method, SSRF (prototype-verified), tool poisoning/TOFU, injection paths, hardening, the 4 brief questions | threat model note + hardening |
| [09](09-clients-and-demo.md) | Claude Code / Inspector / Cursor exact config and behaviour; DoD step by step; scripted check; video | demo + E2E tests |
| [10](10-upstreams-observability-data.md) | Live-probed public upstreams (eras, tools, token cost), OTel MCP names, Postgres/migrations | upstream choice, S-8, data layer |

---

## 1. The whole system in one pass (the "path")

**Install** (`helm upgrade --install … --rollback-on-failure --wait-for-jobs`, 05 §5)
1. Helm creates the NetworkPolicies 3rd in its install order (05 §4.2), then Secrets (generated with `lookup` +
   `randAlphaNum` and stable across upgrades), PVCs, Services, workloads, Ingresses.
2. MariaDB starts (PVC, `healthcheck.sh`); WordPress starts from **our immutable image**. The entrypoint copies code
   into `/var/www/html`, writes `wp-config.php` from env with salts from Secrets, and sets `WP_HOME` via
   `WORDPRESS_CONFIG_EXTRA` (04 §4–5).
3. The bootstrap Job (same image, uid 33) runs idempotent `wp` steps:
   - install WP; activate WooCommerce 11.2; set permalinks;
   - set `woocommerce_coming_soon=no`; enable COD; add a free-shipping method on zone 0;
   - create the `mcp_store_agent` role and user; insert the WC key from a Secret (`hash_hmac('sha256', ck, 'wc-api')`)
     (04 §1.3, §3, §5).
4. Postgres starts. The gateway runs migrations under `pg_advisory_lock` before turning Ready (10 §4).
5. Upstream managers probe each registered upstream with `server/discover` (`versionNegotiation: 'auto'`). Live
   servers answer with four different "not modern" shapes (10 §1). They cache dated verdicts, fetch catalogs, validate
   and hash tools, and expose `slug__tool` names (03 §2–3).

**User B in Claude Code** (09 §1)
1. `claude mcp add -t http urumi <url> -H "Authorization: Bearer urumi_…"`. Claude Code (SDK v2) probes our endpoint
   modern-first.
2. Our `Host`/`Origin` guards, then our key check (HMAC lookup, not revoked), produce `authInfo` (06 §2.3).
3. `createMcpHandler` classifies by body (`_meta` protocolVersion), validates headers (`-32020`/`-32022`), runs our
   factory, and the low-level `Server` answers (02 §2).
4. `server/discover` returns `supportedVersions` + `tools.listChanged`. `subscriptions/listen` gets an ack, then `:`
   keep-alives every 15 s (01 §7, 02 §2).
5. `tools/list` comes from the catalog filtered for B, sorted, with `cacheScope: private` and a short TTL (01 §6, 03 §4).
6. `tools/call store__list_orders` goes through:
   - catalog lookup and call-time authorization (same rules as listing);
   - the upstream client with fresh headers and the encrypted credential decrypted;
   - SSRF-guarded fetch and deadline;
   - woo-mcp → `GET /?rest_route=/wc/v3/orders&status[]=processing&_fields=…` with Basic ck:cs and
     `X-Forwarded-Proto: https`.

   The result becomes `isError`/content (03 §5–6, 04 §2, 08 §3). One audit row is written with
   `via=claude-code`, user B and the trace id (06 §7).

**User A in the dashboard chat** (07 §5)
1. The session cookie authenticates A. The backend mints a delegated JWT (`sub=A, act=chat-agent`). The agent connects
   to `/mcp` as a normal client.
2. The LLM loop: writes (`create_product`, `update_order_status`) pause for **approval** (Rule of Two). Results feed
   back; `isError` is shown to the model. Audit says A via chat-agent.

**Control**
- **Revoke B's key:** the next request gets 401, no OAuth trigger; Claude Code shows ✘; Inspector CLI exits 3
  (01 §11, 09).
- **Disable a server:** the manager drops its tools → `notify.toolsChanged()` → Claude Code refetches; the chat re-lists
  per turn. Stale clients get a call-time refusal (03 §8).
- **Kill the in-cluster upstream pod:**
  - the EndpointSlice drops to 0 ready endpoints or a call fails, so status is unreachable immediately;
  - other upstreams are unaffected thanks to the bulkhead and breaker;
  - status returns to connected when the replacement pod is Ready.

  Detection must beat the Deployment's restart (09 §2).

---

## 2. Settled by evidence (constraints, not choices)

1. The gateway must serve **both eras on one URL** and talk to **both eras upstream**:
   - Claude Code 2.1.295 negotiates modern;
   - VS Code and others are legacy;
   - the live upstreams span 2025-03-26 → 2026-07-28 (01 §9, 10 §1).
2. **Every modern list/discover result needs `ttlMs` + `cacheScope`.** SDK v2 always fills them (02 §2.3). Per-user lists
   are `private` (01 §6).
3. **Authorization must be enforced at call time**, not only by hiding tools (Claude Code keeps stale definitions; spec
   lets lists vary by authorization) (01 §5.2, 05).
4. **Never forward client tokens/headers upstream**; inject stored credentials only (01 §11, 08 §7).
5. `createMcpHandler` **doesn't validate Host, Origin or tokens.** We mount the exported guards and our own auth in front
   (02 §2.1).
6. A handler throw becomes `-32603`. The gateway must convert failures to `isError` itself (02 §2.3, 03 §6).
7. The SDK client has **no 404 session re-init**, an unenforced `maxTotalTimeout`, pending-POST bugs, and no
   re-listen. Fetch-level deadlines, our own re-init and re-listen are required (02 §3–4).
8. **Mcp-Param headers on legacy calls** need our own codec via per-request `headers` (GitHub) (02 §3.2).
9. **SSRF must be checked at connect time, including IP literals.** A DNS-hook-only guard is bypassed (verified, 08 §3).
10. WooCommerce Basic auth needs `is_ssl()`. The official image honours `X-Forwarded-Proto`, so in-cluster Basic works;
    lock it down with NetworkPolicy (04 §1.2).
11. **The store isn't usable until `woocommerce_coming_soon=no`**, COD is enabled, and shipping is solvable. Permalinks
    must be set explicitly from a Job (04 §5).
12. WooCommerce REST dates lack offsets, and statuses have no transition rules. Our tools normalise dates; our policy
    guards status changes (04 §2).
13. NetworkPolicy is real on k3s but has caveats: startup race, combined-selector flake on multi-node, unenforced after a
    k3d restart. Hence the scripted negative test (05 §4).
14. Traefik's 60 s `readTimeout` does **not** cut SSE responses (Go clears the deadline after the body is read); 15 s
    keep-alives handle the other idle cutters (05 §3.1).
15. The kill-pod demo needs **sub-restart detection** (EndpointSlice watch, call-time failure, or a short tick) (09 §2).
16. Free LLM tiers can't carry many verbose upstream tool lists (8K TPM vs 400–2,000 tokens per server). Description
    overrides or tool selection are needed (07 §3, 10 §1).

Added by round-6 experiments (../07-experiment-results.md):

17. **Claude Code 2.1.296 is modern-first and listens.** It sends `server/discover` → `tools/list` →
    `subscriptions/listen {toolsListChanged}`. Our `toolsChanged` push made it re-list within 5 ms. On 401/403 it shows
    our error text and never tries OAuth (07 §2, §5).
18. **Upstream connect timeout ≈ 2 s is mandatory.** A Service whose endpoints are changing black-holes some SYNs
    (conntrack), and undici's default 10 s connect timeout turns a dead pod into a 10 s hang (07 §14).
19. **Health = per-upstream independent loops + failure classifier + fast re-probe.** Hard failures (refused, DNS,
    reset, connect-timeout, SSRF) mean unreachable now; timeouts are strikes; 401/403 means `auth_failed`. A 5 s tick
    never sees a Deployment self-heal (~2 s) (07 §14, "error shapes").
20. **Node `fetch` (undici) kills a response that sends no bytes for 300 s (`bodyTimeout`).** Downstream is covered by
    our 15 s keep-alives. Our own upstream listen streams need `bodyTimeout: 0` or re-listen (07 §4).
21. **On revoke, end the key's open listen streams** (they survive otherwise) (07 §5).
22. **WooCommerce bootstrap must enable HPOS, set coming-soon `no` and the timezone, use exact 43-char WC keys with a
    checked insert, and retry until the DB is ready.** Tools must rewrite `https://` permalinks to the public base
    (07 §6).
23. **Helm 4: hooks start before workloads are Ready under `--wait`, and new pods are NetworkPolicy-refused for ~1 s.**
    Every Job retries; prefer migrations at app start (07 §15).
24. **Local hostnames:** `*.127.0.0.1.nip.io` or `*.localtest.me`; **`*.localhost` breaks Node clients** (07 §7).
25. **GitHub's remote MCP is dual-era and usable read-only.** Strip `icons` and `outputSchema` before tools reach an
    LLM (07 §8).

---

## 3. Open decisions for the next chat (with the evidence to decide)

| # | Decision | Options | Evidence / pointer | Leaning (input only) |
|---|---|---|---|---|
| 1 | Gateway build | TS + SDK v2 low-level `Server` behind `createMcpHandler` | 02, 03 | strongly supported by evidence |
| 2 | HTTP framework | Hono 4.13 / Express 5.3 / Fastify 5.12 (all have SDK adapters) | 02 §1 | any; Hono or Express |
| 3 | Dashboard | Vite 8 + React 19 SPA (+ TanStack Query) vs Next 16 | — | SPA (simpler in K8s) |
| 4 | Persistence | Postgres 18 (+ `pg`/Drizzle/Kysely) vs SQLite | 10 §4, 05 | Postgres |
| 5 | Auth implementation | hand-rolled (~300–400 lines) vs Better Auth 1.7 (mind its 10-req/day default rate limit) | 06 §2.4, §3.4 | hand-rolled (interview-explainable) |
| 6 | Chat identity | in-process vs **delegated JWT (`act`)** | 06 §4 | delegated JWT |
| 7 | Chat framework | AI SDK 7 (`toolApproval`, `useChat`) vs LangChain 1 + LangGraph (HITL middleware; Urumi stack signal) vs hand-rolled | 07 §2, **../07 §9** | **both measured 6/6 pass^3 with approvals through our gateway**; choose on UI integration (`useChat`) vs stack signal (LangGraph); mind the adapter's tool-name prefix |
| 8 | LLM default | Groq / NVIDIA / Gemini via OpenAI-compatible interface; **local Ollama Qwen 3.5 9B (verified)** | 07 §4, **../07 §9** | provider-agnostic OpenAI-compatible client; local GPU model for dev/evals/local demo (pods reach `host.k3d.internal:11434`); a hosted free tier for the VPS (needs a key; tool selection to fit TPM); reasoning off |
| 9 | Extra upstreams | public: Cloudflare Docs (modern), DeepWiki (legacy), MS Learn (legacy+session), **GitHub `/readonly` (dual-era, verified, needs a token, ~7 K LLM tokens)**, AWS (verbose), Context7 (CVE history); **plus our own in-cluster server** | 10 §1–2, 07 §8 | own server + DeepWiki (verified in the DoD walk) (+ Cloudflare for modern coverage) |
| 10 | `tools/list` TTL | 0 (agentgateway) vs ~30 s (Kuadrant-like) | 03 §4 | short TTL or 0; always private |
| 11 | Unreachable server's tools | hide after N strikes vs keep listed + fail fast | 03 §2, 09 §2 | keep listed briefly + clear errors; hide after strikes |
| 12 | New/changed tools | default-allow vs quarantine (TOFU) | 03 §4, 08 §4 | quarantine on *change*; first sight via admin approve-on-add |
| 13 | Kill-pod detection | EndpointSlice watch (RBAC) vs call-time + short tick | 09 §2, **07 §14** | measured: pod back in ~2 s; 5 s tick never shows it; 1–2 s tick + 2 s connect timeout shows ~1 s (kill) or holds (scale 0); EndpointSlice flips in ~60 ms; **an in-gateway EndpointSlice watch (SA token + read-only namespace Role) marked it unreachable in ~0.2 s, verified**. Lean: watch for in-cluster upstreams + call-time + 1–2 s tick for external ones + fast re-probe + status history; demo both `delete pod` and `scale 0` |
| 14 | `create_product` default status | publish (DoD needs storefront visibility) vs draft | 04 §2.2, 09 §2 | explicit `status` param, agent passes publish, approval shows it |
| 15 | "Today" for orders | system prompt date+TZ vs tool `period` | 04 §2.3, 09 §2 | both: date in prompt + `created_after` param |
| 16 | Local hostnames | `*.localtest.me`/nip.io vs hosts file vs `localhost` subpaths | 05 §2, 06 §3.2 (Secure cookies), **07 §7** | E7: nip.io/localtest.me/sslip.io resolve here; `*.localhost` fails in Node. Lean: `*.127.0.0.1.nip.io` (or localtest.me) on :8080 |
| 17 | Stand-outs | S-2 (argument rules + TOFU), S-6 (hardening recipe), S-8 (OTel), evals, audit hash chain | 06, 07 §7, 08, 10 §3 | S-2 + S-6, then S-8 if time |

---

## 4. Corrections made in this round

- preStop `sleep`: **GA in K8s 1.34** (beta on by default since 1.30), not 1.32. Fixed in doc 05.
- Traefik `readTimeout` vs SSE: resolved from source, **doesn't cut SSE**. Doc 05 updated; E3 is now a confirmation test.
- Claude Code with static `Authorization`: 401/403 → "connection failed", **no OAuth fallback** (docs, 09 §1). `MCP_TIMEOUT` is
  the server *startup* timeout; `MCP_TOOL_TIMEOUT` defaults to ~28 h; HTTP tool idle timeout is 5 min.
- The k3d default k3s image is **v1.35.5-k3s1** (round-6 correction; round 5 said v1.32.5). Pin `--image
  rancher/k3s:v1.36.5-k3s1` to match the VPS.
- Round 6 (measured, 07 §17):
  - HPOS is **off** after a WP-CLI install;
  - coming-soon is **unset** right after activation;
  - WC secrets must be exactly 43 chars;
  - GitHub's remote MCP is dual-era, with no legacy Mcp-Param requirement observed;
  - Helm 4 hooks don't wait for readiness under `--wait`;
  - the 300 s idle cut comes from the Node `fetch` client, not Traefik.
- Better Auth's API-key plugin enables a **10 requests / 24 h** rate limit by default.
- `@ai-sdk/mcp` speaks both eras (it's its own client, not the official SDK). AI SDK is now **v7** (`isStepCount`,
  `toolApproval`).
- OTel MCP conventions moved to `open-telemetry/semantic-conventions-genai`.

---

## 5. What is verified vs what experiments must still show

**Round 6 update:** all of the experiments below except E11 (Azure VM) and E18 (Cursor, not installed) have run.
See [07 §0](../07-experiment-results.md) for the status table. The original table is kept for history.

| Verified this round (source / probe / prototype) | Still an experiment (why) |
|---|---|
| Spec rules (raw spec files) · SDK behaviour (source) · Woo/WP behaviour (source) · Traefik/Go timeout semantics (source) · Helm/k8s flags (docs/source) · SSRF bypasses and guard (prototype) · public upstream eras/tools (live probe) · Node crypto primitives (local run) | **E1** Claude Code ↔ our endpoint both eras + listen push · **E3** listen > 5 min through Traefik (confirmation) · **E4** revoke UX in Claude Code/Inspector/Cursor · **E5** in-cluster Basic auth + `mcp_store_agent` caps under HPOS · **E7** k3d on this box (serverlb, winnat ports, hostnames, NetworkPolicy negative test, no restarts) · **E8** LLM quotas + tool calling today · **E12** DeepWiki/MS Learn through our client (sessions, 404 re-init) · **E13** soak · **E14** 404 re-init · **E16** scripted DoD · **new E17** kill-pod detection timing · **new E18** Cursor header-on-tools/call bug |

---

## 6. Version pins (2026-10-09/10)

| Area | Pins |
|---|---|
| MCP | spec 2026-07-28 (+ legacy 2025-11-25…2025-03-26) · `@modelcontextprotocol/server` 2.3.1 · `/client` 2.3.1 · `/node` 2.1.1 · `/express` 2.0.2 · Inspector 2.10.1 · Claude Code 2.1.295 |
| Runtime | Node 24 LTS (`node:24-alpine`; `crypto.argon2` ≥ 24.7) · Postgres 18.6-alpine · MariaDB 11.4.13 |
| Store | WordPress 7.1.3 (`wordpress:7.1.3-php8.4-apache`) · WooCommerce 11.2.0 · WP-CLI 2.12.0 |
| Cluster | k3s v1.36.5+k3s1 (Traefik 3.7.13) · k3d 5.9.0 (default k3s v1.35.5, so pin) · Helm 4.3.0 · cert-manager 1.21.2 |
| Dev box (round 6) | Docker Desktop 29.7.2 · Node 24.21.0 via fnm (default 22.16) · Ollama 0.40.2 (models on E:) · RTX 4060 Laptop 8 GB · Claude Code 2.1.296 (VS Code binary) |
| Web/backend | Hono 4.13.13 / Express 5.3.0 / Fastify 5.12.5 · React 19.3.0 · Vite 8.3.4 · TanStack Query 5.104.1 · zod 4.6.5 · pino 10.4.0 · `@opentelemetry/sdk-node` 0.223.0 · vitest 5.0.3 · Playwright 1.64.0 · undici 8.11.2 · jose 6.2.12 · pg 8.23.1 |
| Chat | `ai` 7.0.137 · `@ai-sdk/mcp` 2.0.73 · `langchain` 1.5.16 · `@langchain/langgraph` 1.4.21 · `@langchain/mcp-adapters` 2.0.1 |

Re-check these on build day; several moved within the last week.
