# 04 — Deep Dive: Solution Internals, Reusable Patterns, Free Options

Research round 3, 2026-10-09. Builds on [02](02-landscape-research.md) (landscape) and [03](03-knowledge-base.md) (concepts).
Tags: **[code]** read in source/design docs · **[docs]** official docs · **[probe]** measured by us · **[reported]**
secondary/vendor claims. Still no decisions; §6 proposes how to use the remaining time.

---

## 0. What this round added (top findings)

1. **Pass-through vs terminating gateways is the key fork.** Envoy-based gateways (Kuadrant) explicitly *don't translate
   eras*: "a 2026 client connecting to a gateway with only 2025 backends… tools/list returns no tools" [code]. A
   terminating gateway (an MCP server + per-upstream MCP clients) translates for free. With Claude Code modern-by-default and
   half of public servers legacy, this matters for our demo.
2. **The TS SDK v2 serving model fits a gateway exactly** [docs]: `createMcpHandler(factory)` builds a fresh server *per
   request*, and the factory receives `{ era, authInfo, requestInfo }`, so it can register **only the caller's permitted
   tools**. `handler.notify.toolsChanged()` feeds `subscriptions/listen` streams; multi-replica needs a shared
   `ServerEventBus`. Legacy clients are served statelessly by default (legacy GET/DELETE → 405, so no push for them).
   `requireBearerAuth` needs an `expiresAt` on every verified token.
3. **Claude Code's listen-stream retry budget is finite** [docs]: if a stream that lived over 10 s closes, it retries up
   to 5 times per hour, then waits about 6 hours. If our server or proxy cuts idle streams, live tool updates (D-8) silently
   stop. So we need SSE keep-alive comments and generous proxy timeouts.
4. **Modern-spec mechanics a gateway must honour** [docs]: cancellation = client closes the stream (propagate an abort
   upstream); unknown method = **404 + -32601**; header/body mismatch = 400 + -32020; listen streams want keep-alives and
   `X-Accel-Buffering: no`.
5. **Envoy AI Gateway's encrypted composite session ID** [reported/docs]: all upstream session IDs are sealed into one
   client session ID that any replica can decode. That makes the gateway stateless with stateful upstreams. KDF cost: tens of ms
   at 100k iterations, 1–2 ms at ~100.
6. **The IETF CB4A draft names our architecture** [docs]: "Model A, proxy gateway: the agent never receives credentials;
   the gateway injects them on egress", and rates **broker compromise as CRITICAL** (envelope encryption, no shell, restricted
   network).
7. **Christian Posta's five upstream-auth patterns** [docs] classify the brief's shared static credential as "service
   account access", which carries a confused-deputy risk and bypasses upstream RBAC. That framing is honest for the threat
   model (DL-5a).
8. **State-of-the-art injection defences at the gateway** [code/docs]:
   - GitHub's own agentic-workflow gateway does **DIFC**: integrity levels by author role (`merged` > `approved` >
     `unapproved` > `none`), approval labels, per-session tool-call limits, write-sinks with secrecy labels.
   - Open Edison does per-session **taint/ACL tracking** ("no write-down").
   - mcpproxy-go has **quarantine + intent-typed calls**.
   - Trail of Bits' **TOFU pinning** blocks calls when descriptions or schemas change.
   - ThinkWatch strips **Unicode tag/bidi characters**.
   - Archestra uses a **dual-LLM** setup with multiple-choice-only answers.
9. **Agent-security research has deterministic answers.** **Progent** (JSON-Schema policies on tool *arguments*, forbid-before-allow,
   fallback actions) took AgentDojo attack success from 39.9% to **0%** with utility intact. **MCP-DPT** gives a six-layer
   defence-placement taxonomy (primary + secondary layer per attack).
10. **E-commerce agents are demonstrably manipulable**: in Microsoft's Magentic Marketplace, some models were fully hijacked by
    product-description injection, with all payments redirected [reported].
11. **Many-tools engineering numbers:**
    - Input schemas are 60–80% of tool tokens; search → describe → execute keeps 100% success while cutting tokens about 90%
      (Speakeasy, 40–400 tools).
    - Hybrid BM25+embeddings got 94% vs 34% selection on 2,792 tools (Stacklok, vendor benchmark).
    - Retrieval errors are about 50% of failures (LiveMCPBench).
    - Models don't search if they can't see what exists (Speakeasy v1).
12. **WooCommerce traps:**
    - Fresh stores start in **"Coming soon" mode** (WooCommerce ≥ 9.6).
    - API **consumer secrets are stored in plaintext** (needed for OAuth HMAC) while keys are HMAC-hashed.
    - Requirements: PHP 8.3+, MySQL 8.0+/MariaDB 10.6+, 256 MB memory.
    - No idempotency keys (a unique SKU helps).
