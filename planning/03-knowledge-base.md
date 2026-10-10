# 03 — Knowledge Base: Concepts and Architectures

Written 2026-10-09. Purpose: understand every moving part well enough to design it, build it, and **defend it in the
demo video and interview** ("You should understand the internals: the Kubernetes resources, the MCP protocol flow, how
credentials move, and where isolation is enforced"). Each section ends with **→ In our system**: what the concept means
for this assignment. Facts come from the spec, SDK docs and source code researched in [02](02-landscape-research.md) and
[04](04-deep-dive-and-options.md); nothing here is a decision.

Contents
1. MCP from first principles
2. How an MCP gateway works
3. Kubernetes for this project
4. WordPress and WooCommerce internals
5. LLM agents and the tool loop
6. Security concepts
7. Glossary

---

## 1. MCP from first principles

### 1.1 What MCP standardises

MCP is a protocol between an **AI application** and **capability providers**. Three roles:

| Role | What it is | Example in our system |
|---|---|---|
| **Host** | The app the user talks to; owns the LLM and the UI | Claude Code, Cursor, our dashboard chat |
| **Client** | A connector inside the host, one per server connection | Claude Code's connection to our gateway; our gateway's connection to each upstream |
| **Server** | Exposes capabilities | Our WooCommerce MCP server, upstream #2/#3, **and our gateway** (it is a server to clients) |

Server-side primitives: **tools** (model-invoked functions, the main thing we care about), **resources** (readable data
by URI), **prompts** (templates). Client-side features: elicitation (ask the user something), sampling, roots. In
2026-07-28, sampling/roots/logging are *deprecated*, and server→client asks are expressed as MRTR results (§1.5).

→ **In our system:** the gateway is both a **server** (to Claude Code / chat agent) and a **client** (to every upstream).
That double role is the whole architecture. We mainly need *tools*; resources/prompts are optional.

### 1.2 JSON-RPC 2.0, the message layer

Every MCP message is a JSON-RPC 2.0 object:

```jsonc
// request: has an id, expects a response
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_orders","arguments":{"status":"processing"}}}
// success response: same id
{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}
// error response: same id, error object
{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"Unknown tool: list_ordrs"}}
// notification: no id, no response
{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}
```

Error codes you will meet:

| Code | Meaning | Where |
|---|---|---|
| -32700 / -32600 | Parse error / invalid request | malformed JSON |
| -32601 | Method not found | unknown RPC (modern servers answer it with **HTTP 404**) |
| -32602 | Invalid params | unknown tool, bad arguments (also "resource not found" in 2026-07-28) |
| -32603 | Internal error | server bug |
| -32000…-32019 | Implementation-defined | e.g. SDKs' "session not found" (-32001) |
| **-32020** | `HeaderMismatch` | HTTP headers disagree with body (2026-07-28) |
| **-32021** | `MissingRequiredClientCapability` | 2026-07-28 |
| **-32022** | `UnsupportedProtocolVersion` (+ `data.supported`) | 2026-07-28 |

**Two kinds of tool failure** (important for "calls have timeouts and return a clear error", M-GW-5):
- *Protocol error* (JSON-RPC `error`): the request itself is wrong, e.g. an unknown tool. Models rarely recover from these.
- *Tool execution error* (`result` with `isError: true` and a human-readable text): the tool ran but failed, e.g. upstream
  timeout, WooCommerce validation error, upstream 5xx. The spec says clients **SHOULD** pass these to the model so it can
  self-correct. Example: `{"isError":true,"content":[{"type":"text","text":"Upstream 'weather' did not respond within 10s. Other tools are unaffected."}]}`.

→ **In our system:** upstream timeouts and dead upstreams become `isError` results with a clear message; unknown or
disabled tool names become `-32602`; auth failures are HTTP 401/403 before JSON-RPC.

### 1.3 Tools in detail

A tool definition (from `tools/list`): `name`, optional `title`, `description`, `inputSchema` (JSON Schema, default
dialect 2020-12, must be an object schema), optional `outputSchema` (then the result carries `structuredContent`), optional
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), optional `icons`, optional `_meta`.

- **Names:** SHOULD be 1–128 chars of `[A-Za-z0-9_.-]`, unique *within one server*. Aggregators SHOULD disambiguate.
  LLM APIs are stricter (`[a-zA-Z0-9_-]`, ≤ 64 chars). Claude Code exposes tools as `mcp__<server>__<tool>` and
  replaces any other character with `_`; Cursor limits server+tool to 60 chars.
- **Annotations are hints, not guarantees:** the spec says clients MUST treat them as untrusted unless the server is
  trusted. A malicious server can mark a destructive tool `readOnlyHint: true`.
- **Results:** `content[]` blocks (`text`, `image`, `audio`, `resource_link`, `resource`) and/or `structuredContent`
  (any JSON value matching `outputSchema`; also serialise it into a text block for older clients).
- **Spec "MUST"s for servers:** validate inputs, implement access controls, rate-limit invocations, sanitise outputs.
- **Determinism:** `tools/list` SHOULD return a stable order (prompt-cache friendly).

### 1.4 The legacy era (2025-03-26 … 2025-11-25) on Streamable HTTP

One endpoint (e.g. `/mcp`), three HTTP verbs:

```http
POST /mcp                                   ← 1. handshake
Accept: application/json, text/event-stream
Content-Type: application/json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.x"}}}

HTTP/1.1 200 OK
Mcp-Session-Id: 1868a90c...                 ← server MAY create a session
Content-Type: application/json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{...}}}

POST /mcp   (Mcp-Session-Id + MCP-Protocol-Version headers)   ← 2. notifications/initialized → 202 Accepted
POST /mcp   tools/list, tools/call ...      ← 3. each request: response is JSON or an SSE stream
GET  /mcp   (Accept: text/event-stream)     ← 4. optional standalone stream for server-initiated messages
DELETE /mcp (Mcp-Session-Id)                ← 5. end session
```

Properties: **stateful** (sessions bind requests together; with multiple server replicas you need sticky routing or a
shared store); server→client *requests* (sampling, elicitation) travel on SSE streams; resumability via SSE event IDs and
`Last-Event-ID`; an unknown/expired session gets **404** and the client must re-initialise.

### 1.5 The modern era (2026-07-28)

No handshake, no sessions, POST only:

```http
POST /mcp
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28            ← REQUIRED on every POST, must equal the _meta version
Mcp-Method: tools/call                      ← REQUIRED (mirrors body.method)
Mcp-Name: woo__list_orders                  ← REQUIRED for tools/call, resources/read, prompts/get

{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"woo__list_orders","arguments":{"date":"today"},
  "_meta":{
    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
    "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.x"},
    "io.modelcontextprotocol/clientCapabilities":{}}}}
```

Key rules:
- **Every request is self-describing**: version, client info and capabilities in `params._meta`. Any replica can serve
  any request, so plain round-robin load balancing works.
- **Header/body validation:** a server that reads the body MUST reject mismatched or missing mirrored headers with `400` +
  `-32020`. Intermediaries routing on headers SHOULD reject versions that don't require validation.
- **Status codes:** unsupported version → `400` + `-32022` (with `supported` list); unknown method → **`404` + `-32601`**.
- **`server/discover`** (servers MUST implement): returns `supportedVersions`, capabilities, server info.
- **Results** carry `resultType: "complete"`; list results carry **`ttlMs`** (freshness) and **`cacheScope`**
  (`public` | `private`, i.e. whether shared intermediaries may cache it).
- **Cancellation on HTTP = closing the SSE response stream.** No `notifications/cancelled` message. Servers MUST treat a
  closed stream as cancellation and stop work.
