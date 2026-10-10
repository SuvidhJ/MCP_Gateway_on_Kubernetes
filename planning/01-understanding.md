# 01 — Problem Understanding (Urumi AI FDE Internship, Round 1)

Status: research complete, no architecture decisions taken yet. Source of truth for requirements is
[project.md](../project.md); this file interprets it, adds context, and numbers every requirement so
later planning can reference them by ID.

---

## 1. The company and why this assignment exists

**Urumi.AI** (urumi.ai): San Francisco-based, founded 2025, pre-seed from Antler (Jan 2026). They sell
an "agentic AI platform for WooCommerce": managed WooCommerce hosting on Kubernetes (Google Cloud, multi-zone, autoscaling,
PITR backups, per-branch staging, one-click rollback, APM), plus three AI products on top:

| Urumi product | What it does | Where it shows up in this assignment |
|---|---|---|
| Hosting | WooCommerce on Kubernetes, "never slows down, never goes down" | Layer 1: store on K8s, Helm, local to VPS |
| Analytics AI | "Ask your store anything" over live store data | Chat agent: "what orders came in today?" |
| MCP access (BYO model) | "Connect the Claude / ChatGPT / Gemini you already pay for", "zero AI markup", access "scoped to your store and can be revoked at any time" | Gateway: one URL + personal key, revocable |
| Urumi's own MCP server | Runs "alongside the WooCommerce core one", exposes what core cannot | Layer 2: write your own WooCommerce MCP server |
| Integrity engine / safety | "Scoped user, never an administrator account", "read-only for the first week; enable writes one ability at a time" | Upstream creds server-side, roles, audit log, stand-out "tool permissions" |
| Team context | "In-house engineers and agency partners get the same context" | Team gateway: admin connects once, everyone uses |

Founders are ex-Automattic WooCommerce leads: Naman Malhotra (Payments, WooCommerce releases) and Vedanshu
Jain (HPOS, Taxes, Shipping, performance). Expect reviewers who know WooCommerce internals deeply (REST
API, HPOS, checkout, WP-CLI).

**The assignment is a miniature of Urumi's product.** Each of the four layers maps onto something they
actually run. That tells us what "good" looks like: production-minded, safe-by-default, operable.

### Signals from their hiring pages (urumi.ai/careers)

- *Forward Deployed AI Engineer*: work with merchants, build agents (LangGraph, tool-use, retrieval),
  build evaluation harnesses, "harden agents for production with error handling and monitoring",
  "generalize client workflows into platform capabilities", "bias toward shipping quickly".
- *DevOps Engineer*: "Maintain Kubernetes infrastructure for WooCommerce at scale", observability
  (Grafana / Prometheus / OpenTelemetry), "boring, battle-tested solutions".
- *Generalist*: "from LangGraph to Kubernetes"; stack: React, PHP, Python, Kubernetes, Docker, LangGraph.

### History of this hiring process

The previous Urumi cycle (SDE internship, Round 1) was **only** the store-provisioning platform: multi-store
WooCommerce on K8s with Helm, React dashboard, local and VPS. Public submissions exist (e.g. nandan2003/urumi-kubernetes,
DarkMatter1217/Urumi_R1). Their Round 2 added an AI/LangGraph layer. **This cycle demotes that whole
assignment to the optional bonus** and makes the core MCP plus AI. Implications:
- The bar went up. Store-on-K8s is table stakes, and reviewers have seen many versions of it.
- The differentiator is the MCP and security layer and how well we understand it.
- Copying the old pattern for the bonus will not stand out. Doing the core deeply will.

### What they want from us (explicit and inferred)

Explicit in the brief:
1. "A working core is worth more than an unfinished bonus."
2. AI tools are encouraged, but **you must understand the internals**: K8s resources, MCP protocol flow,
   how credentials move, where isolation is enforced. The demo video is effectively an oral exam on these.
3. "Must be testable": a scripted definition-of-done flow, live, with two users.
4. "We grade that the tool loop works, not the quality of the model's answers."

Inferred:
5. Production thinking: same charts local and VPS, secrets discipline, probes, limits, upgrade and rollback.
6. Security judgment: threat model, token passthrough, malicious upstreams, prompt injection.
7. Clear written communication: README, design note, threat model (the FDE role is client-facing).
8. Depth in one stand-out area over a thin attempt at many ("depth in one area beats a thin attempt at all of them").

