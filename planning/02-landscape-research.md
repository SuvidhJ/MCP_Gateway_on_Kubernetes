# 02 — Landscape Research: Existing Solutions, Evidence and Interactions

Research date: 2026-10-09. Companion to [01-understanding.md](01-understanding.md) (requirement IDs like
`M-GW-4`, `D-8`, `S-2` refer to that file). **No decisions are taken here.** This file records what exists, how it
works, what it teaches us, and how the parts of our problem interact. Each claim is tagged by how it was established:

- **[code]**: read in the project's source or design docs on GitHub
- **[probe]**: measured by us with live requests on 2026-10-09
- **[docs]**: vendor or spec documentation
- **[reported]**: secondary sources (blogs, news, search summaries); treat numbers as indicative

---

## 0. The 15 findings that matter most

1. **Our problem is a recognised product category ("MCP gateway").** At least 20 serious implementations exist (§2).
   Among the closest in shape, IBM ContextForge, MetaMCP, Obot, LiteLLM and Docker MCP Gateway all do "one endpoint +
   registry + auth + upstream credentials + audit". The assignment is basically "build a small, correct one on Kubernetes".
2. **Popular gateways disagree on the collision scheme** (§5): prefix with `-` (ContextForge), `__` (agentgateway,
   MetaMCP), `_` (FastMCP), configurable prefix/priority/manual (ToolHive), or *reject collisions outright* (Docker).
   The assignment asks us to pick one *and document it*, which is exactly the design decision these projects documented.
3. **Default failure semantics differ too.** agentgateway defaults to **FailClosed** (one bad upstream fails the whole
   session) [code]. The brief demands the opposite (`M-GW-5`). Fail-open with per-upstream timeouts is a deliberate,
   explainable choice.
4. **The wild is mixed-era** [probe]: of 8 public remote MCP servers probed today, 4 speak 2026-07-28 *and* legacy,
   4 are legacy-only, and the "legacy" signal differs per server (400 "unsupported version", JSON-RPC -32601, -32602,
   or "Mcp-Session-Id required"). Some legacy servers issue sessions, some don't.
5. **Claude Code now negotiates 2026-07-28 by default with HTTP servers** and opens `subscriptions/listen` streams
   [docs: Claude Code CHANGELOG]. So user B's client will likely be *modern*, while some upstreams are *legacy*. The
   gateway is necessarily an **era bridge**. agentgateway's design notes describe the same bridging problem [code].
6. **Microsoft's Kubernetes MCP Gateway dropped legacy support entirely** (2026-07-28 only, stateless, Redis metadata)
   [code]. That's the opposite trade-off from agentgateway's dual-era bridging, and a useful contrast to cite.
7. **Real cross-user leaks have come from gateways and MCP servers sharing state.** ContextForge's identity-keyed
   upstream session pool *leaked state across downstream sessions* and was replaced by a 1:1 registry (ADR-032 → #4205)
   [code]. Asana's MCP server served Org A cached results to Org B (≈1,000 customers, June 2025) [reported]. This informs
   "what one team member can do to another" (DL-5d) and any caching we do.
8. **Credential handling has converged on one rule:** clients receive only gateway-issued tokens, upstream
   credentials stay in the gateway, no passthrough. The MCP spec now says servers "**MUST NOT accept or transit any
   other tokens**" [docs]. ContextForge's RFC 8693 token exchange shows the advanced version: the inbound user token
   is exchanged, never forwarded [code].
9. **Tool permissions are a solved pattern** (S-2). LiteLLM intersects key/team/user/agent/org allowlists
   (most-restrictive wins); Kong 3.13 has per-tool ACLs; agentgateway uses CEL rules; ToolHive has
   `defaultToolVisibility: deny`. The spec explicitly allows `tools/list` to vary *by authorization* (not by connection) [docs].
10. **The many-tools problem (S-4) is now partly solved on the client side.** Claude Code defers MCP tools behind its own
    tool search [docs]. Server/gateway-side patterns exist too: AWS AgentCore's `x_amz_bedrock_agentcore_search` tool,
    Docker's `mcp-find`/`mcp-add` and embeddings, Bifrost/Cloudflare "Code Mode", and RAG-MCP (reported 43% vs 14% selection
    accuracy). Our in-dashboard chat agent does *not* get Claude Code's tool search for free.
11. **The security literature is specific and citable.** Tool poisoning, rug pulls and cross-server shadowing (Invariant
    Labs, Apr 2025); MCPTox (attack success up to 72.8% across 45 real servers); toxic agent flows (GitHub MCP); OWASP MCP
    Top 10 (2025); defenses: Design Patterns paper (2506.08837), CaMeL, Spotlighting, ETDI signed tool definitions. Our
    system is a textbook **lethal trifecta** (private order PII + member-written untrusted text + any upstream that
    can communicate externally).
12. **WooCommerce's own MCP team designed tools as "business operations, not REST-shaped wrappers"**: line items off
    by default, readonly/idempotent annotations, soft-delete default, strict schemas with enums [docs]. The reviewers'
    former colleagues wrote that, so it's the reference design for our `M-WM-3` tools.
13. **WooCommerce REST auth has two non-obvious traps** [code]: (a) consumer-key Basic auth only works when `is_ssl()`,
    and over HTTP OAuth 1.0a is required, with the **signature base string built from `get_home_url()`, i.e. the public
    Ingress host, not the in-cluster Service name**; (b) OAuth nonces are written back to the API-key DB row on every
    request. The official WordPress image sets `$_SERVER['HTTPS']='on'` when `X-Forwarded-Proto: https` is present, which is
    another route with different trade-offs.
14. **Urumi runs "read-only immutable images"** [docs: Urumi blog]. The official WordPress image documents a static,
    read-only recipe with only `wp-content/uploads` writable [docs]. That gives us a store design that matches the employer's
    philosophy, and it makes Helm upgrade/rollback (S-9) meaningful.
15. **Last cycle's best public submission set a high bar for the bonus** (geekyhead): "Kubernetes is the database",
    idempotency keys, `lookup`-persisted secrets, revision-named seeder Jobs, ValidatingAdmissionPolicy to confine RBAC to
    `store-*`, NetworkPolicy proven by test [code]. Doing the bonus means at least matching this.

---

## 1. Landscape map

| Category | Examples | Relevance |
|---|---|---|
| OSS MCP gateways / aggregators | IBM ContextForge, agentgateway, MetaMCP, Docker MCP Gateway, Microsoft MCP Gateway, Unla, MCPJungle, Lunar MCPX, 1mcp, tbxark/mcp-proxy, FastMCP proxy/mount, Archestra | Direct prior art for Layer 3 |
| AI gateways with MCP | LiteLLM, Bifrost (Maxim), Kong AI Gateway (AI MCP Proxy), Envoy AI Gateway, Portkey, TrueFoundry | Keys, budgets, tool ACLs, audit |
| K8s-native MCP hosting / control planes | ToolHive operator (+ vMCP), kmcp (kagent), Microsoft MCP Gateway control plane, Obot | `S-5` hosted servers, `B-3` auto-registration |
| Managed / SaaS gateways | Cloudflare MCP Server Portals, AWS Bedrock AgentCore Gateway, Azure APIM, Pomerium, Obot hosted, Composio, Smithery | Patterns for policy, logging, credential providers |
| MCP-capable chat apps | LibreChat, Open WebUI, Microsoft gateway "agents" | Layer 4 patterns: identity, tool-call UI |
| Agent/MCP client libraries | MCP SDKs v2 (TS/Python), Vercel AI SDK `createMCPClient`, langchain-mcp-adapters, OpenAI Agents SDK | Layer 4 implementation options |
| Commerce MCP | WooCommerce core MCP (Abilities API + mcp-adapter), Shopify Dev/Storefront/Customer/Checkout MCP, UCP, ACP, community Woo MCP servers | Layer 2 design reference |
| WordPress on K8s | Official image, Bitpoke stack (operator), mariadb-operator, (Bitnami — gone) | Layer 1 |
| Research | OWASP MCP Top 10, MCPTox, SoK MCP security, MCPSecBench, Design Patterns (2506.08837), CaMeL, ETDI, RAG-MCP, Spotlighting | Threat model, S-4, S-6 |
| Competitions | Solo.io MCP & AI Agents Hackathon 2026, Descope Global MCP Hackathon 2025, HF/Gradio Agents & MCP hackathons, Automattic-sponsored NYC MCP hackathon | What judges valued |
| Prior Urumi cycle | ~30 public "Urumi" repos (store provisioning, Feb 2026) | Bonus bar, interview expectations |