- **Change notifications:** client POSTs `subscriptions/listen` with a filter (`toolsListChanged: true` …). The response is
  a long-lived SSE stream: first `notifications/subscriptions/acknowledged`, then e.g. `notifications/tools/list_changed`,
  all tagged `_meta["io.modelcontextprotocol/subscriptionId"]` (= the listen request's id). Graceful server close = a final
  JSON-RPC result on that id; abrupt close = client may reconnect. Servers are encouraged to send SSE **comment keep-alives**
  (`:\r\n`) and `X-Accel-Buffering: no`.
- **MRTR (multi round-trip requests):** instead of the server sending an elicitation request, it returns
  `resultType: "input_required"` with `inputRequests` (+ opaque `requestState`); the client retries the *original* request
  (new id) with `inputResponses` and `requestState`. A gateway routes the retry like any call (by tool name).
- **Custom headers from tool params:** `x-mcp-header` in a property schema makes clients mirror that argument into an
  `Mcp-Param-{Name}` header (Base64 sentinel `=?base64?…?=` for unsafe values). Servers must validate them against the body.
- Deprecated: sampling, roots, logging, HTTP+SSE transport, DCR (in favour of Client ID Metadata Documents).

### 1.6 Era detection and the compatibility matrix

Terminology: **modern** = 2026-07-28+, **legacy** = initialize-based, **dual-era** = both.

- **A dual-era client on HTTP** sends a modern request first. If it gets `400` with a *recognised modern error body*, the
  server is modern (retry with a supported version). Any other `4xx` (empty body, non-modern error) means legacy, so fall
  back to `initialize`. The verdict is cached **per origin**. The TS SDK does this with `versionNegotiation: { mode: 'auto' }`,
  probing via `server/discover`.
- **Matrix:** modern↔modern ✓; dual↔legacy ✓ (fallback); legacy client↔dual server ✓; **legacy client↔modern-only
  server ✗** (no fall-forward); **modern-only client↔legacy server ✗**.
- **Observed in the wild (our probes):** half of public servers are legacy-only, each signalling it differently (400
  "unsupported version", -32601, -32602, "Mcp-Session-Id required"). Claude Code now negotiates modern by default.

→ **In our system:** the gateway must be **dual-era on both sides**: serve modern *and* legacy clients, and talk to modern
*and* legacy upstreams, translating between them. That works naturally with a *terminating* design (§2.2).

### 1.7 SSE (Server-Sent Events) in 60 seconds

A `text/event-stream` response is a long HTTP response made of events separated by blank lines:

```
event: message
id: 42
data: {"jsonrpc":"2.0","method":"notifications/progress",...}

: this line is a comment (keep-alive), ignored by clients

data: {"jsonrpc":"2.0","id":2,"result":{...}}

```

Fields: `data:` (payload), `event:` (type), `id:` (cursor, legacy resumability), `retry:` (reconnect delay ms). Proxies may
**buffer** streaming responses (hence `X-Accel-Buffering: no`) or **cut idle connections**. Cloudflare *quick* tunnels
don't support SSE at all. **Claude Code's listen-stream retry budget is finite**: if a stream that lived over 10 s
closes, it retries up to 5 times per hour, then waits about 6 hours. Periodic keep-alives matter.

### 1.8 Authorisation in MCP

- Authorisation is **optional**. Static bearer API keys are spec-legal (that's what our gateway uses for clients).
- When used, MCP follows OAuth 2.1 with the MCP server as **resource server**: `401` + `WWW-Authenticate: Bearer
  resource_metadata="…/.well-known/oauth-protected-resource"` → client fetches Protected Resource Metadata (RFC 9728) →
  finds the authorisation server → registers (Client ID Metadata Document preferred; DCR deprecated; or pre-registered) →
  PKCE + `resource` parameter (RFC 8707) → audience-bound token. Insufficient scope → `403 insufficient_scope` with
  `scope=` (step-up).
- **Hard rules:** servers MUST validate the token audience; **MUST NOT accept or transit any other tokens** (no token
  passthrough). Tokens never go in query strings.
- **Client behaviour to know:** a bare `401` can make a client start OAuth discovery. With a static key configured via
  headers, the client should simply fail (Claude Code re-runs a `headersHelper` on 401/403 when one is configured). The TS SDK's
  `requireBearerAuth` **rejects tokens without `expiresAt`**, so give API keys an expiry or populate a far-future one.

### 1.9 Change propagation end to end

Legacy client: listens on the session's `GET` stream. Modern client: `subscriptions/listen`. The SDK v2 HTTP handler
(`createMcpHandler`) is **stateless for legacy clients by default**: legacy `GET`/`DELETE` → `405`, so legacy clients get
no push and see changes on their next `tools/list`. Modern listen streams are fed by `handler.notify.toolsChanged()`
through an in-process **`ServerEventBus`**; multiple replicas need a shared bus (e.g. Redis pub/sub). The notification
carries no data, so broadcasting it to all users leaks nothing; each client re-lists and gets its own filtered list.

→ **In our system (D-8):** when an admin disables a server: (1) the catalog changes, (2) the gateway calls
`notify.toolsChanged()`, (3) Claude Code re-lists, (4) calls to the disabled tools are rejected regardless of what the
client cached.

---

## 2. How an MCP gateway works

### 2.1 Data plane, control plane, credential broker

- **Data plane:** the hot path every MCP request takes (auth → policy → route → upstream → audit).
- **Control plane:** admin APIs and UI that change configuration (registry, members, keys, permissions) and push those
  changes to the data plane.
- **Credential broker (IETF CB4A "Model A"):** the agent *never possesses* upstream credentials. The gateway injects them on
  egress. Consequence: the broker becomes the highest-value target, so encrypt credentials at rest, restrict its network, and
  never echo secrets.

### 2.2 Two proxy styles (the most important architectural fork)

| | **Pass-through (L7 forwarding)** | **Terminating (application gateway)** |
|---|---|---|
| Examples | Envoy AI Gateway, Kuadrant (Envoy + ext_proc), agentgateway | MetaMCP, ContextForge, MCPHub, Docker gateway, ours |
| How | Inspects/rewrites headers or body, forwards the original request bytes | Is a full MCP server to clients and a full MCP client to upstreams; issues *new* upstream requests |
| Era translation | **No.** Kuadrant: "the gateway does not translate between protocols" (modern clients only see modern backends); agentgateway downgrades the client | **Yes, for free.** The upstream call is made in the upstream's era |
| Session handling | Must map/route client sessions to upstream sessions (Envoy encrypts a composite session ID) | Upstream sessions are private to the gateway |
| Streaming/MRTR/elicitation | Passes through naturally | Must be bridged explicitly (or not offered) |
| Policy granularity | Header/body-level | Anything (per-user catalogs, argument policies, result rewriting) |
| Latency | Lowest | One extra JSON parse/serialise hop (ms) |

→ **In our system:** Claude Code (modern) + mixed-era upstreams + per-user permissions + audit, so a **terminating** gateway
is the natural fit. Its known cost: we don't offer elicitation/sampling pass-through (and needn't).

### 2.3 Life of a `tools/call` through a terminating gateway

```
Claude Code ──HTTPS──► Ingress(Traefik) ──► gateway pod
  1. Host/Origin checks (DNS-rebinding defence), body size limit
  2. AuthN: Bearer key → prefix lookup → constant-time hash compare → user, role, key id   (401 if bad/revoked)
  3. Era classification (modern _meta+headers vs legacy initialize/session)
  4. Per-request server built for this caller: catalog filtered by enabled servers + user permissions
  5. Parse exposed name "woo__list_orders" → (upstream id, original name "list_orders")      (-32602 if unknown/hidden)
  6. Policy: role/tool allowed? argument conditions? rate limit?                            (403 / isError)
  7. Audit: open event {user, key, via, server, tool, args-shape, start}
  8. Upstream client for that server: cached era verdict, pooled HTTP, injected credential header,
     deadline (e.g. 10–15 s), AbortSignal tied to the client's connection (client disconnect = cancel)
  9. Upstream ──► WooCommerce MCP server ──REST──► WordPress/WooCommerce ──► MySQL
 10. Map result: upstream JSON-RPC error/timeout/5xx → isError with a clear reason; strip upstream headers; size cap
 11. Audit: close event {duration, outcome, error class}; metrics (OTel mcp.client/server.operation.duration)
 12. Respond JSON (or SSE if streaming progress)
```

### 2.4 Aggregation and naming

The gateway keeps a **catalog**: for each enabled upstream, its tool definitions (as fetched), the exposed name, and the
mapping back. Collision schemes (survey in 02 §5): prefix+separator (`slug__tool`, used by agentgateway and MetaMCP;
`slug-tool`, ContextForge), priority, manual overrides, reject. **Length budget:**
`len("mcp__") + len(clientServerName) + len("__") + len(exposed) ≤ 64` in Claude Code; e.g. client name `urumi` (5)
leaves 52 chars for `slug__tool`. Store `(upstream_id, original_name)` so renaming a server slug doesn't break history,
and never derive routing from `serverInfo.name` (spec: not unique).

### 2.5 Fan-out and failure semantics

- **Fan-out:** `tools/list` on a cold cache queries enabled upstreams *in parallel*, each under its own deadline; merge
  successful ones; skip and record failures (fail-open). Better: serve `tools/list` from a **catalog refreshed in the
  background** (health loop + `list_changed`), so listing never waits on upstreams at all.
- **Circuit breaker:** after N consecutive failures mark *open* (fail fast with "Unreachable"), probe periodically
  (*half-open*), close on success. ContextForge uses interval + timeout + `UNHEALTHY_THRESHOLD`.
- **Status machine for the dashboard:** `Disabled` (admin intent) / `Connected` / `Unreachable(reason)`, with reasons
  {dns, refused, tls, timeout, auth_401_403, http_5xx, protocol/era mismatch}.
- **Kubernetes-native signal (idea):** for in-cluster upstreams, an empty EndpointSlice (no ready pods) means instantly
  "Unreachable". It needs read RBAC on endpointslices.
- **Timeout layering:** per-attempt timeout < per-call deadline < client's own timeout (Claude Code's per-call limit is very
  long; Inspector/Cursor vary). Retries only for idempotent reads.