---

## 2. System in one picture

```
                    Internet / host machine
   Browser ──────────────┐            ┌────────── Claude Code / Cursor / MCP Inspector
   (shopper, admin,      │            │           (user B: gateway URL + API key only)
    team members)        ▼            ▼
                  ┌──────────── Ingress (stable hosts) ─────────────┐
                  │ store.<domain>      dashboard.<domain> (+ /mcp) │
                  └──────┬──────────────────────┬───────────────────┘
                         │                      │
              ┌──────────▼─────────┐   ┌────────▼──────────────────────────────┐
              │ WordPress +        │   │ Dashboard (React) + Backend/Gateway   │
              │ WooCommerce        │   │  - auth: sessions (UI), API keys (MCP)│
              │ (PVC: wp-content)  │   │  - MCP SERVER: one endpoint, aggregate│
              └──────────▲─────────┘   │  - MCP CLIENT: to every upstream      │
                         │             │  - audit log, upstream registry       │
              ┌──────────┴─────────┐   │  - chat agent (LLM tool loop)  ───────┼──► LLM provider
              │ MySQL/MariaDB      │   └───────┬──────────────┬────────────┬───┘   (key in Secret)
              │ (PVC)              │           │ upstream     │ upstream   │ upstream
              └──────────▲─────────┘           │ cred (Secret)│ cred       │ cred
                         │ REST API (WC key)   ▼              ▼            ▼
              ┌──────────┴──────────────┐  upstream #2    upstream #3   (more, added by admin)
              │ WooCommerce MCP server  │  (choice)       (choice)
              │ (ours; ClusterIP only;  │
              │  NetworkPolicy: only    │
              │  gateway may connect)   │
              └─────────────────────────┘
```

Invariant: **the chat agent and external clients reach every MCP server only through the gateway.**
Nothing else talks to the upstream servers directly.

---

## 3. Requirements catalogue (numbered)

`M` = mandatory, `D` = definition-of-done demo step, `S` = stand-out (optional), `B` = bonus (optional).

### 3.1 Store (Layer 1)
| ID | Requirement |
|---|---|
| M-ST-1 | One WordPress + WooCommerce store running in K8s. |
| M-ST-2 | Store DB and WordPress content (wp-content: uploads, plugins) on persistent storage. |
| M-ST-3 | Storefront exposed through Ingress with a stable URL; document local domain approach. |
| D-ST-1 | Storefront: add product to cart, check out with COD or dummy gateway. |
| D-ST-2 | The order is visible in WooCommerce admin. |

### 3.2 WooCommerce MCP server (Layer 2)
| ID | Requirement |
|---|---|
| M-WM-1 | Written by us. Do **not** install an existing WooCommerce MCP server/plugin. Note: WooCommerce core ships its own MCP integration (dev preview since 10.3, Abilities API). We must not use or enable it as our server. |
| M-WM-2 | Speaks MCP over **Streamable HTTP**. |
| M-WM-3 | Tools (minimum): list products, create product, list orders, get order, update order status. |
| M-WM-4 | Not reachable from outside the cluster; **only the gateway** can call it. |
| M-WM-5 | Document how it talks to the store (REST API / WP-CLI / other) and why. |

### 3.3 Gateway and dashboard (Layer 3)
| ID | Requirement |
|---|---|
| M-GW-1 | React dashboard + backend. Admins add, edit, disable, remove upstream MCP servers (Streamable HTTP), each with optional static credential (custom header or bearer token). |
| M-GW-2 | Backend is an MCP **client** to every registered server and an MCP **server** exposing all of their tools at **one endpoint**. |
| M-GW-3 | `tools/list` returns tools of every **enabled** server; `tools/call` routed to the right server. |
| M-GW-4 | Tool-name collisions between servers handled by a **documented scheme**. |
| M-GW-5 | Slow or dead upstream must not break listing or calls to others. Calls have **timeouts** and return a **clear error**. |
| M-GW-6 | Upstream credentials stay server-side: never sent to the browser or to an MCP client. |
| M-GW-7 | At least **three** upstreams connected: our WooCommerce server + two others of our choice. |
| M-GW-8 | Dashboard shows each server's status: Connected / Unreachable / Disabled, plus tools per server. |
| M-GW-9 | WooCommerce MCP server is **pre-registered** as the first server (no manual step after install). |