---

## 2. MCP gateways: deep dive

### 2.1 Comparison (GitHub stats fetched 2026-10-09)

| Project | Lang / ★ | Aggregation & naming | Failure handling | Inbound auth | Upstream creds | AuthZ / tool filtering | Audit / obs | K8s story | Protocol eras |
|---|---|---|---|---|---|---|---|---|---|
| **IBM ContextForge** | Python / 4.6k | "Virtual servers"; `slug(gateway.name) + SEPARATOR + original_name`, separator default `-`, original name stored for invocation (ADR-011) [code] | Health checks: interval, timeout, `UNHEALTHY_THRESHOLD` consecutive failures → Offline, auto-recover (ADR-009) [code] | JWT + basic, SSO, query-param option | Per-gateway auth; RFC 8693 token exchange; identity propagation via `X-Forwarded-User-*` / `_meta`, optional HMAC-signed claims (ADR-041) [code] | Teams/RBAC, plugins (40+) | OTel (Phoenix/Jaeger), Prometheus, audit trail w/ `auth_method`, `delegation_chain` | Helm chart `mcp-stack`, Redis federation | Both; 54 ADRs incl. session affinity |
| **agentgateway** (LF) | Rust / 5.2k | Multiplexing; prefix `target{DELIMITER}name` by default, `prefixMode: never` resolves by listing [code] | `FailureMode::FailClosed` **default**, `FailOpen` optional [code] | JWT, ext-auth | Per-target backend auth | CEL `mcpAuthorization` per tool/prompt/resource; target `condition` CEL [code] | OTel, guardrails phases | kgateway / Gateway API integration | Dual-era bridge; intersects upstream versions on `server/discover`; disables caching of proxied results [code] |
| **MetaMCP** | TS / 2.7k (slow maint. since Jun 2026) | Namespaces → Endpoints; `__` separator between server prefix and tool [code]; per-namespace tool overrides & annotation overrides | Pre-allocated idle sessions per server (cold-start) | API key `sk_mt_…` (header or query), OIDC, MCP OAuth | `${ENV}` references for stdio | Enable/disable per server/tool, middleware ("filter inactive tools") | Inspector built in | Docker compose | 2025-era |
| **Docker MCP Gateway** | Go / 1.6k | **Rejects** colliding names instead of prefixing [docs] | — | Bearer token by default on HTTP; Origin checks (localhost only) | Docker Desktop secret store, secrets scoped per server, name-validated | Profile tool allowlists `server.tool` | `--log-calls` logs **tool name + argument shape only**, never raw values; `--block-secrets` scans args and responses [docs] | Containers per server, `no-new-privileges`, CPU/mem limits | — |
| **Microsoft MCP Gateway** | C# / 0.9k | `/adapters/{name}/mcp` direct; `/mcp` tool router over registered tools [code] | K8s health checks, StatefulSets | Entra ID, app roles (`mcp.admin`) | — | Read: creator + `requiredRoles` + admin; write: creator/admin | Telemetry | **K8s-first**: control plane deploys MCP servers; Redis/Cosmos metadata | **2026-07-28 only**, stateless, no downgrade [code] |
| **Obot** | Go / 1.1k | Registry + gateway | — | Obot tokens; "upstream credentials remain with Obot" [docs] | Server-side; shim sidecar does token exchange | Per-user server access + token-permitted servers | Correlated audit in Postgres | Hosts servers as K8s workloads; hosted = GKE cluster per company | — |
| **ToolHive (Stacklok)** | Go / 2.3k | vMCP: **prefix** (`{workload}`, `{workload}_`, `{workload}.`), **priority**, **manual** strategies; filters; overrides; composite tools [docs] | — | OIDC | Per-server secrets | `defaultToolVisibility: deny`, per-workload exclusions | — | `MCPServer` CRD operator; egress proxy + DNS container + ingress proxy for isolation; NetworkPolicy allowlists [docs] | — |
| **LiteLLM** | Python / 60k | MCP servers behind virtual keys | — | Virtual keys | Server-side | 5 levels (key, team, end-user, agent, org), **intersection, most-restrictive wins**, org as ceiling [docs] | Audit, budgets | Helm | — |
| **Kong AI Gateway** | Lua / 44k | AI MCP Proxy plugin (3.12+), MCP↔HTTP bridge | Kong upstream health | AI MCP OAuth2 plugin (tech preview) | Kong vaults | **Per-tool ACLs by Consumer/Consumer Group (3.13)** [docs] | Kong plugins | Kong Ingress | — |
| **Bifrost** | Go / 8.6k | MCP + LLM in one binary; **Code Mode** exposes 4 generic tools (reported −92.8% input tokens) [reported] | — | Virtual keys | — | Tool allowlists on virtual keys | Budgets | — | — |
| **Cloudflare MCP Portals** | SaaS | Single portal endpoint for many servers [docs] | — | Cloudflare Access (MFA, posture, geo) | Server-side | Access policies show/hide servers | **Tool-level logs** of every call | — | — |
| **AWS AgentCore Gateway** | SaaS | Targets: MCP, Lambda, OpenAPI, Smithy; **semantic search tool** `x_amz_bedrock_agentcore_search` [docs] | Capability sync | IAM / OAuth inbound | **Credential provider** stores API key/OAuth per target [docs] | — | CloudWatch | — | — |
| FastMCP (proxy/mount) | Python / 28k | `mount(prefix)` → `{prefix}_{name}`; resource URIs `resource://prefix/...` [docs] | — | — | — | Tool transformation | — | — | — |
| Unla, MCPJungle, 1mcp, tbxark/mcp-proxy, Lunar MCPX, Archestra | various | Simpler aggregators; MCPX has "dynamic tool discovery"; Archestra targets guardrails | — | — | — | — | — | — | — |

### 2.2 Lessons, by the gateway that taught them

- **ContextForge ADR-011**: store `original_name` separately from the exposed name, and resolve on invocation via
  `slug + sep + original_name`. Tool changes on the upstream were reflected only after deactivate/activate or edit, which is a
  weakness worth beating (refresh on health check or on `list_changed`).
- **ContextForge ADR-032 → #4205 (the cautionary tale)**: a pool keyed by *identity* reused upstream sessions across
  downstream sessions and **leaked state between users on stateful upstreams**. Replacement: one upstream session per
  `(downstream_session_id, gateway_id)`. With *shared static upstream credentials* (our case), session reuse across users
  is tempting, so here's a concrete reason to be careful.
- **ContextForge ADR-038**: multi-worker affinity needed Redis Pub/Sub ownership, heartbeats and Lua CAS reclaim to handle
  *legacy* sessions across workers. That cost is exactly what 2026-07-28's statelessness removes (relevant to `S-7`).
- **ContextForge ADR-041**: identity propagation to upstreams is **off by default**; when on, it uses an allowlist of
  attributes, HMAC signing and sensitive-attribute stripping. Token exchange "fails closed" on paths without a user context
  (health checks).