### 2.6 Upstream connection management

- One logical client per upstream, created from the registry entry (URL, credential, era verdict).
- **Prefer stateless upstream use**: modern upstreams are stateless by design. For legacy upstreams that issue sessions,
  reuse is tempting but **sharing one upstream session across different users can leak state** (ContextForge #4205). With
  shared static credentials, keep per-call or per-(user, upstream) sessions for stateful servers.
- Cache the era verdict (modern `DiscoverResult` or legacy) per upstream URL **and credential**; re-probe on failure;
  date legacy verdicts (TS SDK gateway guide).
- Keep-alive HTTP pools keyed by validated IP when an SSRF guard is used (rebind-safe pooling, mcp-gateway-registry).

### 2.7 Caching rules

- Cache upstream tool lists (they rarely change) and invalidate on admin edit, `list_changed`, or TTL (`ttlMs`).
- **Anything that varies by caller must be keyed by the caller's authorisation context** (Asana's cross-tenant leak was a
  cache bug). When re-exporting `ttlMs/cacheScope` to modern clients: take `min(ttlMs)` and `private` if any input is
  private or if the list is filtered per user (Kuadrant's rule). Since our lists are per-user filtered, **always `private`**.

### 2.8 Notifications through a gateway

Upstream changes (`list_changed` via listen/GET) → gateway refreshes that upstream's tools → rebuilds catalog →
`notify.toolsChanged()` to downstream listeners. Admin changes (enable/disable/edit/permission change) do the same.
Multi-replica: publish on a shared bus so the replica holding a client's listen stream hears it.

### 2.9 Identity and credentials

- **Inbound identities:** dashboard *session* (cookie) for humans in the browser; *API key* for MCP clients; a
  **delegated identity for the chat agent** (it acts as the logged-in user but holds neither a plaintext key, because keys are
  hashed, nor the user's password). Options: (a) the agent runs in the gateway process and calls the catalog/router with the
  session's principal; (b) the backend mints a short-lived, audience-bound token (`sub=user`, `act=chat-agent`, `aud=gateway`)
  and the agent connects to the gateway's MCP endpoint with it. RFC 8693's `act` claim is the standard way to say "X acting
  through Y".
- **Outbound credentials:** admin-configured static header/bearer per upstream (the brief's model). More advanced: per-user
  OAuth (ThinkWatch, LibreChat, mcp-gateway-registry 3LO), token exchange (ContextForge RFC 8693).
- **Identity propagation to upstreams** (optional, off by default in ContextForge): forward `X-Forwarded-User-*` or `_meta`,
  HMAC-signed. It is *not* credential passthrough.

### 2.10 Policy enforcement points (from simplest to state-of-the-art)

| Technique | Prior art | What it gives |
|---|---|---|
| Server enable/disable | everyone | D-8 |
| Role/tool allowlist, hidden from list and rejected on call | LiteLLM, Kong, ToolHive (`defaultToolVisibility: deny`), agentgateway CEL | S-2 |
| Argument-level conditions (JSON-Schema-like predicates, forbid-before-allow, fallback) | **Progent** (AgentDojo ASR 39.9% → 0%) | "members may set status=processing but not refunded" |
| Intent-typed calls (`call_tool_read/_write/_destructive` checked against annotations) | mcpproxy-go | blocks "read" intents reaching destructive tools |
| Quarantine new servers until approved; TOFU pinning of descriptions+schemas; block on change | mcpproxy-go, Trail of Bits mcp-context-protector, Gate22 diff view, Toolport | rug-pull defence |
| Hidden-character / injection content rules | ThinkWatch (Unicode tags U+E0000–E007F, bidi), Lasso | ASCII smuggling defence |
| Session taint / information-flow control | Open Edison (private/untrusted/write flags + ACL levels, "no write-down"), GitHub gh-aw-mcpg DIFC (integrity by author role, write-sinks), CaMeL | lethal-trifecta containment |
| Dual-LLM quarantine of untrusted results | Archestra (main agent never sees raw output; quarantine agent answers multiple-choice) | strong but lossy/slow |

### 2.11 Audit and observability

Event fields: id, time, user, key id (or session), **via** (Claude Code / chat agent / Inspector, from clientInfo or
token actor), server id + slug, original and exposed tool name, argument *shape* (or redacted args), outcome
(ok / tool_error / timeout / denied / unauth), error class, duration, upstream status, request/trace id. Docker logs only
argument shape by default because arguments can contain PII. OTel MCP semconv: span `tools/call {tool}`; metrics
`mcp.server.operation.duration` (downstream side) and `mcp.client.operation.duration` (per upstream); trace context in
`_meta.traceparent`. Tamper-evidence (hash-chained or signed audit rows) exists in Wirken and KYDE. Rejected calls (revoked key)
are audited with the key id recovered from the key prefix.

### 2.12 Scaling patterns

| Pattern | Used by | Notes |
|---|---|---|
| Stateless request path + shared event bus for listen streams | TS SDK v2 design, Microsoft gateway | simplest; modern clients |
| Sticky sessions (cookie/header affinity) | many | legacy sessions; simple but uneven |
| Shared session store + cross-worker forwarding (Redis Pub/Sub, ownership CAS) | ContextForge ADR-038 | complex |
| **Encrypted composite session ID** (all upstream session IDs sealed into the client's session ID; any replica decodes) | Envoy AI Gateway | stateless even with stateful upstreams; KDF cost (100k iterations → tens of ms; ~100 → 1–2 ms) |

### 2.13 Many tools

Measured ideas: put fewer schemas in context. **Input schemas are 60–80% of tool tokens** (Speakeasy). Patterns:
search → describe → execute meta-tools (Speakeasy, Gate22, Klavis: servers→categories→actions→schema; AWS AgentCore search
tool; WordPress MCP adapter's discover/get-info/execute), hybrid BM25+embeddings (Stacklok reports 94% vs 34% selection on
2,792 tools, vendor benchmark), code mode (Anthropic −98.7% tokens, Cloudflare, Bifrost). Pitfall: if the model
can't see what *exists*, it may never search, so give it a category overview. LiveMCPBench: retrieval errors ≈ 50% of
failures. Claude Code already defers MCP tools behind its own tool search; our dashboard agent does not.

---

## 3. Kubernetes for this project

### 3.1 Mental model

You declare desired state (YAML objects); controllers reconcile reality towards it. The kubelet on each node runs
**pods** (one or more containers sharing a network namespace and volumes). Pods are cattle: they die and are replaced
with new IPs, so you never address pods directly. You use **Services**.

### 3.2 Workload objects

| Object | Use | Ours |
|---|---|---|
| Deployment | Stateless replicas, rolling updates | gateway, dashboard, MCP servers, WordPress (immutable image + uploads PVC) |
| StatefulSet | Stable names (`mysql-0`), per-replica PVCs via `volumeClaimTemplates`, ordered start | MySQL/MariaDB |
| Job | Run-to-completion | store bootstrap (install WP, activate Woo, settings, API key) |
| CronJob | Scheduled Job | `wp-cron` trigger when `DISABLE_WP_CRON` |

### 3.3 Networking

- Every pod gets an IP; **Service** (type ClusterIP) gives a stable virtual IP + DNS name
  `<svc>.<ns>.svc.cluster.local` load-balancing to **ready** pods (EndpointSlices). Headless Service (`clusterIP: None`)
  gives per-pod DNS (StatefulSets).
- **Ingress** objects declare HTTP routing (host/path → Service). An **Ingress controller** (Traefik in k3s/k3d) implements
  them. Only what has an Ingress (or NodePort/LoadBalancer) is reachable from outside.
- **Readiness gates traffic:** a pod that fails readiness is removed from the Service's ready endpoints. With zero ready
  endpoints, connections fail fast. That's what makes a killed upstream detectable (D-9).

### 3.4 NetworkPolicy semantics (where "internal-only" is *enforced*)

- Default: all pods can talk to all pods.
- A NetworkPolicy *selects* pods. Once a pod is selected for a direction (Ingress/Egress), **only explicitly allowed traffic
  is permitted** in that direction. Policies are additive (union of allows), never "deny" rules.
- Peers are chosen with `podSelector`, `namespaceSelector` (by labels; `kubernetes.io/metadata.name` exists on every
  namespace), or `ipBlock`.
- **Enforcement is done by the CNI.** k3s/k3d enforce via the embedded kube-router; kind's kindnet enforces since v0.24;
  Minikube's default doesn't. Unenforced policies are silently ignored.
- **Default-deny egress breaks DNS** unless you allow UDP/TCP 53 to kube-dns (`kube-system`, `k8s-app: kube-dns`).

```yaml
# Only gateway pods may reach the WooCommerce MCP server (M-WM-4)
kind: NetworkPolicy
spec:
  podSelector: {matchLabels: {app.kubernetes.io/name: woo-mcp}}
  policyTypes: [Ingress]
  ingress:
  - from: [{podSelector: {matchLabels: {app.kubernetes.io/name: gateway}}}]
    ports: [{port: 8080}]
```

"Public vs internal" story: *Ingress presence* decides internet exposure; *NetworkPolicy* decides which in-cluster pods
may talk; *app-level auth* (shared secret between gateway and MCP server) is defence in depth.

### 3.5 Storage

PersistentVolumeClaim (request) → bound to a PersistentVolume (actual storage) provisioned by a StorageClass (k3s:
`local-path`, node-local, **ReadWriteOnce**, `reclaimPolicy: Delete`). Put MySQL data and `wp-content/uploads` on PVCs.
RWO means a single node can mount it: fine on one node; multi-replica WordPress needs RWX or immutable code + object storage.

### 3.6 Config and Secrets

ConfigMap = non-secret config; **Secret = base64, not encryption.** Protection comes from RBAC + etcd encryption at rest
(k3s `--secrets-encryption`, aescbc/secretbox; KMS v2 is the production answer). Consume as env vars or **files**
(prefer files; the official WordPress image supports `*_FILE` env vars). Helm patterns: generate with `randAlphaNum` on first
install and **reuse via `lookup`** on upgrade (`lookup` returns empty during `helm template` and client-side `--dry-run`;
use `--dry-run=server`), or reference an `existingSecret` created out-of-band (prod). Never commit secrets in values files.

### 3.7 Probes

| Probe | Question | Failure effect | Pitfall |
|---|---|---|---|
| startup | "has it finished booting?" | other probes paused until success | use for slow first boot (WordPress copying files, MySQL init) |
| readiness | "should it receive traffic now?" | removed from Service endpoints | may check critical deps |
| liveness | "is it wedged?" | container restarted | **don't check dependencies** (cascading restarts) |

Probe types: `httpGet`, `tcpSocket`, `exec` (e.g. `mysqladmin ping`), `grpc`.

### 3.8 Resources

`requests` = what the scheduler reserves; `limits` = hard ceiling. CPU over limit → **throttled**; memory over limit →
**OOMKilled** (exit 137). QoS: Guaranteed (requests = limits), Burstable, BestEffort. WordPress needs ≥256 MB PHP memory
limit (WooCommerce requirement), so its container limit should be comfortably above that.

### 3.9 Security context and Pod Security

`runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`,
`seccompProfile: RuntimeDefault`. Pod Security Standards: privileged / baseline / restricted (namespace labels). Caveat:
the official WordPress Apache image starts as root (binds :80, chowns); fully non-root needs a custom image on :8080.

### 3.10 RBAC

ServiceAccount → Role/ClusterRole (verbs on resources) → RoleBinding/ClusterRoleBinding. Set
`automountServiceAccountToken: false` on pods that don't call the API. Only components that touch the Kubernetes API
(EndpointSlice watching, S-5 hosted servers, bonus provisioning) need any role. Scope them to one namespace, minimal verbs,
and optionally a ValidatingAdmissionPolicy to pin names (prior-cycle trick).

### 3.11 Helm

- **Chart** = templates + `values.yaml`; `helm install -f values-local.yaml` layers overrides. One umbrella chart with
  sub-components (or subcharts) keeps "same charts, values only".
- **Hooks** (`helm.sh/hook: pre-install,pre-upgrade` + `hook-delete-policy`) run Jobs at lifecycle points. Hooks aren't
  part of the release's managed resources. Job pod templates are immutable, so name Jobs per revision or use hooks.
- **Upgrade/rollback:** `helm upgrade --install` converges; each upgrade is a numbered revision (`helm history`);
  `helm rollback <rel> <rev>` re-applies an old revision. It does **not** roll back data (DB schema migrations from a newer
  WooCommerce stay applied), so back up before upgrades. Helm 4: `--atomic` → **`--rollback-on-failure`**, server-side apply
  default for new releases, kstatus-based waiting; Helm 3 bug fixes ended 2026-09-09.
- `helm test` runs test Pods (could run the MCP smoke test).

### 3.12 Local clusters

| | k3d (k3s in Docker) | kind | Minikube |
|---|---|---|---|
| Parity with VPS k3s | **Same distro** | different | different |
| Ingress | Traefik bundled | install yourself | addon |
| NetworkPolicy | enforced (kube-router) | enforced (kindnet ≥ v0.24) | not by default |
| Storage | local-path | local-path (rancher) | hostpath |
| Host ports | `-p "80:80@loadbalancer"` | extraPortMappings | tunnel/NodePort |

Local DNS: `*.localhost` (browsers resolve to loopback; non-browser tools may not), `nip.io`/`sslip.io`
(`store.127.0.0.1.nip.io` or `store.127-0-0-1.sslip.io`; some routers block DNS answers pointing to private IPs, a
DNS-rebinding protection), or the hosts file (admin rights on Windows).

### 3.13 Production-like VPS

k3s single node (`curl -sfL https://get.k3s.io | sh -` with `--secrets-encryption`), Traefik bundled, cert-manager
HTTP-01 via Traefik for TLS. **DNS:** a real domain (student pack: Name.com / Namecheap `.me` / `.TECH`, 1 year free) or
**DuckDNS** (free; on the Public Suffix List so Let's Encrypt limits are per subdomain). `sslip.io`/`nip.io` are *not* on
the PSL (shared LE rate limits, so cert issuance may fail). Firewall: 80/443 only (and SSH). Values differ: hostnames,
TLS, storageClass, resources, replica counts, secret sources.

---

## 4. WordPress and WooCommerce internals

### 4.1 Request flow
HTTP → Apache/PHP-FPM → `index.php` → WordPress bootstrap (`wp-config.php`, plugins, theme) → either a **template**
(storefront page) or the **REST API** (`/wp-json/...`, or `?rest_route=` without pretty permalinks). `WP_HOME`/`WP_SITEURL`
(public URL) drive links and redirects; behind a TLS proxy WordPress learns HTTPS from `X-Forwarded-Proto` (the official
image adds that code).

### 4.2 Data model
Products = `wp_posts` (post_type `product`) + `wp_postmeta` + lookup tables. Orders with **HPOS** (default for new stores)
live in `wp_wc_orders`, `wp_wc_order_addresses`, `wp_wc_order_operational_data`, `wp_wc_orders_meta`. Use the REST API rather
than SQL: it encapsulates HPOS/legacy storage, hooks, stock, emails.

### 4.3 REST API essentials
- Namespaces: **`wc/v3`** (admin CRUD; our target), `wc/v4` (newer, coexists), `wc/store/v1` (public cart/checkout Store API).
- **Auth modes:**
  1. Cookie + nonce (browser).
  2. Consumer key/secret via **HTTP Basic, only when `is_ssl()`**.
  3. **OAuth 1.0a one-legged over plain HTTP**: HMAC-SHA1/256, timestamp + nonce (nonces saved on the key row), **signature
     base string built from `get_home_url()`, the public URL**.
  4. WordPress **Application Passwords**, available when `is_ssl() || WP_ENVIRONMENT_TYPE==='local'` (filterable).
- **Key storage:** `consumer_key` stored as `HMAC-SHA256(key, 'wc-api')`; **`consumer_secret` stored in plaintext**, because
  HMAC verification needs it. (Contrast: our bearer API keys can be stored hashed precisely because we never verify a
  signature with them.) Key permissions: read / write / read_write, bound to a WP user's capabilities.
- Pagination: `page`, `per_page` (max 100), headers `X-WP-Total`, `X-WP-TotalPages`.
- **Dates:** `date_created` (site timezone) vs `date_created_gmt`; filters `after`/`before` (ISO 8601), `dates_are_gmt`.
  "Today" must be computed in the store's timezone.
- No idempotency keys: a retried POST can create duplicates. A unique SKU makes product creation naturally idempotent.

### 4.4 Store setup gotchas (bootstrap checklist material)
- **"Coming soon" mode is ON for fresh installs (WooCommerce ≥ 9.6)**: `woocommerce_coming_soon=yes`,
  `woocommerce_store_pages_only=yes` hide store pages from visitors. Set `woocommerce_coming_soon=no`.
- **COD disabled by default**: enable the `cod` gateway.
- Block-based Cart/Checkout pages are default; COD works with them.
- Store pages (shop/cart/checkout/my-account) must exist; set currency, timezone, base location; skip the onboarding wizard.
- Permalinks "post name" for `/wp-json/` and pretty URLs.
- Requirements: PHP 8.3+ (tested 8.4), MySQL 8.0+/MariaDB 10.6+, WP memory limit ≥ 256 MB. Current: WP 7.1.3, WooCommerce
  11.2.0.
- WP-CLI: Alpine CLI image runs as uid 82, Debian WordPress as uid 33, so run with `--user 33:33` on shared volumes.
  `wp user application-password create` and `wp wc ... --user=<id>` commands exist.

### 4.5 Background work
WP-Cron runs on page loads (unreliable). WooCommerce's **Action Scheduler** (emails, webhooks, analytics) depends on it.
Production: `DISABLE_WP_CRON=true` + a CronJob hitting `wp-cron.php` (or `wp cron event run --due-now`).

### 4.6 WooCommerce's own MCP (why it's off limits but instructive)
Core MCP (dev preview since 10.3): client → `mcp-wordpress-remote` → **MCP Adapter** (`/wp-json/mcp/mcp-adapter-default-server`)
→ **Abilities API** → WooCommerce abilities; feature flag `mcp_integration`; auth via Application Passwords for a scoped user.
Canonical abilities are **business operations, not REST wrappers**: `products-query`, `product-create/update/delete`,
`orders-query`, `order-update-status`, `order-add-note`; strict schemas with Woo enums; line items off by default; soft delete
by default; readonly/idempotent annotations. We must write our own server (M-WM-1); copying the *design ideas* is fine.

### 4.7 Immutable images
Bake WordPress + WooCommerce + our config/mu-plugins into an image (`/usr/src/wordpress` static recipe), run read-only with
writable `/tmp`, `/run`, `wp-content/uploads`; `DISALLOW_FILE_MODS=true`. Urumi runs "read-only immutable images". Upgrades
become image changes (Helm upgrade); rollback restores code, not DB.

---

## 5. LLM agents and the tool loop

### 5.1 Function calling
The app sends the conversation + tool declarations (name, description, JSON-schema params). The model replies with text
and/or one or more **tool calls** (`id`, `name`, `arguments`). The app executes them and appends **tool result** messages
(matching ids), then calls the model again. Parallel tool calls = several calls in one turn.

### 5.2 The loop
```
messages = [system, ...history, user]
for step in 1..MAX_STEPS:                       # e.g. 8
    reply = llm(messages, tools=catalog_for(user))
    stream reply text to UI
    if no tool calls: break
    for call in reply.tool_calls:               # show "calling woo__list_orders {…}" in UI
        result = gateway.call(call.name, call.args, as_user=user)   # audited as user (via chat)
        messages += tool_result(call.id, truncate(result))
```
Stop conditions: no tool calls, max steps, user abort (close stream → cancel upstream), budget exceeded. Errors from tools go
back to the model as results (it can retry or explain).

### 5.3 MCP → LLM tool conversion
- Names: already `[A-Za-z0-9_-]` if the gateway's scheme is LLM-safe.
- **Schema sanitisation:** Gemini accepts an OpenAPI-subset; older models reject `additionalProperties`, `$schema`,
  `propertyNames`, etc. Strip unknown keywords and resolve `$ref` before sending. Newer Gemini models accept more, so verify (E8).
- Descriptions: cap length (a malicious upstream can send novels); results: convert `content` blocks to text, keep
  `structuredContent` as JSON, truncate (Claude Code caps MCP output at 25k tokens by default).

### 5.4 Acting as the logged-in user (M-CA-2)
The agent's tool calls must carry the *user's* identity into the same authorisation + audit path that external clients use
("nothing else talks to upstreams directly"). Mark them `via: chat-agent` so the audit shows "Alice via chat" vs "Bob via
Claude Code". See §2.9 for the two ways.

### 5.5 Context hygiene
Tool results are **untrusted data**. Put them in tool-result messages (never the system prompt), optionally *spotlight*
(delimit/mark) them, keep them short (concise mode; line items off), and never put secrets in model context.

### 5.6 Free model options (verify limits at build time)
Gemini free tier (2.5/3.x Flash models; data may be used to improve Google products), Groq free (gpt-oss-120b/20b,
qwen3.8-27b; **8K TPM**, tight), NVIDIA API catalogue (~40 RPM), OpenRouter `:free` (~50
req/day). Claude: ~$5 starter credit; student credits are application-based. GitHub Models was retired on 2026-07-30 and
Gemini no longer publishes free limits (see 05 §2.7).

### 5.7 Evaluating the agent
Golden prompts = the DoD steps ("create product X at Y", "what orders came in today?", the cross-server prompt). Check
the *tool trajectory* (right tools, right args) more than prose; graders care that the loop works.

---

## 6. Security concepts

### 6.1 Threat modelling method
List **assets** (upstream credentials, API keys, customer PII in orders, store integrity, LLM key), **actors** (admin,
member, external attacker, malicious upstream, malicious customer/product text), **trust boundaries** (internet↔Ingress,
gateway↔upstream, gateway↔LLM provider, member↔member, pod↔pod), **data flows**; then walk STRIDE (Spoofing, Tampering,
Repudiation, Information disclosure, DoS, Elevation of privilege) per boundary.

### 6.2 Attack classes
| Attack | One-line definition | Primary defence (layer) |
|---|---|---|
| Direct prompt injection | user tells the model to misbehave | authZ outside the model (gateway) |
| **Indirect prompt injection** | instructions hidden in *data* the model reads (product names, order notes, web pages) | treat results as data; least privilege; IFC/taint; HITL for writes |
| **Tool poisoning / line jumping** | malicious instructions in tool *descriptions/schemas*, active at list time before any call | review/pin definitions; length caps; content rules |
| **Rug pull** | definitions change after approval | TOFU hashing + re-approval |
| **Shadowing** | one server's text manipulates calls to another server | namespacing; per-server trust; quarantine |
| Confused deputy | a privileged intermediary is tricked into acting for the wrong party | per-client consent; audience-bound tokens; no passthrough |
| Token passthrough | forwarding client tokens upstream | forbidden by spec; gateway-issued tokens only |
| SSRF | attacker-supplied URL makes the server fetch internal targets (metadata 169.254.169.254, cluster services) | allowlist; block private ranges at *dial time*; validate redirects; egress NetworkPolicy |
| DNS rebinding | a domain re-resolves to an internal/loopback IP | Host/Origin validation; IP pinning |
| Cross-tenant cache leak | shared cache serves A's data to B | key caches by auth context (Asana) |
| Shared upstream session leak | stateful upstream session reused across users | per-user/per-call sessions (ContextForge #4205) |
| ASCII smuggling | invisible Unicode tag characters carry instructions | strip/flag U+E0000–E007F, bidi controls |
| ANSI escape injection | terminal control codes hide content in CLI clients | replace ESC (Trail of Bits) |
| Supply chain | trusted package turns malicious (postmark-mcp BCC) | pin images/versions; review updates |

### 6.3 Defence patterns
Least privilege (scoped WooCommerce user/key; per-role tools); **defence in depth with explicit placement** (MCP-DPT's six
layers: model, host/app, client/SDK, server, transport, registry; each attack gets a primary and a secondary layer);
**information-flow control** (taint/labels: CaMeL, Open Edison, GitHub DIFC); **policy engines** with argument predicates
(Progent); **quarantine/TOFU**; **human-in-the-loop** for destructive actions; **egress control** (who can the gateway reach);
**audit** for repudiation.

### 6.4 The lethal trifecta applied to us
Private data (orders/customers) + untrusted content (member-written products, customer checkout fields, third-party tool
text) + external communication (any upstream that can send data out, including writing to a public storefront). Remove one
leg per flow where possible, e.g. a member's agent session that has read customer PII can't call an exfiltrating tool
afterwards (taint), or such tools are admin-only.

---

## 7. Glossary

**AuthInfo**: SDK object carrying the verified caller into handlers. **CB4A**: IETF "Credential Broker for Agents" draft
(Model A = proxy injects creds). **CIMD**: OAuth Client ID Metadata Document (client_id is an HTTPS URL). **DCR**:
Dynamic Client Registration (deprecated for MCP). **DIFC/IFC**: (decentralised) information-flow control. **Era**:
legacy (initialize-based) vs modern (2026-07-28). **EndpointSlice**: list of a Service's backend pod IPs + readiness.
**HPOS**: WooCommerce High-Performance Order Storage. **Line jumping**: tool-description injection effective before any
call. **MRTR**: multi round-trip requests (`input_required` results). **PRM**: Protected Resource Metadata (RFC 9728).
**PSL**: Public Suffix List. **RFC 8707**: resource indicators (token audience). **RFC 8693**: token exchange (`act`
claim). **SSA**: Kubernetes server-side apply. **TOFU**: trust on first use. **ttlMs/cacheScope**: 2026-07-28 list
caching hints.