13. **Free/student reality (verified today):**
    - **DigitalOcean left the GitHub Student Pack on 2026-07-31.**
    - **Azure for Students: $100, no card**; B2as_v2 (2 vCPU/8 GB) is about $36/mo in Central India.
    - Free 1-year domains via the Pack (Name.com, Namecheap `.me`, `.TECH`).
    - **DuckDNS is on the Public Suffix List; sslip.io/nip.io are not**, which matters for Let's Encrypt.
    - Cloudflare *quick* tunnels **don't support SSE**.
14. **Peer signal:** Razorpay's FDE assignment is also a WooCommerce MCP connector (HEMANTHSWAMY26), and another candidate in
    this Urumi round created an empty repo yesterday. FDE hiring rounds converge on "MCP + commerce".

---

## 1. Deep dives: how specific solutions work inside

### 1.1 Kuadrant MCP Gateway (Red Hat, Envoy + Gateway API) [code: docs/design]
- **Three components:**
  - **Router**: Envoy ext_proc that parses JSON-RPC, sets `x-mcp-servername`/`x-mcp-toolname`/session headers so Envoy routes
    `tools/call` straight to the backend, and invalidates sessions on 404.
  - **Broker**: the default `/mcp` backend; it is the MCP client to every upstream (init, `tools/list`, notifications), builds
    the aggregated list, and validates upstreams meet minimum protocol/capabilities.
  - **Discovery controller**: watches `MCPServerRegistration` CRDs → HTTPRoutes → writes a config Secret.
- **Naming:** per-server `prefix` (e.g. `weather_`); servers with private/per-user lists *must* have a prefix (routing
  fallback).
- **Dual-era:** a `ProtocolHandler` interface (2025 vs 2026 implementations) isolates version logic, so dropping 2025 is a clean
  delete. Pre-cached **stateful vs stateless tool sets** are served by client version. `server/discover` advertises only versions
  with backend support. Explicit `/mcp/stateful` and `/mcp/stateless` routes.
- **Caching:** store upstream `ttlMs/cacheScope` per result type; aggregate `min(non-zero ttlMs)`; any private input means
  the whole response is private; a scope change triggers an immediate rebuild.
- **AuthZ:** Keycloak realm where each MCP server is a *client* and each tool a *role*; group role mappings decide tool access;
  Authorino validates/exchanges tokens.
- **Local dev:** kind + Istio + `mcp.127-0-0-1.sslip.io`.
- **Take-aways:** the ProtocolHandler isolation idea; pessimistic cache-scope aggregation; "tools as roles" mental model; CRD
  registration is the K8s-native analogue of our "pre-registered WooCommerce server" (M-GW-9) and bonus auto-registration (B-3).

### 1.2 MCP TypeScript SDK v2 as a gateway substrate [docs]
- `createMcpHandler(factory, { bus, legacy: 'stateless' | 'reject', responseMode })` → `{ fetch, close, notify, bus }`.
- The factory runs **per request** and receives `{ era, authInfo, requestInfo }`, so a per-caller catalog is natural.
- Auth is pass-through: verify in front (`requireBearerAuth({ verifier })` or our own middleware) and call
  `handler.fetch(req, { authInfo })`; tools read `ctx.http.authInfo`. Note the `expiresAt` requirement.
- Host/Origin validation is *not* in the handler: use `createMcpExpressApp({ allowedHosts })` /
  `hostHeaderValidationResponse`.
- Client side: `versionNegotiation: { mode: 'auto' }`, `connect(transport, { prior })` with cached `DiscoverResult` or
  `{ kind: 'legacy' }`; `listen()` for upstream notifications. Key cached verdicts by URL + credential; date legacy verdicts.
- `isLegacyRequest` + `legacyStatelessFallback` let you route sessionful legacy traffic separately if ever needed.

### 1.3 Envoy AI Gateway (Tetrate/Envoy) [reported/docs]
- An MCP proxy as a lightweight Go server alongside Envoy; `MCPRoute` with regex tool filters; aggregation/merge/filter of
  multiple backends.
- **Encrypted composite session ID** (KDF-derived key; tamper-proof; hides topology); configurable iterations trade security
  for latency (100k → tens of ms per new session; ~100 → 1–2 ms).
- Rejected "UUID + Redis session store" to avoid stateful infrastructure. (Stateless 2026 clients make this moot for
  modern traffic; it remains relevant for legacy sessions.)