- **agentgateway**: FailClosed default; era bridging notes (forward `server/discover`, merge `supportedVersions` by
  intersection, error if any upstream rejects so client falls back to `initialize`); "strictly disable caching of proxied
  results" because gateway policies can make results caller-dependent; `subscriptions/listen` fan-out waits for all
  upstream ACKs [code].
- **Docker**: the most explicit **security boundary document** of any gateway. Remote URLs must be public HTTPS by default,
  with private/loopback/link-local/metadata ranges rejected, redirects validated, and **dial-time IP validation**. Tool schemas are
  treated as untrusted input with bounded walking (depth and node count). Secrets are per server, call logs record argument
  *shape* only, and secret scanning runs on args and responses.
- **Microsoft**: control plane / data plane split; adapters CRUD; React portal; Redis for metadata; StatefulSets +
  headless Services; chose the "modern only" route.
- **LiteLLM**: permission intersection model is clean and explainable.
- **ToolHive**: naming strategies as a *configurable policy*, plus the warning that "priority" silently drops tools and
  can redirect authorization policies.
- **MetaMCP**: API keys with a recognizable prefix, header-preferred (`Authorization: Bearer`), query param only as
  fallback; per-namespace tool overrides (rename/description), which is a lever against malicious descriptions.

---

## 3. Kubernetes-native MCP hosting (S-5, B-3)

| Project | Mechanism | Isolation | Notes |
|---|---|---|---|
| ToolHive operator | `MCPServer` CRD → pod + headless Service (+ proxy) | Egress proxy container, DNS container, ingress proxy; NetworkPolicy allowlists; permission profiles (`builtin/network` = allow-all, "not recommended") [docs] | vMCP aggregates `MCPServer`s with naming strategies |
| kmcp (kagent) | CLI + controller to build/deploy MCP servers | — | Pairs with kgateway/agentgateway |
| Microsoft MCP Gateway | `POST /adapters` deploys an image; `/tools` registers tool servers | Entra RBAC on resources | Logs/status endpoints per adapter |
| Obot | Hosts npx/uvx/container servers as K8s workloads | Shim sidecar per server for authz, audit, token exchange | "MCP Server Shim" is a different architecture from a central gateway |
| Docker gateway | Container per server | `no-new-privileges`, limits, optional `--block-network`, bind-mount allowlists | Image signature verification for `mcp/` namespace |

Takeaway for S-5: the expected building blocks are a Deployment + Service + Secret + NetworkPolicy (egress allowlist) +
resource limits + non-root securityContext, created by the platform and removed cleanly, with least-privilege RBAC for the
component that creates them.

---

## 4. Protocol reality check (Oct 2026)

### 4.1 Public remote servers, probed today [probe]

| Server | `initialize` | Session issued? | `server/discover` (with `MCP-Protocol-Version: 2026-07-28`) | Auth |
|---|---|---|---|---|
| DeepWiki `mcp.deepwiki.com/mcp` | 2025-11-25 | no | **legacy only** (400 "Unsupported protocol version… Supported: 2024-11-05…2025-11-25") | none |
| Context7 `mcp.context7.com/mcp` | 2025-11-25 | no | **2026-07-28** (rejects discover without the version header: `-32020 HeaderMismatch`) | optional key |
| Exa `mcp.exa.ai/mcp` | 2025-11-25 | **yes** | **legacy only** (400) | none (rate-limited) |
| Hugging Face `huggingface.co/mcp` | 2025-11-25 | **yes** | **2026-07-28** | optional token |
| Cloudflare docs `docs.mcp.cloudflare.com/mcp` | 2025-11-25 | no | **2026-07-28** | none |
| Microsoft Learn `learn.microsoft.com/api/mcp` | 2025-11-25 | **yes** | **2026-07-28** | none |
| AWS Knowledge `knowledge-mcp.global.api.aws` | **2025-03-26** | **yes** | **legacy only** (`-32601 Method not found`) | none |
| GitMCP `gitmcp.io/docs` | 2025-03-26 | **yes** | **legacy only** ("Mcp-Session-Id header is required") | none |
| GitHub `api.githubcopilot.com/mcp/` | 401 + `WWW-Authenticate … resource_metadata=…/.well-known/oauth-protected-resource/mcp/` | — | — | PAT bearer or OAuth |
| Stripe `mcp.stripe.com`, Semgrep | 401 | — | — | key / OAuth |

Implications: the gateway's upstream client must (1) probe or try modern, (2) recognise *every* legacy signal above,
(3) cache the per-upstream verdict (the TS SDK v2 gateway guide prescribes keying it by auth context and dating legacy
verdicts), (4) handle legacy sessions on some upstreams, and (5) never let a probe failure mark a healthy upstream "Unreachable".

### 4.2 Clients we will demo with

- **Claude Code** (v2.1.295 changelog) [docs]: v2 MCP client; negotiates **2026-07-28 by default** with direct HTTP
  servers (`MCP_PROTOCOL_NEGOTIATION=legacy` opts out); opens **`subscriptions/listen`** (there was a fix for endlessly
  reopening listen streams against servers that cut long-held streams); handles `list_changed` (there was a fix for tight
  loops); keeps the tool list byte-stable and **defers MCP tools behind tool search**; MCP tool names are `mcp__server__tool`;
  `claude mcp add --transport http --header` exists; `headersHelper` re-runs on 401/403; a 401 *without* a helper may trigger
  OAuth discovery. That matters for how a revoked key should be rejected (D-7).
- **Cursor**: server+tool name ≤ 60 chars [reported: Cursor forum].
- **MCP Inspector v2.10.1** (Oct 8 2026): web, **CLI with `--format json` + exit-code map**, TUI; secrets in the OS keychain [docs].
  The CLI makes the DoD flow scriptable as an automated end-to-end test.
- **LLM APIs** (Anthropic/OpenAI): tool names `[a-zA-Z0-9_-]`, ≤ 64 chars, no dots [reported]; Claude Code has had
  "tool name exceeds 64 characters" issues once its `mcp__<server>__` prefix is added.

### 4.3 SDK state

- **TypeScript SDK v2.3.1** (`@modelcontextprotocol/server|client|node|express|hono`): `createMcpHandler` serves both eras;
  client `versionNegotiation: 'auto' | legacy | {pin}`; `prior` verdicts; `listen()`; v1 (`@modelcontextprotocol/sdk`
  1.32.x) is maintenance-only for ≥6 months after 2026-07-27 [code].
- **Python SDK v2.3.0**: `Client(mode="auto")`, `MCPServer(subscriptions=False)`, OTel client spans, `x-mcp-header`
  validation, `Client.call_tool` retries once after `HeaderMismatch` [docs: release notes].
- **FastMCP v4.0.11** (Python, 28k★) for higher-level composition; fastmcp-ts exists.

### 4.4 Spec details that shape the gateway (2026-07-28)

`tools/list` MUST NOT vary per connection but MAY vary by authorization; SHOULD be deterministic order; list results
carry `ttlMs` + `cacheScope` (public/private); `Mcp-Method`/`Mcp-Name` headers let gateways route/meter without body
parsing; trace context in `_meta` (`traceparent`); tool execution errors use `isError: true`; protocol errors are JSON-RPC
errors; MRTR (`input_required`) replaces server→client requests; sampling/roots/logging deprecated; authorization is
**optional**, and when used, the server MUST validate audience (RFC 8707) and MUST NOT transit other tokens [docs].
A May 2026 IETF draft, **MCP-AX** (draft-abbott-mcp-ax-00), proposes standardised hierarchical namespace delegation for
aggregators, so the naming problem is recognised as unsolved at the standards level [docs].

---