### 3.4 Team and access
| ID | Requirement |
|---|---|
| M-TA-1 | At least two roles: **admin** (manages servers and members), **member** (uses tools). |
| M-TA-2 | Admin invites team members, issues or revokes their API keys. |
| M-TA-3 | Member generates their own API key in the dashboard. |
| M-TA-4 | Each user has their own gateway API key. Keys revocable. **Stored hashed.** |
| M-TA-5 | Every tool call audited: user, server, tool, timestamp, duration, outcome. Visible in dashboard. |
| M-TA-6 | Member adds one URL + key to an MCP client and sees tools of every enabled server with no per-server config. |
| M-TA-7 | Members never see or need upstream credentials. |

### 3.5 Chat agent (Layer 4)
| ID | Requirement |
|---|---|
| M-CA-1 | Chat in the dashboard; an LLM calls tools **through the gateway**; UI shows which tools it called. |
| M-CA-2 | Acts as the **logged-in user**; its calls appear in the audit log under that user. |
| M-CA-3 | Model, provider, design are free choice (free tier or local model OK). Graded on the tool loop working. |
| M-CA-4 | LLM API key is a K8s Secret like every other secret. |

### 3.6 Kubernetes and Helm (cross-cutting)
| ID | Requirement |
|---|---|
| M-K8-1 | Runs on local K8s (Kind, k3d or Minikube). |
| M-K8-2 | Deployable to a production-like VPS (k3s OK) with the **same Helm charts**, config changes only. |
| M-K8-3 | Helm mandatory, **no Kustomize**. Local vs prod via values files (e.g. `values-local.yaml`, `values-prod.yaml`). |
| M-K8-4 | Everything in cluster: store, DB, WooCommerce MCP server, gateway backend, dashboard. |
| M-K8-5 | Readiness **and** liveness probes on **every** workload. |
| M-K8-6 | Resource requests **and** limits on every workload. |
| M-K8-7 | No hardcoded secrets in source; credentials in K8s Secrets. |

### 3.7 Definition of done (demo, two users A and B)
| ID | Step |
|---|---|
| D-1 | Storefront checkout (COD) → order visible in WC admin. (= D-ST-1/2) |
| D-2 | User A, chat: "create product X at price Y" → product appears on storefront. |
| D-3 | Place an order for X by hand on storefront; ask agent "what orders came in today?" → returns that order. |
| D-4 | User B: connect Claude Code / Cursor / MCP Inspector with **only** gateway URL + B's API key. |
| D-5 | B sees tools of every enabled server and asks the same orders question successfully. |
| D-6 | B runs **one prompt needing tools from two different upstreams**. |
| D-7 | Revoke B's key → B's next call is rejected. |
| D-8 | Disable one upstream → its tools disappear from **both** chat agent and external client. |
| D-9 | Kill one upstream's pod → others keep working; dashboard shows it **Unreachable**. |
| D-10 | Every call above in the audit log, attributed to the right user. |

### 3.8 Deliverables
| ID | Deliverable |
|---|---|
| DL-1 | README: local setup, VPS setup, how to place an order, connect an external MCP client, use the chat agent. |
| DL-2 | Source: dashboard, backend+gateway, WooCommerce MCP server, chat agent. |
| DL-3 | Helm charts + values files (local and production). |
| DL-4 | "System design and tradeoffs" note: architecture choices; aggregation, routing, failure handling; what changes for production (DNS, ingress, storage class, secrets). |
| DL-5 | Threat model note: (a) shared upstream creds: what a member can do with a credential they never see; (b) why client tokens are not passed through to upstreams; (c) untrusted upstreams: tool descriptions that manipulate the model; (d) what one team member can do to another. |
| DL-6 | List of attempted bonus/stand-out items and where to find them. |
| DL-7 | Demo video (see §6) + GitHub repo, submitted via the Google Form. |

### 3.9 Bonus (only after core works end to end)
B-1 create/delete stores from the dashboard with status Provisioning/Ready/Failed, URL, created time, concurrent
provisioning · B-2 per-store namespace, DB, Secrets, PVs, Ingress host via Helm or K8s API · B-3 per-store
WooCommerce MCP server auto-registered, tool names identify the store · B-4 clean teardown incl. MCP registration ·
B-5 NetworkPolicy isolation between stores · B-6 ResourceQuota + LimitRange per namespace, max stores per user,
provisioning timeout · B-7 idempotent create; survives provisioner restart (complete or fail cleanly with a reason) ·
Test: agent compares today's orders across two stores, then delete one and show its tools and resources are gone.