### 1.4 agentgateway (Linux Foundation) [code]
Era bridging notes (forward `server/discover`, intersect versions, error on any legacy upstream so the client falls back);
FailClosed default with FailOpen option; `prefixMode` (prefix vs resolve-by-listing); CEL `mcpAuthorization` per tool and
target `condition`s; strict "no caching of proxied results". Also the CB4A Model-A credential-injection blog: leg 1 IdP auth
at connect, leg 2 elicitation for upstream OAuth with an STS keyed by (user, resource).

### 1.5 GitHub `gh-aw-mcpg` (gateway for GitHub Agentic Workflows) [code]
- Routed (`/mcp/{serverID}`) and unified modes; per-server `connectTimeout`/`toolTimeout` (default 60 s); session timeout 6 h.
- **Guard policies (DIFC):**
  - `allow-only` on source servers: repo scope + `min-integrity` (`merged` > `approved` > `unapproved` > `none`, plus `blocked`).
    Integrity derives from the author's role; `approval-labels` and `trusted-users` raise it; `blocked-users` always deny.
  - **Per-session `tool-call-limits`.**
  - `write-sink` on output servers accepts only matching secrecy labels (`private:owner/repo`), so data read from a private
    repo can only flow to sinks cleared for it.
- Large payloads are spilled to disk (`payloadSizeThreshold` 512 KB) and referenced instead of flooding the model.
- Practical bug they documented: some HTTP backends demand `Mcp-Session-Id` even on the first call, so they mint a
  temporary `awmg-init-{id}`.
- **Analogue for us:** content integrity by author role, i.e. admin-created products are `approved`, member-created
  `unapproved`, customer-entered checkout text `none`. A guard could tag or spotlight low-integrity fields before they reach the
  model, and cap destructive calls per session.

### 1.6 ThinkWatch (Rust, BSL) [docs]
- Two ports: **gateway :3000 public, console :3001 behind VPN/firewall**.
- **MCP tool calls run as the real user** (per-user OAuth/PAT, encrypted at rest), **tool lists cached per user**,
  per-tool grants per role and per key.
- **`tw-` virtual keys stored only as hashes, rotation with grace period**, scoped to AI gateway / MCP gateway / both.
- Guards with **observe → enforce modes**: outbound redaction with placeholders (`<<TW_EMAIL_1>>`) restored in responses;
  tool-call inspection; content rules for injection phrases and **hidden characters (U+200B, U+E0000–E007F)**.
- Rate limits (sliding windows) apply to MCP tool calls; Redis-down → fail open by default (configurable).
- Not-yet-connected user calling a tool gets JSON-RPC `-32050` with the authorisation URL.
- Audit in ClickHouse; SIEM forwarding. Helm chart generates secrets on install and keeps them on upgrade.

### 1.7 MCP Gateway & Registry (agentic-community, AWS origin) [docs]
- nginx **data plane** with `auth_request` to an auth server; FastAPI **control plane** (registry, access model, audit);
  MongoDB/DocumentDB.
- **Fail-closed SSRF/egress guard** for every outbound fetch: decrypted credentials bound to the exact validated destination;
  **pooled HTTP clients keyed on the SSRF-validated IP** (rebind-safe); IMDS fallback disabled.
- Scanner-flagged tools get their own block (not the whole server); a "borrowed identity lists tools but never calls one";
  ADR "no server-side DCR"; per-user egress auth (3LO/OBO/PAT); "Theory of the System" doc.

### 1.8 MCPHub, Gate22, MCP Mesh (team-oriented control planes) [docs]
- **MCPHub** (TS/React/Postgres+pgvector): `/mcp`, `/mcp/{group}`, `/mcp/{server}`, `/mcp/$smart` (vector routing);
  per-user credentials bound to a shared server; tool-result compression; health checks; logs.
- **Gate22:** admins set **credential mode per configuration: org-shared or per-user**; function allow-lists; users compose
  "bundles" exposed as one endpoint with **two tools, search + execute**; **tool list refresh + diff view** before use.
- **MCP Mesh / deco Studio** (TS, Hono, React 19, Better Auth): org/project multi-tenancy, encrypted token vault,
  tool-scoped API keys, **Virtual MCPs with strategies** (full-context / smart selection / code execution), OTel cost/latency
  per user/agent/connection; "share capabilities, not credentials".

### 1.9 Security wrappers [docs/code]
- **Trail of Bits mcp-context-protector:**
  - TOFU on server instructions + tool descriptions + input schemas. New servers are blocked, and any change blocks the
    affected tools (instruction change blocks the whole server) until re-approved.
  - Guardrail scanning (LlamaFirewall) with a **quarantine** for suspicious tool responses.
  - ANSI ESC replaced with the visible text "ESC".
  - Limits they acknowledge: it lacks conversation context, and alert fatigue argues for centralised review, i.e. a gateway
    with an admin approval step.