## 5. Tool-name collisions: survey of schemes

| Scheme | Who | Pros | Cons |
|---|---|---|---|
| `slug-tool` (`-`) | ContextForge (default, configurable) | Readable | `-` is common inside tool names, so parsing is ambiguous unless the original name is stored |
| `slug__tool` | agentgateway, MetaMCP ("first `__` is the separator"), Claude Code's own `mcp__s__t` | Unambiguous split on first `__`; allowed by every LLM API | Long names; double prefix in Claude Code (`mcp__gw__woo__list_orders`) |
| `slug_tool` | FastMCP mount | Short | Ambiguous split |
| `slug.tool` | ToolHive option, Docker allowlist notation | Spec-legal | **Breaks LLM APIs** (no dots) |
| Priority (first wins) | ToolHive | No renames | Silently drops tools; can redirect authz |
| Manual overrides | ToolHive, MetaMCP overrides | Admin control, human-friendly | Operational burden; must block startup when unresolved |
| Reject collisions | Docker | Simple, no surprises | Can't add two servers with `search` |
| Unprefixed + resolve by listing | agentgateway `prefixMode: never` | Clean names | Extra list per call; ambiguous on collision |

Hard constraints from §4.2: ≤ 64 chars after client prefixes, no dots, `[A-Za-z0-9_-]`. The store-identifying names in
the bonus (`B-3`, "tool names make it clear which store") fold into the same scheme.

---

## 6. Failure handling and health

- **Patterns seen:** active health check loop with interval, timeout and *consecutive-failure threshold* then auto-recovery
  (ContextForge ADR-009); fail-open vs fail-closed fan-out (agentgateway); request-scoped per-upstream timeouts; MCP
  `notifications/cancelled` to cancel upstream work.
- **Spec SHOULDs:** clients implement timeouts; servers rate-limit tool invocations; tool errors returned as `isError`
  results so the model can recover.
- **Kubernetes interplay:** a killed pod returns within seconds, Service endpoints drop the pod when readiness fails, and
  a connection to a ClusterIP with no ready endpoints is refused fast (no hang), which makes "dead" detectable quickly. A
  *slow* upstream (accepts the connection, never answers) is the case that needs the timeout. D-9's "Unreachable" state needs
  active probing **and** passive marking on call failure.
- **Reporting "why"** (S-8): classify failures as DNS / connect refused / TLS / timeout / HTTP 401-403 (upstream credential) /
  HTTP 5xx / protocol (era mismatch, bad JSON-RPC) / tool `isError`.

---

## 7. Identity, credentials and keys

- **Key formats:** GitHub `ghp_` + 30 random chars + **CRC32 checksum (Base62)** enables offline secret-scanning validation
  and near-zero false positives [docs: GitHub blog]. MetaMCP `sk_mt_…`. A prefixed, checksummed format also lets us
  identify the key's owner on a *rejected* call (D-10 attribution) without accepting it.
- **Storage:** high-entropy keys → SHA-256 (optionally HMAC with a server pepper) indexed lookup; bcrypt/argon2 add
  per-request latency with no security gain for 256-bit random secrets; show plaintext once; store a non-secret display
  prefix [reported: Zuplo, CyberSierra; consistent with GitHub practice]. Constant-time compare (the geekyhead submission
  uses `timingSafeEqual`).
- **Inbound auth options:** static API keys (spec-legal, authorization is optional) vs. MCP OAuth (PRM RFC 9728 →
  AS metadata → CIMD preferred / DCR deprecated → PKCE + `resource` (RFC 8707) → audience-bound token; scope step-up via
  403 `insufficient_scope`) [docs]. S-3 means implementing the resource-server side plus an AS (or delegating to
  Keycloak/Dex). Note: the TS SDK v2 *removed* its built-in OAuth AS ("use a dedicated provider"); the old one survives
  in deprecated `server-legacy`.
- **Upstream credentials:** universally kept server-side (Obot: "upstream credentials remain with Obot"; AgentCore
  "credential provider"; Docker per-server scoped secrets; ContextForge per-gateway auth). Advanced: per-user upstream OAuth
  (LibreChat stores tokens per user per server), and RFC 8693 token exchange (ContextForge) where the inbound token goes
  only to the token endpoint, never to the upstream.
- **Identity to upstreams:** off by default (ContextForge); LibreChat injects `{{LIBRECHAT_USER_ID}}`-style placeholders
  into headers. Forwarding identity is *not* passthrough of the credential, but it is still a privacy and spoofing surface
  (hence HMAC signing).
- **Chat agent as the user:** prior art (LibreChat, Open WebUI, Microsoft "agents") runs the tool loop server-side with
  the session user's context. None stores the user's raw gateway key for this, which is consistent with "keys stored hashed"
  making that impossible for us (01 §4 item 9).

---

## 8. Authorization and tool permissions (S-2)

| Model | Who | Notes |
|---|---|---|
| Intersection of allowlists across levels, org ceiling | LiteLLM | Explainable; "most restrictive wins" |
| Per-tool ACL by consumer/group | Kong 3.13 | Classic API-gateway style |
| CEL expressions on MCP method + tool name + JWT claims | agentgateway; MCP.STORE (hackathon runner-up: agentgateway + Keycloak JWT + CEL) | Expressive; policy-as-config |
| Default-deny visibility + per-workload opt-in | ToolHive | Safe default |
| Namespace/endpoint composition | MetaMCP, Docker profiles | Coarse-grained |
| Creator + required roles + admin role | Microsoft gateway | Resource-level, not tool-level |

Key requirement in the brief: restricted tools are **hidden from `tools/list` and rejected on `tools/call`** (both).
agentgateway and Docker explicitly call out that policy must apply on *every* invocation path (direct call, dynamic
tools, code mode). Tool *annotations* (`readOnlyHint`, `destructiveHint`) are hints from the server, and the spec says
clients MUST treat them as untrusted unless the server is trusted. They can seed a default policy (e.g. members get
read-only tools) but can't be the enforcement basis for untrusted upstreams. This mirrors Urumi's public guidance:
"read-only for the first week; enable writes one ability at a time".

---

## 9. Audit and observability (M-TA-5, S-8)

- **What others log:** ContextForge audit has `auth_method`, `acting_as`, `delegation_chain`; Cloudflare logs every tool
  call (not just connections); Docker logs tool name + **argument shape** but never raw argument values by default
  (privacy: order data contains PII).
- **OpenTelemetry MCP semconv** (development status) [code: open-telemetry/semantic-conventions-genai]: span name
  `{mcp.method.name} {target}` (e.g. `tools/call list_orders`); attributes `mcp.method.name`, `gen_ai.tool.name`,
  `mcp.session.id`, `mcp.protocol.version`, `error.type`; metrics **`mcp.client.operation.duration`**,
  **`mcp.server.operation.duration`**, `mcp.client.session.duration`, `mcp.server.session.duration` (unit s); trace
  context propagates in `params._meta` (`traceparent`, `tracestate`, `baggage`). A gateway is both an MCP server
  (downstream) and an MCP client (upstream), so it can emit both metric families, giving per-upstream latency and error
  rate for free.
- **Ideas seen in prior art:** Prometheus `/metrics` not routed through Ingress (geekyhead); failure reasons surfaced
  in UI popovers; audit-derived totals (survive restarts, agree across replicas).
- Not seen anywhere in the surveyed gateways: **tamper-evident (hash-chained) audit**. A possible differentiator, but it's
  an extra not required by the brief.

---

## 10. Many tools (S-4)