### 3.10 Stand-out options
S-1 real VPS/cloud deploy (+ cert-manager TLS) · S-2 tool permissions per role/user (hidden from list **and** rejected
on call) · S-3 OAuth per MCP authorization spec · S-4 many-tools handling (search-then-execute meta tools) ·
S-5 hosted MCP servers from container image (own Secret, limits, NetworkPolicy, clean removal) · S-6 security
hardening (SSRF on admin-entered URLs, least-privilege RBAC, default-deny NetworkPolicies, non-root, upstream creds
encrypted at rest) · S-7 scaling (>1 gateway replica with MCP sessions working, per-user/key rate limits) ·
S-8 observability (tool-call metrics, error rate, latency per server; clear reasons for unreachable/failed) ·
S-9 Helm upgrade and rollback story.

---

## 4. Hidden requirements, traps and interpretation notes

These follow from the brief but are not spelled out. Each one is either a likely failure point or a
chance to show understanding.

### MCP protocol (important: the spec changed in July 2026)
1. **Current MCP spec is `2026-07-28`** (final 2026-07-28). It removes the `initialize` handshake **and
   protocol sessions** (`Mcp-Session-Id`), removes the GET SSE stream (replaced by `subscriptions/listen`),
   removes resumability, adds `server/discover`, a per-request `_meta` envelope (protocol version, client
   capabilities), **required `Mcp-Method` / `Mcp-Name` headers** on POSTs, `resultType` on all results,
   `ttlMs` / `cacheScope` on list results, MRTR (`input_required`) replacing server-initiated requests,
   and deprecates sampling, roots and logging.
2. **Clients in the wild are mixed-era.** Claude Code, Cursor and Inspector may speak 2025-era (legacy:
   `initialize` + sessions) or 2026. **The gateway must serve both eras** on its endpoint, and as a client must
   negotiate each upstream's era independently. The official SDKs (TypeScript v2.3.x `@modelcontextprotocol/server` /
   `client`; Python v2.3.0) speak both eras: `createMcpHandler` serves both, and the client's `versionNegotiation: 'auto'`
   probes with `server/discover` and falls back to `initialize`. The TS SDK ships a dedicated **gateway guide**
   (cache discovery verdicts per upstream, keyed by auth context). v1 (`@modelcontextprotocol/sdk` 1.32.x) is maintenance-only.
3. Statelessness makes **multi-replica gateways** (S-7) easy for modern clients. Legacy clients with sessions
   need sticky routing, a shared session store, or the SDK's stateless legacy mode.
4. **"Tools disappear" (D-8) has two halves:** (a) the next `tools/list` omits them and calls to them are
   rejected even from a client with a stale cached list; (b) ideally the gateway emits
   `notifications/tools/list_changed` so clients refresh without reconnecting (legacy: on the session's GET
   stream; modern: on `subscriptions/listen`). Claude Code reacts to list_changed; verify this for the demo client.
5. `tools/list` **may vary by authorization** (explicitly allowed by spec), so per-user/role filtering (S-2)
   is spec-compliant. It must not vary per connection.
6. Tool **execution** errors (upstream timeout, upstream 5xx, WooCommerce validation) should be returned as
   `isError: true` results with a human-readable reason so the model can recover. **Protocol** errors (unknown
   tool, bad params) are JSON-RPC errors. "Clear error" means something like `"Upstream 'github' timed out after 15s"`.
7. Deterministic tool ordering (spec SHOULD) improves LLM prompt caching. It is cheap to do.

### Tool-name collision scheme (M-GW-4) constraints
8. MCP spec: names 1–128 chars, `[A-Za-z0-9_.-]`. **But** LLM provider APIs (Anthropic, OpenAI) accept
   only `[a-zA-Z0-9_-]{1,64}`: **no dots**, max 64. Claude Code prefixes tools as `mcp__<server>__<tool>`
   (64-char issues are reported), and **Cursor caps server+tool at 60 chars**. So the namespaced name must be short and
   dot-free, e.g. `<slug>__<tool>` with an admin-chosen, validated short slug (`[a-z0-9]{1,12}`). Do not rely on
   `serverInfo.name` (spec says it is not unique). Plan for over-long names (deterministic truncation + hash suffix).