- **Snyk Agent Scan (ex-Invariant mcp-scan):** static scan + proxy mode; **tool pinning by hash** for rug pulls; cross-origin
  (shadowing) detection.
- **mcpproxy-go:**
  - Quarantine until approval; pluggable scanners (Snyk/Semgrep/Trivy → SARIF risk score).
  - `retrieve_tools` BM25.
  - **`call_tool_read/_write/_destructive`** validated against annotations.
  - "tool changed since approval" preflight; activity log with request ids.
- **Open Edison:** per-tool flags `{write_operation, read_private_data, read_untrusted_public_data, acl}`; tracks the session's
  highest ACL; blocks writes to lower ACL (trifecta detection).
- **Archestra Dual-LLM:** quarantine agent sees raw output but only answers integer choices posed by the main agent.
- **Lasso gateway:** plugins for secret masking, Presidio PII masking, server reputation scanning.

### 1.10 Community WooCommerce MCP servers [docs]
- `aman-bhandari/woocommerce-mcp-connector`:
  - **write tools not registered unless `WOO_ALLOW_WRITES=true`**.
  - Rejects plain-HTTP stores; per-attempt timeout 15 s + **total deadline 50 s** incl. retries.
  - Query-string auth fallback for hosts that strip `Authorization`.
  - Smoke script incl. negative auth check; errors never leak credentials.