| Approach | Where | Mechanism | Evidence |
|---|---|---|---|
| Client-side tool search / deferred loading | Anthropic API `defer_loading` + regex/BM25 tool search; Claude Code | Model sees names, fetches schemas on demand | Reported accuracy 49→74% (Opus 4), 79.5→88.1% (Opus 4.5) [reported]; 7 servers ≈ 67k tokens of definitions [reported] |
| Gateway meta-tools (search → execute) | AWS AgentCore `x_amz_bedrock_agentcore_search`; Docker `mcp-find`/`mcp-add`/`mcp-exec`; MCP adapter `discover-abilities`/`get-ability-info`/`execute-ability` (WooCommerce/WordPress!) | 2–3 stable tools front an arbitrary catalog | — |
| Semantic retrieval before the LLM | RAG-MCP (arXiv 2505.03275); Docker embeddings (sqlite-vec + OpenAI embeddings) | Retrieve top-k tool descriptions per query | 43.13% vs 13.62% selection accuracy, >50% fewer prompt tokens [reported] |
| Code Mode / code execution | Anthropic "code execution with MCP" (150k → 2k tokens, −98.7%); Cloudflare Code Mode; Bifrost (4 tools) | Tools become a typed API in a sandbox; only results return | Needs a secure sandbox (isolated-vm/Deno) [reported] |

Note: WordPress's own MCP adapter already uses the **discover/get-info/execute meta-tool** pattern, so S-4 has a direct
WooCommerce-ecosystem precedent. Also, *policy must apply on the execute path* (Docker security doc).

---

## 11. Security research, incidents and defenses

### 11.1 Taxonomy: OWASP MCP Top 10 (2025)
MCP01 Token mismanagement & secret exposure · MCP02 Privilege escalation via scope creep · MCP03 Tool poisoning ·
MCP04 Supply chain · MCP05 Command injection · MCP06 Prompt injection via contextual payloads · MCP07 Insufficient
authN/authZ · MCP08 Lack of audit & telemetry · MCP09 Shadow MCP servers · MCP10 Context injection & over-sharing.
The brief's mandatory features map onto MCP01, MCP07 and MCP08 directly, and the threat-model note onto MCP03, MCP06 and MCP10.

### 11.2 Attacks and incidents
| Event | What happened | Lesson for us |
|---|---|---|
| Tool poisoning / rug pull / shadowing (Invariant Labs, Apr 2025) | Hidden instructions in descriptions; a server swaps definitions after approval; a malicious server's description manipulates calls to *another* server (WhatsApp exfil PoC) | Our gateway merges descriptions from several servers into one context, so shadowing across servers is the relevant risk; pin and diff definitions |
| MCPTox (arXiv 2508.14925) | 45 real servers, 8 domains; attack success up to **72.8%** | Model-side resistance is weak; gateway-side controls matter |
| GitHub MCP "toxic agent flow" (May 2025) | Malicious public issue → agent leaks private repos via PR | Indirect prompt injection through *data* (our product names, order notes) |
| Supabase MCP (Jul 2025) | Instructions in DB fields → agent copies private data to visible fields | Same: store data written by any member/customer is untrusted |
| **Asana MCP (Jun 2025)** | Tenant isolation flaw: Org A received Org B's cached results; ~1,000 customers, 12 days | Any cache must be keyed by authorization context |
| **ContextForge #4205** | Identity-keyed upstream session pool leaked state across downstream sessions | Don't share stateful upstream sessions across users |
| postmark-mcp (Sep 2025) | First malicious MCP package: v1.0.16 silently BCC'd every email | "Admin adds a compromised server" is realistic; supply-chain trust |
| CVE-2025-6514 mcp-remote (CVSS 9.6) | Malicious `authorization_endpoint` → OS command injection | Never pass server-provided URLs to shells; validate schemes |
| CVE-2025-49596 MCP Inspector (CVSS 9.4) | Unauthenticated proxy + DNS rebinding → RCE | Origin/Host validation and auth on every HTTP MCP endpoint (incl. ours) |

### 11.3 Defenses in the literature
- **Design Patterns for Securing LLM Agents** (Beurer-Kellner et al., arXiv 2506.08837): action-selector,
  plan-then-execute, LLM map-reduce, dual LLM, code-then-execute, context minimisation.
- **CaMeL** (Google DeepMind): privileged vs quarantined LLM, capabilities on data, custom interpreter enforcing data/
  control flow; 77% of AgentDojo tasks with provable security vs 84% undefended.
- **Spotlighting / datamarking** (Microsoft, arXiv 2403.14720): mark untrusted tool output so the model can tell data from
  instructions; used in Azure Prompt Shields.
- **ETDI** (arXiv 2506.01333): signed, immutable, versioned tool definitions; re-approval on hash change.
- **Lethal trifecta** (Willison): private data + untrusted content + external communication means exfiltration is possible.
  Breaking any one leg is the robust fix.
- **Docker gateway boundaries** (practical checklist): public-HTTPS-only remotes by default, private-range/metadata blocking
  with redirect and dial-time checks, bounded schema walking, per-server secret scoping, secret scanning, shape-only logging.
- **Node SSRF gotcha** [reported]: undici's `fetch` ignores the `agent` option and re-resolves DNS at connect time, so IP
  pinning must be done with an undici `Dispatcher`/custom `lookup`, not a Node `Agent`.

### 11.4 Mapping to our system (input to DL-5)
- **Trifecta legs in our design:** private data = orders (names, emails, addresses); untrusted content = product names and
  descriptions any member (or agent) can create, order notes, customer-entered checkout fields, third-party tool
  descriptions and results; external communication = any upstream that can send data out (web fetch, GitHub, Slack, email,
  even a "create product" on a *public* storefront is a write channel). **Which two extra upstreams we pick changes the
  threat model.**