### Credentials and identity
9. **API keys are stored hashed**, so the backend cannot recover a user's key to make calls "as them". The chat agent
   therefore cannot simply reuse the user's API key. It needs another way to carry the logged-in identity to the
   gateway: e.g. a short-lived, audience-bound token minted from the dashboard session, or an in-process call with
   an authenticated principal. This is the core of M-CA-2 and a good demo talking point.
10. Gateway API keys are high-entropy random secrets, so a fast keyed hash (SHA-256/HMAC with a server-side pepper) is
    appropriate. bcrypt/argon2 are for low-entropy passwords and would add per-request latency. Use a prefixed format
    (e.g. `urk_<keyId>_<secret>`) for O(1) lookup, secret-scanning, and attributing rejected calls. Show the plaintext once.
11. Dashboard login (sessions, passwords/invite links) is a **separate** auth mechanism from gateway API keys.
    "Invite team members" implies an invite flow (link/token → set password).
12. "Never sent to the browser" applies to admins too. The edit form must treat upstream credentials as
    **write-only** ("•••• set", replace or clear), and they must not leak through error messages, audit
    entries, logs, or upstream response headers relayed to clients.
13. **No token passthrough** (spec MUST NOT): the user's gateway key is never forwarded upstream. Upstreams get
    the admin-configured static credential. The threat model must explain why (audience confusion, confused
    deputy, audit, security-control bypass, blast radius).

### Failure handling
14. Listing must fan out to upstreams **in parallel with per-upstream timeouts** (or serve from a refreshed
    cache) so one slow server cannot stall `tools/list`. Decide: are tools of an *Unreachable* (not disabled)
    server omitted, or listed from cache with calls failing fast? The DoD requires only "others keep working" and
    dashboard shows Unreachable.
15. **Kill-the-pod (D-9) timing:** a Deployment replaces a deleted pod within seconds. The health checker must
    detect quickly (short interval and/or passive detection on failed calls), otherwise the demo shows "Connected"
    throughout. Plan the demo (e.g. watch the dashboard during `kubectl delete pod`, or scale to 0).
16. Distinguish *Disabled* (admin intent, no connection attempts) from *Unreachable* (enabled, failing), and
    record **why** (DNS, connection refused, timeout, 401 from upstream, protocol error). That last part is S-8.

### Audit (M-TA-5, D-10)
17. "Every call above" includes the **rejected** call after revocation (D-7). An unauthenticated request can still be
    attributed if the key's prefix/id identifies the owner (log as "revoked key of user B"). Also audit chat-agent calls
    (as user A) and calls to disabled or unknown tools.
18. Decide whether members see the whole team's audit log or only their own (privacy between members, see §5d).

### WooCommerce specifics (reviewers are WooCommerce core people)
19. **REST auth over in-cluster plain HTTP:** WooCommerce consumer key/secret via Basic auth is only accepted over
    HTTPS. Over HTTP it requires **OAuth 1.0a one-legged** signatures. WordPress Application Passwords also require
    HTTPS unless the environment type is `local` or a filter allows them. Options: sign with OAuth 1.0a (clean, no WP changes),
    terminate TLS in-cluster, or a must-use plugin. WP-CLI via `kubectl exec` would need K8s API privileges for the MCP
    server (poor least privilege, and it couples to pod internals), which is a good "why not" for M-WM-5.