- `HEMANTHSWAMY26/razorpay-fde-woocommerce-connector` (another company's FDE assignment, Python MCP SDK v2.3.0): **read-only by
  construction**, retries with backoff + jitter respecting `Retry-After`, normalized response envelope with pagination, dual
  transports, 64 tests.
- `techspawn` (most-starred): exhaustive REST-mirroring toolset, which is the anti-pattern versus WooCommerce's
  "business operations" guidance.

### 1.11 Many-tools implementations [docs]
| System | Meta-tools | Notes |
|---|---|---|
| Speakeasy Gram v2 | `search_tools` (embeddings + category overview + tag filters), `describe_tools`, `execute_tool` | 40–400 tools, Sonnet 4.5: −96% input tokens, 100% success, 2–3× more calls, +50% time |
| Klavis Strata | `discover_server_categories_or_actions`, `get_category_actions`, `get_action_details`, `execute_action` | servers → categories → actions → schema; +13–15% pass@1 vs official GitHub/Notion servers on MCPMark [reported] |
| Stacklok MCP Optimizer | `find_tool` (hybrid BM25+embeddings), `call_tool` | 94% vs 34% (Anthropic tool search, BM25) on 2,792 tools [vendor] |
| Gate22 | `search`, `execute` | per-bundle |
| mcpproxy-go | `retrieve_tools` + intent-typed `call_tool_*` | BM25 |
| AWS AgentCore | `x_amz_bedrock_agentcore_search` | managed |
| Kuadrant broker | `discover_tools`, `select_tools` | stateful clients only |

---

## 2. Pattern catalogue (reusable ideas, rated for a 1.5-week build)

Fit: **C** = helps core/DoD · **S-n** = stand-out item · **B** = bonus · **T** = threat-model/demo narrative only.
Effort: S ≤ ½ day, M ≈ 1 day, L > 1 day.

| # | Pattern | Source | Fit | Effort | Why / risk |
|---|---|---|---|---|---|
| P1 | Terminating gateway: SDK server per request + SDK client per upstream | MetaMCP, ContextForge, SDK v2 | C | — | Era translation for free; foundation |
| P2 | Per-request factory registers only the caller's permitted tools | SDK v2 factory `authInfo` | C, S-2 | S | "Hidden from list" for free |
| P3 | Same check again on call (never trust the client's cached list) | Docker/agentgateway rule | C, S-2 | S | D-8 correctness |
| P4 | Catalog served from background-refreshed cache; fan-out only on refresh, in parallel with per-upstream deadlines | ContextForge health loop, Kuadrant broker | C | M | Listing never blocks on a slow upstream |
| P5 | Status machine Disabled/Connected/Unreachable + reason classes + thresholds | ContextForge ADR-009 | C, S-8 | S | D-9 + "why unreachable" |
| P6 | Passive marking on call failure + fast active probe | — | C | S | D-9 timing |
| P7 | EndpointSlice watch for in-cluster upstreams (instant unready detection) | K8s-native | S-8 | M | Needs read RBAC; nice K8s story |
| P8 | `slug__tool` naming with admin-chosen short slug; store (upstream id, original name) | agentgateway/MetaMCP/ContextForge ADR-011 | C | S | LLM-safe, Claude Code budget |
| P9 | Client disconnect → AbortSignal → cancel upstream fetch | 2026 spec cancellation | C | S | Correctness |
| P10 | `isError` results with classified, human-readable reasons; no secrets in messages | spec + community servers | C | S | M-GW-5 |
| P11 | Prefixed, checksummed API keys (`urk_<id>_<secret>_<crc>`), SHA-256/HMAC-pepper storage, show once, expiry, rotation grace | GitHub tokens, ThinkWatch, MetaMCP | C | S | Attribute rejected calls; secret-scanning friendly |
| P12 | Chat agent identity = short-lived token `sub=user, act=chat-agent, aud=gateway` (or in-process principal) | RFC 8693 `act`, Posta patterns | C | S | M-CA-2 + "via" column in audit |
| P13 | Write-only upstream credential field; envelope-encrypted at rest (KEK from K8s Secret) | CB4A, ThinkWatch, Mesh vault | C, S-6 | S | Never echo secrets |
| P14 | Upstream sessions never shared across users for stateful upstreams | ContextForge #4205 | C, T | S | Real leak precedent |
| P15 | Cache keyed by auth context; re-export `cacheScope: private` | Asana incident, Kuadrant | C | S | Leak prevention |
| P16 | SSE keep-alive comments + `X-Accel-Buffering: no` + Traefik timeouts verified | spec + Claude Code retry budget | C | S | D-8 reliability |
| P17 | `subscriptions/listen` push via `handler.notify.toolsChanged()` on admin changes | SDK v2 | C | S | Live D-8 |
| P18 | Shared `ServerEventBus` (Redis) for multi-replica | SDK v2 docs | S-7 | M | Only if doing scaling |
| P19 | Role/tool allowlists + argument predicates (forbid-before-allow) | Progent, Kong, LiteLLM | S-2 | M | Mirrors Urumi "read-only first" |
| P20 | New-server quarantine + TOFU pinning (hash descriptions+schemas) + diff/approve UI | ToB, mcpproxy-go, Gate22, Snyk | S-6, T | M | Answers "malicious upstream" question |
| P21 | Description/schema sanitiser: length caps, strip Unicode tag/bidi/zero-width, ESC | ThinkWatch, ToB | S-6, T | S | Line-jumping defence |
| P22 | Provenance tagging of store content (admin vs member vs customer) + spotlighting in agent context | GitHub DIFC, Spotlighting | T, S-6 | M | Member-vs-member injection |
| P23 | Session taint: after reading PII, block exfil-capable tools in that chat session | Open Edison, CaMeL | T, S-6 | M | Lethal-trifecta containment |
| P24 | Per-session/per-key rate limits and per-session tool-call caps | ThinkWatch, gh-aw-mcpg | S-7 | S | Abuse & quota exhaustion |
| P25 | SSRF guard with dial-time validation, IP-pinned pools, redirect checks, allowlist for in-cluster targets | Docker, mcp-gateway-registry | S-6 | M | undici `fetch` ignores `agent` (use a dispatcher) |
| P26 | OTel semconv metrics/spans (`mcp.server/client.operation.duration`), `/metrics` not exposed via Ingress | OTel, geekyhead | S-8 | M | Per-server latency/error rate |
| P27 | Audit with argument *shape* or redacted args; via/actor; key id on rejections; optional hash chain | Docker, ContextForge, Wirken | C (+S-6) | S | PII-aware audit |
| P28 | search/describe/execute meta-tools + category overview (+BM25) | Speakeasy, Gate22, Klavis | S-4 | M | Our chat agent benefits directly |
| P29 | WooCommerce tools as business operations; line items opt-in; concise/detailed `response_format`; enums; SKU idempotency; writes off unless enabled | WooCommerce canonical abilities, Anthropic tool guide, community servers | C | S | Reviewers' own design language |
| P30 | Immutable WordPress image (static recipe), uploads PVC, bootstrap Job (Coming-soon off, COD on, timezone, API key → Secret) | official image docs, Urumi | C, S-9 | M | Employer philosophy; meaningful rollback |
| P31 | Annotation/CRD-driven auto-registration of in-cluster MCP servers | Kuadrant CRD, cloudflared annotations | B-3, M-GW-9 | M | Clean bonus path |
| P32 | Encrypted composite session ID for legacy clients across replicas | Envoy AI Gateway | S-7 | L | Only if legacy multi-replica matters |
| P33 | Dual-LLM quarantine for untrusted results | Archestra, CaMeL | T | L | Too costly for timeline; cite only |
| P34 | Two-port split: public MCP endpoint vs admin API only via dashboard host | ThinkWatch | S-6 | S | Smaller public surface |
| P35 | Health/smoke test via MCP Inspector CLI `--format json` in `helm test` or CI | Inspector v2, Kuadrant e2e | C, S-9 | S | Repeatable DoD check |

---

## 3. Research papers worth citing

| Paper | ID | Key result | Use |
|---|---|---|---|
| MCP: Landscape, Security Threats, Future Directions (Hou et al., FSE 2026 journal-first) | arXiv 2503.23278 | server lifecycle (4 phases, 16 activities), 4 attacker types, 16 threat scenarios | threat model structure |
| SoK: Security and Safety in the MCP Ecosystem | arXiv 2512.08290 | taxonomy (adversarial vs epistemic; topology risks) | threat model |
| MCP-DPT: Defense-Placement Taxonomy | arXiv 2604.07551 | 6 layers; primary/secondary defence per attack; transport & host layers weakest | "where isolation is enforced" |
| MCPTox | arXiv 2508.14925 | 45 real servers; tool-poisoning ASR up to 72.8% | motivates gateway-side controls |
| MCP-Guard | arXiv 2508.10991 | 3-stage detection pipeline; MCP-AttackBench 70k samples | optional scanning |
| MCPGuard (server vuln detection) | arXiv 2510.23673 | agent hijacking, web vulns, supply chain | — |
| Design Patterns for Securing LLM Agents | arXiv 2506.08837 | action-selector, plan-then-execute, dual LLM, context minimisation… | chat-agent design |
| CaMeL (Google DeepMind) | arXiv 2503.18813 | capabilities + control/data-flow separation; 77% tasks with provable security | IFC rationale |
| **Progent** | arXiv 2504.11703 | JSON-Schema privilege policies; ASR 39.9% → 0% on AgentDojo | S-2 design |
| ETDI | arXiv 2506.01333 | signed, versioned tool definitions; re-approval on change | rug-pull defence |
| Spotlighting | arXiv 2403.14720 | datamarking untrusted input | agent context hygiene |
| RAG-MCP | arXiv 2505.03275 | 43.1% vs 13.6% selection, >50% fewer prompt tokens | S-4 |
| MCP-Zero | arXiv 2506.01056 | active tool requests + hierarchical routing; 98% token reduction (APIBank) | S-4 |
| ScaleMCP | — | agent-generated retrieval queries; 5,000 servers | S-4 |
| LiveMCPBench | arXiv 2508.01780 | 70 servers/527 tools; best 78.95%; **retrieval ≈ 50% of failures** | S-4 motivation |
| MCP-Bench (Accenture) | arXiv 2508.20453 | 28 servers/250 tools, fuzzy instructions | eval ideas |
| Magentic Marketplace (Microsoft) | MSR 2025 | agents manipulated by descriptions; first-offer bias | e-commerce threat narrative |

---

## 4. Free and student options (verified 2026-10-09)

### 4.1 Compute for the production-like VPS (S-1 / the brief's "deployable to a VPS")

| Option | Cost to you | Card? | Spec that fits | Time to ready | Risk |
|---|---|---|---|---|---|
| **Azure for Students** | $100 credit, 12 months | **No** | B2as_v2 2 vCPU/8 GB ≈ $36/mo (Central India) → ~2.5 months | minutes (student verification) | region/size availability; stop VM when idle |
| Oracle Cloud Always Free (ARM A1) | $0 | Yes (verification) | up to 4 OCPU/24 GB (reportedly being cut to 2/12) | **capacity errors common; PAYG upgrade takes 1–2 days** | ARM → multi-arch images; timeline risk |
| GCP free trial | $300 / 90 days | Yes | e2-standard-2 (8 GB) | minutes | card required |
| AWS free plan | $100 (+$100 via tasks) / 6 months | Yes | t3.medium-ish | minutes | credits drain |
| Heroku (Student Pack) | $13/mo × 24 | — | not Kubernetes | — | not suitable |
| DigitalOcean | **left the Student Pack 2026-07-31** | — | — | — | — |
| Local cluster + Cloudflare **named** tunnel | $0 | No (needs a domain on Cloudflare) | your laptop | an hour | not a "VPS"; laptop must stay on; quick tunnels lack SSE |

Sizing reality: WordPress (≥256 MB PHP, realistically 512 MB–1 GB limit) + MySQL (~512 MB–1 GB) + gateway + dashboard +
WooCommerce MCP + 1–2 in-cluster upstreams + k3s itself (~500 MB) means **4 GB is tight, 8 GB comfortable**.

### 4.2 DNS and TLS
- **DuckDNS** (free; on the PSL, so per-subdomain Let's Encrypt limits; cert-manager HTTP-01 through Traefik works; DNS-01 via
  webhook).
- **Student-pack domain** (Name.com 1 yr + SSL, Namecheap `.me` 1 yr, `.TECH` 1 yr), then free Cloudflare DNS.
- `sslip.io`/`nip.io` for IP-based hostnames: fine for HTTP and local; **not on the PSL**, so Let's Encrypt shares a 50/week
  registered-domain limit across all users (inference) and issuance may fail.

### 4.3 LLM for the chat agent
| Option | Free limits (indicative) | Notes |
|---|---|---|
| Gemini API free tier | per-model RPM/RPD in AI Studio; Flash models free | OpenAPI-subset schemas (sanitise); free-tier data used to improve products |
| Groq free | 30 RPM, 1K RPD, **8K TPM** (gpt-oss-120b/20b, qwen3.8-27b) | fast; TPM tight with many tools |
| ~~GitHub Models~~ | **Retired 2026-07-30** (see 05 §1) | no longer an option |
| NVIDIA API catalogue | ~40 RPM, rate-limited only (added in 05 §2.7) | tool calling varies by model |
| OpenRouter `:free` | ~50 req/day unfunded | variable quality |
| Anthropic | ~$5 starter credit; student credits by application | can't count on it in 1.5 weeks |
| Local (Ollama) | free | heavy for laptop + cluster |

---

## 5. Experiments backlog (updated, prioritised)

| # | Question | Priority | Why |
|---|---|---|---|
| E1 | Claude Code (current) against an SDK v2 dual-era endpoint: modern negotiation? opens listen? refreshes on `toolsChanged`? | **P0** | D-4/D-5/D-8 |
| E4 | Claude Code behaviour on revoked key: 401 with/without `WWW-Authenticate`, 403, JSON-RPC error. Which shows a clear message without OAuth detours? | **P0** | D-7 |
| E5 | WooCommerce REST in-cluster: OAuth 1.0a (public home-URL base string) vs `X-Forwarded-Proto` Basic vs App Passwords | **P0** | Layer 2 |
| E7 | k3d on Windows/Docker Desktop: Traefik host routing on `*.127.0.0.1.nip.io` / `*.localhost`; NetworkPolicy enforced; local-path PVCs | **P0** | Everything local |
| E3 | Traefik (k3s default) + long-held listen stream with/without keep-alives: cut at 60/180 s? | P1 | D-8 reliability |
| E6 | SDK v2 client vs each legacy signal from 02 §4.1 (400, -32601, -32602, session-required) | P1 | era fallback |
| E8 | Gemini Flash (free) tool-calling with ~15–25 sanitised MCP schemas; Groq as fallback | P1 | M-CA-3 |
| E9 | Kill-pod → dashboard "Unreachable" latency (active probe vs passive vs EndpointSlice) | P1 | D-9 |
| E10 | Immutable WP image + bootstrap Job idempotent across `helm upgrade` (Coming-soon off, COD on, key → Secret) | P1 | Layer 1 |
| E2 | MCP Inspector v2 CLI/web and Cursor against the gateway | P2 | alt clients |
| E11 | Azure for Students VM: k3s + cert-manager + DuckDNS end to end | P2 | S-1 |
| E12 | Two candidate extra upstreams: liveness, auth, era, a natural cross-server prompt with the store | P1 | D-6, M-GW-7 |

---

## 6. Time reality and a suggested way forward (recommendation, not a decision)

Today is Friday 2026-10-09; "1.5 weeks" puts the deadline around **Mon–Tue 2026-10-19/20** (please confirm the exact date and
time zone). The brief says "a working core is worth more than an unfinished bonus", and the demo video plus docs take real time.
Suggested shape:

| When | Focus |
|---|---|
| Day 1 (Sat 10) | Lock architecture + stack; run P0 experiments (E1, E4, E5, E7) as throwaway spikes |
| Days 2–5 (Sun 11 – Wed 14) | Core build: store chart + bootstrap → WooCommerce MCP server → gateway (catalog, routing, auth, audit, health) → dashboard → chat agent |
| Day 6 (Thu 15) | DoD flow end to end with two users; fix; NetworkPolicies, probes, limits everywhere |
| Day 7 (Fri 16) | VPS (Azure for Students + k3s + DuckDNS/cert-manager) with values-prod; upgrade/rollback check |
| Day 8 (Sat 17) | One stand-out item in depth (likely S-2 tool permissions and/or S-6 hardening, which fit Urumi's "read-only first" ethos) |
| Day 9 (Sun 18) | README, design/tradeoffs note, threat model note; record demo video |
| Day 10 (Mon 19) | Buffer + submit |

The research base is now broad enough to decide. The next useful step is **choosing the architecture and stack**, not more
reading.

---

## Sources (this round)

- MCP 2026-07-28: [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) · [Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle) · [Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- TS SDK v2 docs: [serving/http](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md) · [sessions-state-scaling](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md) · [legacy-clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md) · [authorization](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md) · [notifications](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md)
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- Kuadrant: [design overview](https://github.com/Kuadrant/mcp-gateway/blob/main/docs/design/overview.md) · broker-2026-07-28 and single-gateway-dual-protocol design docs (same repo)
- Envoy AI Gateway: https://theagentrouter.ai/blog/mcp-implementation/ · https://theagentrouter.ai/blog/mcp-in-envoy-ai-gateway/ · https://tetrate.io/blog/envoy-ai-gateway-mcp-performance
- Stateless MCP for gateways: https://dev.to/bengreenberg/what-stateless-mcp-changes-for-gateways-74h
- Christian Posta: https://blog.christianposta.com/mcp-authorization-patterns-upstream-api-calls/ ; agentgateway CB4A: https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/
- GitHub gh-aw-mcpg: https://github.com/github/gh-aw-mcpg
- ThinkWatch: https://github.com/ThinkWatchProject/ThinkWatch ; MCP Gateway & Registry: https://github.com/agentic-community/mcp-gateway-registry
- MCPHub: https://github.com/samanhappy/mcphub ; Gate22: https://github.com/aipotheosis-labs/gate22 ; MCP Mesh: https://github.com/decocms/mesh
- mcpproxy-go: https://github.com/smart-mcp-proxy/mcpproxy-go ; Open Edison: https://github.com/Edison-Watch/open-edison ; Archestra dual LLM: https://mintlify.wiki/archestra-ai/archestra/security/dual-llm
- Trail of Bits: https://blog.trailofbits.com/2025/07/28/we-built-the-security-layer-mcp-always-needed/ ; Snyk/Invariant mcp-scan: https://invariantlabs.ai/blog/introducing-mcp-scan ; Lasso: https://github.com/lasso-security/mcp-gateway
- awesome-mcp-gateways: https://github.com/e2b-dev/awesome-mcp-gateways
- Anthropic, writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Speakeasy dynamic toolsets: https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2 ; Stacklok optimizer: https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/ ; Klavis Strata: https://www.klavis.ai/docs/concepts/strata ; GitHub MCP server config: https://github.com/github/github-mcp-server
- Papers: Progent https://arxiv.org/abs/2504.11703 · MCP-DPT https://arxiv.org/abs/2604.07551 · MCP-Guard https://arxiv.org/abs/2508.10991 · MCPGuard https://arxiv.org/abs/2510.23673 · Hou et al. https://arxiv.org/abs/2503.23278 · MCP-Zero https://arxiv.org/abs/2506.01056 · LiveMCPBench https://arxiv.org/abs/2508.01780 · MCP-Bench https://arxiv.org/abs/2508.20453 · Magentic Marketplace https://microsoft.com/en-us/research/publication/magentic-marketplace-an-open-source-environment-for-studying-agentic-markets/
- Identity drafts: https://workos.com/blog/oauth-on-behalf-of-ai-agents · https://www.ietf.org/archive/id/draft-sweeney-wimse-credential-delegation-00.html
- WooCommerce: [Coming soon by default](https://developer.woocommerce.com/2025/01/17/developer-advisory-coming-soon-mode-by-default/) · [server requirements](https://woocommerce.com/document/server-requirements/) · source `class-wc-auth.php`, `wc-core-functions.php`
- Community Woo MCP: https://github.com/aman-bhandari/woocommerce-mcp-connector · https://github.com/HEMANTHSWAMY26/razorpay-fde-woocommerce-connector · https://github.com/techspawn/woocommerce-mcp-server
- Free/student: [Student Pack partners](https://github.com/github-education-resources/Student-Developer-Pack-Current-Partners-FAQ) · [Azure for Students](https://azure.microsoft.com/en-us/free/students) · Azure retail prices API · [AWS free plan](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/) · [Oracle PAYG capacity](https://www.quantrocket.com/installation/oracle/) · [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat) · [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) · [GitHub Models](https://github.blog/changelog/2025-06-24-github-models-now-supports-moving-beyond-free-limits/) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini schema subset issue](https://discuss.ai.google.dev/t/gemini-api-2-0-flash-exp-requires-non-empty-properties-for-open-ended-object-parameters/64086) · [Claude campus programs](https://claude.com/programs/campus)