- **Cross-member vectors:** shared upstream state (A edits B's orders); indirect injection (A plants instructions in a product
  B's agent reads); shared-session leakage (§2.2); cache leakage (Asana); quota exhaustion of shared upstream credentials; audit
  and chat-history visibility.

---

## 12. Commerce MCP prior art (Layer 2)

### 12.1 WooCommerce core MCP [docs]
- Architecture: client → `@automattic/mcp-wordpress-remote` (stdio↔HTTP proxy) → **WordPress MCP Adapter**
  (`/wp-json/mcp/mcp-adapter-default-server`) → **WordPress Abilities API** → WooCommerce abilities → core. Feature flag
  `mcp_integration` (`woocommerce_feature_mcp_integration_enabled`). Developer preview since 10.3.
- Auth: **WordPress Application Passwords for a scoped user**; docs explicitly say *not* to use a WooCommerce REST API key
  for MCP; HTTPS required.
- **Canonical abilities**: `products-query`, `product-create`, `product-update`, `product-delete`, `orders-query`,
  `order-update-status`, `order-add-note`. Strict input/output schemas with Woo-aware enums; queries readonly + idempotent;
  orders query filters by id/status/customer/billing email/parent/exclude/created & modified date ranges; **line items off
  unless `include_line_items: true`**; product types abstracted (`physical`, `virtual`, `digital`, `affiliate`, `grouped`);
  delete soft by default (`force: true` to purge); "business operations instead of REST-shaped wrappers".
- The adapter exposes `discover-abilities`, `get-ability-info`, `execute-ability` meta-tools (see §10).
- Our constraint (`M-WM-1`): this must stay **disabled**; we write our own server. Matching its *semantic* design is
  allowed and recommended.

### 12.2 Shopify and protocols
- Shopify ships **four MCP servers**: Dev MCP (docs/schema, local, no prod data), Storefront MCP (catalog, cart, policies),
  Customer Account MCP (orders/returns for authenticated customers), Checkout MCP (UCP agent-profile auth, select partners)
  [reported]. The split into *merchant-ops vs shopper* servers is a useful framing: ours is merchant-ops (admin-side).
- **UCP** (Google + Shopify, NRF Jan 11 2026; Etsy, Wayfair, Target, Walmart; endorsed by Stripe/PayPal/Visa/Mastercard)
  and **ACP** (OpenAI + Stripe, ChatGPT Instant Checkout, Sept 2025; WooCommerce is a launch platform) [reported].
  WooCommerce has an open UCP feature request [reported]. Context only; out of scope.

### 12.3 Versions [probe]
WordPress **7.1.3**; WooCommerce **11.2.0** (requires WP 7.0, PHP 7.4+; tested 7.1.3); official image tags
`php8.4`/`php8.5` (apache, fpm, fpm-alpine). WooCommerce also has a **REST API v4** (`wc/v4`) coexisting with v3
[reported, unverified details]; v3 remains the documented stable surface.

---

## 13. WordPress / WooCommerce on Kubernetes (Layer 1)

- **Official image facts** [docs]: env-driven `wp-config-docker.php`; `_FILE` variants for secrets (DB creds, salts) so
  Secrets can be mounted as files; auto-adds `X-Forwarded-Proto` → `$_SERVER['HTTPS']='on'`; `WORDPRESS_CONFIG_EXTRA`
  eval hook; DB must pre-exist; **static/read-only recipe**: copy themes/plugins into `/usr/src/wordpress`, run
  `--read-only` with tmpfs `/tmp`, `/run` and a writable `wp-content/uploads` mount; WP-CLI image is Alpine with uid **82**
  vs Debian uid **33**. Running against the same volume needs `--user 33:33`.
- **Immutable approach** (`DISALLOW_FILE_MODS=true`) vs shared RWX volume for admin-installed plugins; multi-replica WP needs
  RWX or immutable code + shared uploads.
- **WP-Cron**: page-load triggered, so it's unreliable. Use `DISABLE_WP_CRON` + K8s CronJob hitting `wp-cron.php` (or `wp cron
  event run`). WooCommerce's **Action Scheduler** depends on it.
- **Urumi's stack (their blogs)**: immutable images; PHP tuned from scratch (workers per core, OPcache sized, **no JIT**);
  caching Cloudflare edge + Redis + APCu; HPOS migration expertise; MariaDB→MySQL 8.4 migration (600GB).
- **DB on K8s:** official `mysql:8.4`/`mariadb` StatefulSet with `mysqladmin ping` probes (K8s docs pattern);
  mariadb-operator (CRDs, backups to S3/PVC, VolumeSnapshots); Bitpoke stack (WordPress + MySQL operators, beta, quiet since
  ~2023); **Bitnami images moved to `bitnamilegacy` (Aug 28 2025), no updates**.
- **Security context reality** (geekyhead): official WordPress Apache image starts as root to bind :80 and chown; fully
  non-root needs a custom image on :8080; MariaDB/MySQL run as uid 999.
- **WooCommerce REST auth deep-dive** [code: `class-wc-rest-authentication.php`, `wp-includes/user.php`]:
  `authenticate()` → `is_ssl()` ? Basic (consumer key/secret) : OAuth 1.0a. OAuth: HMAC-SHA1/256, timestamp + nonce,
  **base string uses `get_home_url(null, $path, is_ssl() ? 'https' : 'http')`** (public host); nonces persisted to the key
  row per request (15-min window). Application Passwords: `wp_is_application_passwords_supported()` = `is_ssl() || 'local' ===
  wp_get_environment_type()`, filterable via `wp_is_application_passwords_available`. REST date filters: `after`/`before`
  with `dates_are_gmt` toggle.

---

## 14. Multi-store provisioning prior art (bonus B-1…B-7)

From the strongest prior-cycle submission (geekyhead/Urumi-system-design) [code], plus nandan2003 (Go + Helm SDK + reconcile loop):
- **"Kubernetes is the database"**: store state in namespace labels/annotations (`status`, `reason`, `owner`,
  `idempotency-key-sha256`, timestamps). The orchestrator is stateless and resumes after a crash.
- **Idempotent create**: id = `sha256(idempotencyKey)[0:8]`; racing creates collide on namespace name (409 → replay).
- `helm upgrade --install`; Secrets via `lookup` (never rotate DB password away from data); seeder Job named
  `…-seeder-r<revision>` (Job templates are immutable); idempotent WP-CLI steps.
- Reconciler every 5 s: Ready / Failed-with-reason (Job failed, ImagePullBackOff, CrashLoop ≥3) / timeout 300 s / recovery.
- Teardown: mark Deleting → wait in-flight → `helm uninstall --wait` → delete namespace (Foreground) → verify no PVs remain.
- Isolation: ResourceQuota (incl. 0 NodePort/LoadBalancer), LimitRange, default-deny NetworkPolicy allowing ingress
  controller + same namespace; PSS `baseline` enforce / `restricted` warn; `automountServiceAccountToken: false`.
- **RBAC trick**: cluster role limited to namespaces + rolebindings + `bind` on one tenant ClusterRole; per-namespace
  RoleBinding; **ValidatingAdmissionPolicy** restricts the SA to `store-*` names.
- Ours adds: per-store MCP server, auto-registered in the gateway, store-identifying tool names, NetworkPolicy so store A's
  MCP server can't reach store B's DB/WordPress, and deregistration on delete.

---

## 15. Kubernetes platform facts (versions as of 2026-10-09) [probe]

| Component | Latest | Notes |
|---|---|---|
| k3s | v1.37.1+k3s1 (2026-09-30) | Traefik default; embedded kube-router NetworkPolicy; local-path storage; `--secrets-encryption` (aescbc default, `secretbox` via `--secrets-encryption-provider`) |
| k3d | v5.9.0 | k3s in Docker; same semantics as the VPS |
| kind | v0.33.0 | kindnet enforces NetworkPolicy since v0.24 [reported by geekyhead]; ingress controller must be installed |
| Helm | **v4.3.0** | Helm 3: bug fixes ended **2026-09-09**, security fixes until **2027-02-10**. Helm 4: server-side apply default for new releases, kstatus waiting, `--atomic` → **`--rollback-on-failure`**, `--force` → `--force-replace`; SSA errors on duplicate env vars |
| Traefik | v3.7.14 | entryPoint `respondingTimeouts.readTimeout` default **60s** (request read), `idleTimeout` default 180s; check the effect on long-held `subscriptions/listen` POST streams *(experiment)*; HTTP/3 timeout CVE fixed in 3.7.12 |
| ingress-nginx | **retired Mar 2026** | No patches; prior-cycle submissions used it, so it now reads as outdated |
| cert-manager | v1.21.2 | For S-1 TLS |
| Local machine | Docker Desktop, kubectl, Node, Python 3.14, Go present; **no helm/k3d/kind yet** | Windows 11 |

Other facts: default-deny NetworkPolicy breaks DNS unless egress to kube-dns (UDP/TCP 53) is allowed; KMS v2 is the
production answer for Secret encryption (aescbc keeps the key on the node); Oracle Cloud Always Free ARM is reportedly being cut
from 4 OCPU/24 GB to 2/12 (inconsistently enforced) [reported]. ARM VPS means **multi-arch images**.

---

## 16. Chat agent prior art and LLM options (Layer 4)

- **LibreChat**: per-user MCP connections; `{{LIBRECHAT_USER_ID}}`/`{{LIBRECHAT_USER_EMAIL}}` header placeholders;
  `customUserVars` for per-user credentials; per-user per-server OAuth.
- **Open WebUI** (≥0.6.31): native MCP over Streamable HTTP only; user-added tool servers **admin-gated** because "a
  malicious or compromised MCP server could execute code and read or exfiltrate data with that user's access".
- **Microsoft MCP Gateway agents** (preview): agent = system prompt + model + **allowed tool list**; sessions stream
  events over SSE.
- **Libraries**: Vercel AI SDK `createMCPClient` (HTTP transport + headers, `stopWhen(stepCountIs(n))`, `onStepFinish`
  for tool-call display); `langchain-mcp-adapters` `MultiServerMCPClient` + LangGraph `create_react_agent` (headers
  supported). LangGraph is Urumi's stated agent stack (careers page). Plain SDK loop with the provider's tool-calling API is the
  minimal option.
- **Free LLM tiers today** [docs]: Gemini API free tier covers `gemini-3.5…3.8-flash`, `gemini-2.5-pro/flash/flash-lite`
  (rate limits not captured); Groq free: `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b` at **30 RPM / 1K RPD / 8K TPM**. 8K TPM
  is tight once ~20 tool schemas are in every request. OpenRouter `:free` models ~50 req/day unfunded [reported].
  Free tiers may train on inputs, which is fine for demo data but worth one line in the threat model.

---

## 17. Competitions and what judges rewarded

- **Solo.io MCP & AI Agents Hackathon 2026** (Feb–Apr): winners used kagent / kgateway / agentgateway / kmcp.
  *Runner-up "Building Cool Agents"*: **Kubernetes-native platform federating multiple MCP servers into one endpoint** with
  service discovery (clinical data). *Runner-up "Secure & Govern MCP"*: **MCP.STORE**, an e-commerce platform with
  agentgateway + Keycloak JWT + **CEL rules enforced at the protocol level so agents can't bypass them**. *Open-source track*:
  PRs turning agentgateway into an identity-aware control plane (identity, OTel, multi-provider). Judges praised "practical
  and impactful" and protocol-level enforcement over app-level checks.
- **Descope Global MCP Hackathon** (Aug–Sep 2025, $100k+): a dedicated "Secure MCP Server for Agents" theme.
- **HF/Gradio Agents & MCP Hackathons** (2025 editions, "MCP's 1st Birthday" with Anthropic): Track 1 MCP servers, Track 2
  agentic apps.
- **Automattic/Beeper-sponsored "Build the Future MCP Hackathon" (NYC)** with Anthropic, WorkOS, Smithery: the
  WordPress/WooCommerce parent company is active in MCP.

---

## 18. Signals about the hiring round itself

- Prior cycle: ~30 public "Urumi" repos, most last pushed **2026-02-13** (likely that cycle's deadline); several Round 2
  extensions added LangGraph agents doing `kubectl exec` WP-CLI (an approach the current brief steers away from by requiring
  an MCP server and isolation).
- Current cycle: `tech-dipesh/urumi_oa` ("Urumi FDE Intern Online Assessment", README only, pushed 2026-10-08) shows other
  candidates have started.
- Most prior submissions used **ingress-nginx and Kind**; ingress-nginx is now retired.

---

## 19. How the parts intermingle (interaction map)

Each line is a coupling that a decision in one place forces in another.

1. **Naming ↔ client limits ↔ authZ ↔ audit ↔ bonus.** The exposed tool name is the key for routing, for permission
   rules (S-2), for audit rows (D-10), and for store identification (B-3). It's bounded by LLM/Cursor/Claude Code length
   and charset rules (§4.2) and must survive renames of the upstream (store the upstream id + original name, as ContextForge
   ADR-011 does).
2. **Protocol eras ↔ D-8 live updates ↔ Ingress timeouts ↔ scaling.** Modern clients (Claude Code) learn about disabled
   servers via `subscriptions/listen`; legacy clients via the session GET stream. Both are long-held HTTP responses through
   Traefik (timeouts) and across replicas (S-7: which replica holds the stream when the admin disables a server on another
   replica → needs pub/sub or a shared store). A stateless request path is easy to scale; notifications are the stateful part.
3. **Credential model ↔ chat-agent identity ↔ audit ↔ threat model.** Hashed API keys mean the agent needs a
   session-derived identity; that identity must be what the audit log records (M-CA-2); the threat model must explain why
   neither the user's key nor any client token reaches upstreams (DL-5b).
4. **Upstream choice ↔ D-6 cross-server prompt ↔ D-9 pod-kill ↔ collision demo ↔ lethal trifecta ↔ eras.** The two extra
   upstreams must give a natural two-server prompt, at least one killable in-cluster pod, ideally a same-named tool, at least one
   static credential (to demonstrate hiding), *and* not create an unnecessary exfiltration channel. Choosing a legacy and a
   modern upstream would also demonstrate era bridging.
5. **WooCommerce auth ↔ home URL ↔ Ingress host ↔ values-local/prod ↔ TLS.** OAuth 1.0a signatures depend on the public
   home URL (differs local vs prod); Basic/App Passwords depend on `is_ssl()` (Ingress TLS, `X-Forwarded-Proto`, or
   in-cluster TLS). The choice ripples into Helm values and the prod story (S-1, cert-manager).
6. **Immutable image ↔ Helm upgrade/rollback ↔ seeding ↔ persistence.** Baking WooCommerce into the image makes
   `helm rollback` meaningful for code, but DB schema migrations (WooCommerce upgrades run DB updates) don't roll back with the
   image, so a backup step is needed (geekyhead's runbook: backup → upgrade → smoke → rollback + restore).
7. **Caching ↔ isolation.** Any cached tool list, discovery verdict or result must be keyed by authorization context once
   permissions vary by user (Asana incident; TS SDK gateway guide warning; agentgateway disables caching of proxied results).
8. **Health checks ↔ eras ↔ credentials.** A health probe that uses `server/discover` against a legacy server, or hits a
   401 because of a bad upstream credential, must classify correctly ("legacy", "auth failed") rather than "Unreachable".
9. **NetworkPolicy ↔ cluster flavour ↔ DNS ↔ Ingress controller namespace.** Enforcement differs by CNI; default-deny needs
   DNS egress; allowing Ingress traffic needs the Traefik namespace label (k3s: `kube-system`).
10. **Many tools (S-4) ↔ chat agent ↔ free-tier TPM.** Free tiers with small TPM budgets push toward fewer/lazier tool schemas in
    the in-dashboard agent even before S-4 is attempted.
11. **SSRF (S-6) ↔ registering in-cluster upstreams.** An SSRF guard that blocks private ranges would also block our own
    in-cluster WooCommerce MCP server (ClusterIP is private). Docker's answer is an explicit opt-out; ours must be an
    allowlist of trusted in-cluster targets plus a block on everything else private (including 169.254.169.254).

---

## 20. Experiments backlog (to run before or while deciding)

| # | Question | Why it matters |
|---|---|---|
| E1 | Does Claude Code (current) connect to a dual-era gateway in modern mode, open `subscriptions/listen`, and refresh tools on `list_changed`? | D-8 live demo |
| E2 | Same for MCP Inspector v2 CLI/web and Cursor | D-4 client choice |
| E3 | Traefik (k3s default) behaviour with a long-held listen stream: does it get cut at 60s/180s? | D-8 + reconnect storms |
| E4 | What does Claude Code do on 401 vs 403 vs JSON-RPC error after key revocation? | D-7 message clarity |
| E5 | WooCommerce REST from inside the cluster: OAuth 1.0a with home-URL base string vs `X-Forwarded-Proto` Basic vs Application Passwords | M-WM-5 decision |
| E6 | TS SDK v2 client against each legacy signal in §4.1 (400, -32601, -32602, session-required) | Era fallback correctness |
| E7 | k3d on Windows + Docker Desktop: NetworkPolicy enforcement, local-path PVCs, Traefik host routing with `*.127.0.0.1.nip.io` and/or `*.localhost` | Local setup feasibility |
| E8 | Free LLM tool-calling reliability with ~20 tools (Gemini Flash vs Groq gpt-oss) | M-CA-3 |
| E9 | Kill-pod detection latency with Service endpoints vs active probe interval | D-9 |
| E10 | Static read-only WordPress image + uploads PVC + WooCommerce bootstrap Job idempotency on `helm upgrade` | Layer 1 + S-9 |

---

## Sources

**Gateways and platforms**
- IBM ContextForge: https://github.com/IBM/mcp-context-forge (ADRs 009, 011, 032, 038, 041 under docs/docs/architecture/adr)
- agentgateway: https://github.com/agentgateway/agentgateway (crates/agentgateway/src/mcp/README.md, handler.rs, mod.rs, mergestream.rs); https://agentgateway.dev/docs/standalone/latest/mcp/mcp-authz/
- MetaMCP: https://github.com/metatool-ai/metamcp
- Docker MCP Gateway: https://github.com/docker/mcp-gateway (docs/security.md, docs/feature-specs/dynamic_servers.md, embeddings-feature.md)
- Microsoft MCP Gateway: https://github.com/microsoft/mcp-gateway
- Obot: https://docs.obot.ai/concepts/architecture/ ; https://obot.ai/blog/introducing-the-obot-mcp-gateway-hosted-platform/
- ToolHive: https://docs.stacklok.com/toolhive/guides-vmcp/tool-aggregation ; https://docs.stacklok.com/toolhive/guides-k8s/run-mcp-k8s
- kmcp: https://github.com/kagent-dev/kmcp
- LiteLLM MCP permissions: https://docs.litellm.ai/docs/mcp_control
- Kong MCP ACLs: https://developer.konghq.com/mcp/use-access-controls-for-mcp-tools/ ; https://developer.konghq.com/plugins/ai-mcp-proxy/
- Cloudflare MCP portals: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals
- AWS AgentCore Gateway: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-core-concepts.md
- FastMCP composition: https://gofastmcp.com/servers/composition
- Comparisons: https://www.getmaxim.ai/articles/mcp-gateway-comparison-2026-bifrost-docker-microsoft-kong-cloudflare/ ; https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026 ; https://composio.dev/content/best-mcp-gateway-for-developers

**Protocol, SDKs, clients**
- MCP 2026-07-28 changelog / tools / authorization: https://modelcontextprotocol.io/specification/2026-07-28/changelog , /server/tools , /basic/authorization
- MCP security best practices (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- TS SDK v2 (protocol-versions.md, advanced/gateway.md): https://github.com/modelcontextprotocol/typescript-sdk
- Python SDK v2.3.0 release notes: https://github.com/modelcontextprotocol/python-sdk/releases
- MCP Inspector v2: https://github.com/modelcontextprotocol/inspector
- Claude Code changelog: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Cursor tool-name limit: https://forum.cursor.com/t/google-gws-cli-tool-names-too-long/153918
- MCP-AX draft: https://datatracker.ietf.org/doc/draft-abbott-mcp-ax/
- OTel MCP semconv: https://github.com/open-telemetry/semantic-conventions-genai (model/mcp)

**Security**
- OWASP MCP Top 10: https://owasp.org/www-project-mcp-top-10/
- Invariant Labs tool poisoning: https://invariantlabs.ai/blog/mcp-security-notification ; GitHub MCP: https://invariantlabs.ai/blog/mcp-github-vulnerability
- MCPTox: https://arxiv.org/abs/2508.14925 ; SoK MCP security: https://arxiv.org/abs/2512.08290
- Design Patterns: https://arxiv.org/abs/2506.08837 ; CaMeL: https://simonwillison.net/2025/Apr/11/camel/ ; ETDI: https://arxiv.org/abs/2506.01333 ; Spotlighting: https://arxiv.org/abs/2403.14720
- Lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Asana incident: https://bleepingcomputer.com/news/security/asana-warns-mcp-ai-feature-exposed-customer-data-to-other-orgs/
- Supabase: https://supabase.com/blog/defense-in-depth-mcp
- postmark-mcp: https://thehackernews.com/2025/09/first-malicious-mcp-server-found.html
- CVE-2025-6514: https://www.wiz.io/vulnerability-database/cve/cve-2025-6514 ; CVE-2025-49596: https://thehackernews.com/2025/07/critical-vulnerability-in-anthropics.html
- Microsoft indirect prompt injection: https://www.microsoft.com/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks
- Node SSRF/undici: https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs
- GitHub token formats: https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
- API key hashing: https://zuplo.com/learning-center/how-to-implement-api-key-authentication

**Many tools**
- Anthropic code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Tool search / defer_loading: https://unified.to/blog/scaling_mcp_tools_with_anthropic_and_openai_defer_loading.md
- RAG-MCP: https://arxiv.org/abs/2505.03275
- Context bloat survey: https://mcp.directory/blog/mcp-context-bloat-fix-2026-tool-search-code-mode-progressive-disclosure

**Commerce / WordPress**
- WooCommerce MCP docs: https://developer.woocommerce.com/docs/features/mcp/
- WooCommerce canonical abilities: https://developer.woocommerce.com/?p=8770096
- WooCommerce REST auth: https://developer.woocommerce.com/docs/apis/rest-api/authentication/ ; source: woocommerce/woocommerce `class-wc-rest-authentication.php`
- AI & agentic commerce in WooCommerce: https://developer.woocommerce.com/2025/10/03/ai-agentic-commerce-in-woocommerce/
- Shopify MCP overview: https://www.gamut.so/blog/shopify-mcp-guide ; UCP: https://www.shopifreaks.com/google-and-shopify-launch-universal-commerce-protocol/
- Official WordPress image docs: https://github.com/docker-library/docs/tree/master/wordpress
- Urumi blogs: https://urumi.ai/blog/how-we-made-woocommerce-downtime-invisible-and-scale-effortless ; https://urumi.ai/blog/how-we-built-the-fastest-woocommerce-hosting-and-the-advent-of-self-healing-software
- Bitnami change: https://northflank.com/blog/bitnami-deprecates-free-images-migration-steps-and-alternatives ; mariadb-operator: https://mariadb.com/docs/server/server-management/automated-mariadb-deployment-and-administration/kubernetes-and-mariadb/kubernetes-operators-for-mariadb
- Bitpoke stack: https://www.bitpoke.io/docs/stack/overview/

**Kubernetes**
- Helm 3 EOL / Helm 4: https://helm.sh/blog/helm-v3-end-of-life
- k3s secrets encryption: https://docs.k3s.io/security/secrets-encryption
- Traefik entrypoints: https://doc.traefik.io/traefik/v3.5/reference/install-configuration/entrypoints/
- ingress-nginx retirement: https://www.cloudmagazin.com/en/2026/03/17/ingress-nginx-reaches-end-of-life-how-cloud-teams-are-migrating-to-gateway-api-n/
- Oracle free tier change: https://terminalbytes.com/oracle-cloud-free-tier-changes-2026

**Chat / LLM**
- LibreChat MCP: https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers
- Open WebUI MCP: https://docs.openwebui.com/features/extensibility/mcp
- Vercel AI SDK MCP: https://vercel.com/docs/mcp/integrations/ai-sdk
- langchain-mcp-adapters: https://github.com/langchain-ai/langchain-mcp-adapters
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing ; Groq limits: https://console.groq.com/docs/rate-limits

**Competitions and prior cycle**
- Solo.io hackathon 2026: https://www.solo.io/blog/celebrating-the-winners-of-the-2026-hackathon-for-mcp-ai-agents
- Descope Global MCP hackathon: https://www.descope.com/blog/post/global-mcp-hackathon-winners
- HF Agents & MCP hackathon: https://huggingface.co/Agents-MCP-Hackathon
- Prior Urumi submissions: https://github.com/geekyhead/Urumi-system-design ; https://github.com/nandan2003/urumi-kubernetes