20. Use a **dedicated, least-privilege WooCommerce API key/user** (Urumi's own guidance: "Scoped user, never an
    administrator account"; Shop Manager-level), generated at install time and stored as a Secret.
21. **"Orders that came in today"**: WooCommerce dates are in the store's timezone (`date_created`) and GMT
    (`date_created_gmt`). The REST `after`/`before` filters interpret site time unless `dates_are_gmt`. Set the store
    timezone explicitly at install and make the tool compute "today" unambiguously. Otherwise the DoD step can
    silently return nothing near midnight UTC.
22. **COD is disabled by default** and must be enabled at install (WP-CLI/REST). New stores use **block-based
    checkout** and **HPOS** by default (fine through the REST API). Agent-created products must be `publish` to show
    on the storefront. `/wp-json/` needs pretty permalinks (or use `?rest_route=`).
23. Automate store bootstrap (WordPress install, WooCommerce activate, settings, COD, sample products, API key →
    Secret) idempotently, e.g. a Helm hook Job or init logic. It must be re-runnable on `helm upgrade`.
24. WordPress `siteurl`/`home` must match the Ingress host (or redirects break), and differ local vs prod via values.
    The in-cluster MCP server calls the store via its Service DNS, so the Host header and redirects need care.

### Kubernetes ecosystem facts (as of Oct 2026)
25. **Bitnami free images are gone** (moved to `bitnamilegacy` in Aug 2025, no updates; current ones need a
    subscription). Do not depend on the Bitnami WordPress/MariaDB charts. Use official `wordpress` and `mysql`/`mariadb`
    images in our own templates (or a maintained operator).
26. **ingress-nginx was retired (March 2026)**: no more releases or security patches. **Traefik** is the k3s/k3d
    default and the industry replacement, so "same charts local and VPS" is easiest with Traefik on both. Gateway API is the
    future direction, but the brief explicitly says **Ingress**.
27. **NetworkPolicy enforcement depends on the cluster:** k3s/k3d enforce via the embedded kube-router controller;
    Minikube's default CNI does not. Recent Kind kindnet versions support it (verify the version). Proving M-WM-4 needs an
    enforcing CNI. A ClusterIP Service with no Ingress already keeps it off the internet; NetworkPolicy additionally
    keeps other pods out ("only the gateway can call it"). Defense in depth: also require a shared secret from the gateway.
28. Secrets: "no hardcoded secrets" + "same charts" suggests generating random secrets on first install
    (Helm `lookup` to keep them stable across upgrades) **or** `existingSecret` references in prod (created
    out-of-band / SOPS / Sealed Secrets / External Secrets). Never commit `values-prod.yaml` secrets.
29. Probes and limits on **every** workload includes MySQL, WordPress, MCP servers, gateway, dashboard (nginx),
    and any extra upstream servers we host. Jobs don't take probes, but should have limits.
30. Local domain: options are `*.localhost` (browsers resolve it to loopback; native clients such as Node on Windows may
    not), `nip.io`/`sslip.io` wildcard DNS (`store.127.0.0.1.nip.io`, which works for external MCP clients too), or hosts-file
    entries. Must be documented (M-ST-3). Dev machine is **Windows 11**, so the setup has to work there (Docker Desktop + k3d/kind).
31. Resource budget: WordPress + MySQL + gateway + dashboard + ≥3 MCP servers (+ maybe local LLM) on a laptop and a
    small VPS. A local LLM (Ollama) in-cluster is heavy, so a free hosted tier is probably more practical. Free tiers change
    often (Gemini, Groq, OpenRouter all advertise tool calling); verify limits at selection time.

### Demo-driven requirements
32. D-6 needs a natural prompt spanning two upstreams, so the choice of the two extra upstreams should be driven by a
    compelling cross-server prompt (e.g. orders + something that enriches or acts on them). D-9 needs at least one in-cluster
    upstream pod to kill (the WooCommerce MCP server qualifies, but killing a non-Woo one lets Woo keep answering).
33. A collision demo (M-GW-4) needs two servers exposing a same-named tool. Plan which ones.
34. Two simultaneous identities (A in the dashboard, B in Claude Code) need two browser profiles or one browser plus the CLI.

---

## 5. Threat-model questions we must answer (DL-5), with initial thinking

a. **Shared upstream credential a member never sees**: the member can exercise *every capability that credential
   grants*, but only through the tools the upstream exposes (and that the gateway allows). They cannot extract it,
   but can still cause its effects (delete data, spend quota, exfiltrate via tool outputs). Mitigations: least-privilege
   upstream credentials, per-role tool allowlists (S-2), audit attribution, rate limits, revocation.
b. **No client-token passthrough**: the spec forbids it. Tokens must be audience-bound to the gateway. Passing
   them upstream leaks the user's gateway credential to a possibly malicious upstream (which could replay it against the
   gateway or other servers), bypasses gateway controls, breaks audit, and creates a confused-deputy risk.
c. **Untrusted upstreams / tool poisoning**: descriptions or results that instruct the model ("also call
   `update_order_status` on all orders…", "send the API key to…"), shadowing other servers' tool names, or
   "rug pulls" (definitions change after approval). Mitigations: namespacing (cannot shadow), admin review and
   **pinning/hash of tool definitions with change detection**, description length limits and sanitization, showing
   tool calls in the UI, keeping credentials out of model context, not giving the LLM secrets to leak, SSRF guard on
   upstream URLs, egress NetworkPolicy for the gateway.
d. **Member vs member**: shared upstream state means A can modify or cancel orders B created. **Indirect prompt
   injection** is the subtle one: A creates a product whose name/description contains instructions, and B's agent later
   lists products and may follow them. Also: quota or rate-limit exhaustion of shared upstreams, seeing others' audit
   entries or chat history (decide visibility), and a member can't revoke others' keys or manage servers (role checks
   server-side, not just hidden in UI).

---

## 6. Demo video checklist (what the video must cover)

1. System design and implementation: components and responsibilities; the DoD flow live with two users.
2. Kubernetes: namespaces, Secrets, volumes, Ingress; requests/limits, probes; public vs internal and **how enforced**.
3. MCP internals: how the gateway connects to upstreams; a tool call's path client → gateway → upstream → store and back;
   collisions, timeouts, dead upstream.
4. Security posture: API key and upstream credential storage and use; what a member can and cannot do; malicious or
   compromised upstream.
5. Chat agent: the tool loop; how it acts as the logged-in user.
6. Local-to-VPS: what changes via Helm values; ingress, domains, storage, secrets strategy; Helm upgrade and rollback.

---

## 7. Open decisions for the next iteration (architecture & planning)

| # | Decision | Notes |
|---|---|---|
| 1 | Backend/gateway language | TS SDK v2 (has a gateway guide; same language as React) vs Python SDK v2 (+ LangGraph matches Urumi's stack). |
| 2 | WooCommerce MCP server language | Same as gateway for velocity, or PHP to show WooCommerce affinity. |
| 3 | Store ↔ MCP channel | REST + OAuth 1.0a (likely) vs REST + in-cluster TLS vs WP-CLI (reject). |
| 4 | Two extra upstreams | Driven by the D-6 cross-server prompt; at least one in-cluster (pod-kill demo) and one with a credential (shows secret hiding); one shares a tool name for the collision demo. |
| 5 | LLM provider | Free hosted tier with reliable tool calling vs local model; agent framework (plain loop vs LangGraph). |
| 6 | Local cluster | k3d (k3s parity with VPS, Traefik, NetworkPolicy enforced, local-path storage) vs Kind vs Minikube. |
| 7 | Chart layout | One umbrella chart with subcharts vs separate charts; secret generation strategy. |
| 8 | Gateway persistence | Registry, users, keys, audit log: Postgres in-cluster vs SQLite on PVC (affects S-7 scaling). |
| 9 | Unreachable-server tool listing | Omit vs cached + fail fast. |
| 10 | Stand-out picks | Most aligned with Urumi: S-2 tool permissions (mirrors their "read-only first" guidance), S-8 observability (DevOps role, OTel in spec), S-1 VPS deploy, S-6 hardening. Pick 1–2 and go deep. |
| 11 | VPS availability | Do we have a VPS/cloud free tier for S-1 / the production story? |
| 12 | Deadline | Unknown; sets scope. |

---

## Sources
- Urumi: https://urumi.ai · /careers · /woocommerce · /ai-for-woocommerce · /blog/woocommerce-mcp-explained · /blog/connect-claude-chatgpt-gemini-to-woocommerce
- WordCamp Bengaluru 2025 sponsor post (Urumi.AI description); Preqin profile (founded 2025, SF, Antler round Jan 2026)
- Previous-cycle submissions: github.com/nandan2003/urumi-kubernetes, github.com/DarkMatter1217/Urumi_R1
- MCP spec 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog ; tools: /specification/2026-07-28/server/tools
- MCP 2025-11-25 transports + security best practices: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports , /basic/security_best_practices
- TS SDK v2: github.com/modelcontextprotocol/typescript-sdk (docs/protocol-versions.md, docs/advanced/gateway.md)
- WooCommerce REST auth: https://developer.woocommerce.com/docs/apis/rest-api/authentication/
- Bitnami catalog change (Aug 2025); ingress-nginx retirement (Mar 2026); k3s/k3d NetworkPolicy (kube-router)
- Cursor 60-char tool name limit: forum.cursor.com; Claude Code 64-char tool name issue
