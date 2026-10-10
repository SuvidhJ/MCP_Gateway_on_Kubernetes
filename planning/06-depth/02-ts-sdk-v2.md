# 06·02 — MCP TypeScript SDK v2, From the Source

Written 2026-10-09 from a clone of `modelcontextprotocol/typescript-sdk` at commit `b022522` (2026-10-05) plus its
`docs/`. Package versions on npm today: `@modelcontextprotocol/server` **2.3.1**, `/client` **2.3.1**, `/core` 2.3.1,
`/node` **2.1.1**, `/express` 2.0.2, `/hono` 2.0.2 (all ESM-only, Node ≥ 20). The v1 line (`@modelcontextprotocol/sdk`)
is at 1.32.1. Source paths below are relative to `packages/`.

Purpose: know exactly what the SDK does for us, what it leaves to us, and where it bites, before choosing it.

---

## 1. Package map

| Package | What's in it | We'd use it for |
|---|---|---|
| `@modelcontextprotocol/server` | `createMcpHandler`, `McpServer`, low-level `Server`, `fromJsonSchema`, `requireBearerAuth` (web-standard), host/origin validators, `InMemoryServerEventBus`, `isLegacyRequest` | gateway's downstream face; WooCommerce MCP server; in-cluster upstream |
| `@modelcontextprotocol/client` | `Client`, `StreamableHTTPClientTransport`, `SSEClientTransport`, `createMiddleware`/`applyMiddlewares`, `withLogging`, OAuth helpers | gateway's upstream connections; chat agent's connection to the gateway |
| `@modelcontextprotocol/node` | `toNodeHandler`, `toWebRequest`, `localhostHostValidation/OriginValidation`, sessionful `NodeStreamableHTTPServerTransport` | mounting under Node HTTP/Express/Fastify |
| `@modelcontextprotocol/express` / `hono` / `fastify` | `createMcpExpressApp` (json parser + DNS-rebinding guards), `requireBearerAuth` middleware | optional |
| `@modelcontextprotocol/server-legacy` | frozen v1 `SSEServerTransport`, OAuth AS helpers | not needed |
| `core-internal` (private) | protocol engine, wire codecs per era, classification ladder, Mcp-Param codec | read-only reference |

Validation runtime: Zod v4 for SDK schemas; **AJV** on Node for JSON Schema (tool output validation, `fromJsonSchema`),
`@cfworker/json-schema` on browsers/workers. Two Zod copies in a tree → `TS2589` (pin one `zod@^4` via `overrides`).

---

## 2. Serving: what `createMcpHandler` does, step by step

`createMcpHandler(factory, options)` → `{ fetch, close, notify, bus }`. `fetch` is a web-standard
`(Request, {authInfo?, parsedBody?}) => Promise<Response>`; on Node wrap once with `toNodeHandler(handler)`.

Order of operations for a POST (from `server/src/server/createMcpHandler.ts`):

1. `Content-Type` must be `application/json`, else **415** (`-32000`).
2. Body read once, capped by `maxRequestBodySize` (default **4 MiB**) → **413**. Unreadable → 400/-32700.
3. **Classification** (`core-internal/src/shared/inboundClassification.ts`), **body-primary**:
   - `params._meta["io.modelcontextprotocol/protocolVersion"]` present → **modern**, else **legacy**;
   - `initialize` without a modern claim → legacy; non-POST (GET/DELETE) → legacy session op;
   - the `MCP-Protocol-Version` header never changes the era, it's only cross-checked (mismatch → 400/-32020);
   - a header that names a modern revision with no body claim → 400/-32602.
4. **Modern leg** ("ladder"):
   1. Claimed revision not served → 400/-32022 with `supported` + `requested`.
   2. Standard-header rung: `MCP-Protocol-Version`/`Mcp-Method` presence and `Mcp-Name` cross-check → 400/-32020.
   3. Capability gate: a method that structurally needs an undeclared client capability → 400/-32021, before the
      factory runs.
   4. `factory({era:'modern', authInfo, requestInfo})` builds a fresh `McpServer`/`Server`.
   5. `subscriptions/listen` is handled by the **listen router**. The factory instance is used only to read its
      capabilities (to compute the honoured filter) and is closed immediately. So **your factory does see listen
      requests** (your authorization code runs), but listen streams are not per-instance.
   6. `Mcp-Param-*` validation, **only when the factory returns an `McpServer`** (it needs the tool registry). A
      low-level `Server` gets **no** Mcp-Param validation.
   7. Scope-challenge preflight (only if the instance registers per-primitive scope challenges).
   8. Dispatch → response is JSON, or SSE if the handler emitted related messages first (`responseMode: 'auto'`;
      `'json'` drops mid-call notifications; `'sse'` always streams).
   9. Client disconnect before a response → **499**, no body. Handler crash → 500/-32603.
5. **Legacy leg** (default `legacy: 'stateless'`): per request, a fresh instance plus a v1-style
   `WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined})`.
   - GET/DELETE → **405** `Method not allowed.`
   - Request-bearing POSTs are answered **over SSE** (one `event: message`).
   - Torn down when the response completes or the client goes away (`request.signal`).
   - `legacy: 'reject'` makes the endpoint modern-only: `initialize` gets 400/-32022; legacy notifications get 202 and
     are dropped.

Options and defaults (verbatim names): `legacy` (`'stateless'`), `responseMode` (`'auto'`), `bus`
(`InMemoryServerEventBus`), `maxSubscriptions` (**1024**, extra listens get in-band -32603 "Subscription limit
reached"), `keepAliveMs` (**15000**, SSE comment frames `: keepalive`; 0 disables), `maxRequestBodySize` (4 MiB),
`onerror` (reporting only).

`close()` aborts in-flight modern exchanges and calls `listenRouter.closeAll()`, which sends each listen stream the
**graceful `subscriptions/listen` result** (`resultType:"complete"`, `_meta.subscriptionId`) before closing. (It doesn't send
`notifications/cancelled`. See 06·01 §14 for the spec inconsistency.)

### 2.1 What the handler deliberately does NOT do (we must)

From `docs/serving/http.md`: "**The handler trusts its caller: it validates no `Host` header, no `Origin` header, and no
token.**" (Open issue #2844 is about exactly this when mounting bare.)
- **Host/Origin:** `hostHeaderValidationResponse(req, allowedHostnames)` and `originValidationResponse(req, allowedOrigins)`
  are exported from `@modelcontextprotocol/server`.
  - Origin rule: an absent Origin passes (non-browser MCP clients don't send one); an unparseable or `null` Origin is
    rejected with 403/-32000.
  - `createMcpExpressApp()` arms both on localhost binds only. With `host:'0.0.0.0'` you must pass `allowedHosts`.
- **Auth:** `authInfo` is pass-through. You verify the key in front and call `handler.fetch(req, {authInfo})`. The factory
  reads `ctx.authInfo`; handlers read `ctx.http.authInfo`.
- `requireBearerAuth` (SDK) **rejects tokens whose `AuthInfo.expiresAt` is unset** ("Token has no expiration time") and
  emits `WWW-Authenticate` with `resource_metadata` when configured. For our static API keys, write our own gate. We
  want a custom 401 message, no `resource_metadata`, and no expiry requirement (or set a far-future `expiresAt`).

### 2.2 The factory runs per request: consequences

- "Keep the factory cheap and side-effect-free: create connection pools and caches once at module scope and close over
  them." Upstream clients, the catalog and the DB pool live at module scope. The factory only builds a `Server` that
  closes over the caller's identity.
- Per-request instances mean **per-user tool lists are natural**. `tools/list` is computed from the catalog filtered by
  `authInfo` on every request.
- Memory-leak history (#2607, fixed 2026-09-28: a *reused* instance grew an `onclose` chain). Always return a fresh
  instance.

### 2.3 Low-level `Server` (the right layer for a gateway)

```ts
import { Server, createMcpHandler } from '@modelcontextprotocol/server';

const handler = createMcpHandler(({ authInfo }) => {
  const principal = toPrincipal(authInfo);                       // our key → user/role
  const s = new Server({ name: 'urumi-gateway', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } },            // MUST declare; never inferred
      cacheHints: { 'tools/list': { ttlMs: 30_000, cacheScope: 'private' } } });
  s.setRequestHandler('tools/list', async () => ({ tools: catalog.visibleTo(principal) }));
  s.setRequestHandler('tools/call', async (req, ctx) => router.call(principal, req.params, {
    signal: ctx.mcpReq.signal,                  // aborts on client disconnect / cancel
    clientInfo: ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo'],  // display only
    traceparent: ctx.mcpReq._meta?.traceparent,
  }));
  return s;
}, { keepAliveMs: 15_000 });
```

Facts that shape this:
- `setRequestHandler(method, handler)` takes **method strings** in v2. Registering `tools/list` without declaring the
  `tools` capability **throws**. The low-level `Server` "refuses to send a notification its capabilities do not cover".
- "**A handler exception on `Server` reaches the client as a protocol error, not as an `isError: true` tool result**"
  (`-32603`). The gateway must catch everything in `tools/call` and return `isError` results itself (06·01 §3).
- The low-level `Server` does no argument validation and no Mcp-Param validation. `fromJsonSchema(schema)` gives an AJV
  validator if we want gateway-side checks.
- Handler context (`core-internal/src/shared/protocol.ts`, `BaseContext`/`ServerContext`):
  - `ctx.mcpReq` carries `id`, `method`, `_meta` (with the reserved envelope keys lifted out), `envelope` (clientInfo,
    clientCapabilities, protocolVersion), `signal`, `send`, `notify`, `inputResponses`, `requestState`;
  - `ctx.http` carries `authInfo` and `req` (the original `Request`).
- **Cache hints:**
  - On modern responses the 2026 codec **always fills** `ttlMs`/`cacheScope` for the six cacheable methods. Precedence is
    the handler's own fields, then `ServerOptions.cacheHints`, then the defaults `{ttlMs: 0, cacheScope: 'private'}`.
  - So an SDK-v2 server can't trigger Claude Code #88128 (missing hints → tools vanish).
  - Prefer `cacheHints` over returning the fields yourself. Hints are attached on a symbol-keyed property that only the
    2026 codec reads, so legacy responses stay byte-clean. The 2025 codec's encode is identity, so fields you return
    yourself would leak into legacy responses (harmless, but untidy).
- **Cross-era result projection is done for us** (`core-internal/src/wire/rev2025-11-25/codec.ts`). On legacy responses
  a non-object `outputSchema` root is wrapped as `{type:'object', properties:{result:<schema>}, required:['result']}`,
  and non-object `structuredContent` becomes `{result: <value>}` plus a text fallback. On legacy *decode*, a stray
  `resultType` is stripped.
- Era-gated methods: calling a spec method the negotiated era doesn't define throws
  `SdkError(METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION)` locally (e.g. `ping` on modern, `listen()` on legacy).

### 2.4 Notifications across the handler

- `handler.notify.toolsChanged()` publishes to the bus. Every open listen stream that asked for `toolsListChanged` gets
  `notifications/tools/list_changed` with its own `subscriptionId`. It's a no-op if none are open.
- In-process bus only reaches streams held by **this** process. With replicas > 1, implement `ServerEventBus`
  (`publish(event)`, `subscribe(listener)`) over Redis/Postgres `LISTEN/NOTIFY` and pass the same bus to every replica.
- Legacy clients (stateless) get **no push** at all. Open bug #2232: `sendToolListChanged` drops notifications on
  stateless legacy transports. They see changes on the next `tools/list`.

---

## 3. The client (our upstream connections)

### 3.1 Era negotiation (`client/src/client/versionNegotiation.ts`, `probeClassifier.ts`)

| `versionNegotiation.mode` | Behaviour |
|---|---|
| absent / `'legacy'` (**default**) | plain 2025 `initialize`, no probe |
| `'auto'` | probe with `server/discover`; fall back to `initialize` on a legacy verdict |
| `{ pin: '2026-07-28' }` | modern or fail (`SdkError(ERA_NEGOTIATION_FAILED)`) |

Probe classification is **conservative**:
- **Modern:** only a `DiscoverResult` (with an overlapping version), or `-32022` with a mutual version (one corrective
  retry).
- **Legacy:** `-32001`, `-32020` and `-32021` are deliberately *not* treated as modern evidence and fall to the legacy
  default (stricter than the spec's "any recognised modern error").
- **Typed errors, never an era verdict:**
  - 401 → `SdkHttpError(CLIENT_HTTP_AUTHENTICATION)`;
  - 403 → `CLIENT_HTTP_FORBIDDEN`, except a 403 with `insufficient_scope`, which enters step-up;
  - 5xx → `ERA_NEGOTIATION_FAILED` naming the status;
  - a 2xx "unusable reply" (non-JSON, bare 204) → `ERA_NEGOTIATION_FAILED`;
  - an HTTP timeout → `REQUEST_TIMEOUT`. (On stdio, silence means legacy; on HTTP, silence means an outage.)
- `probe: { timeoutMs, maxRetries }` (timeout defaults to the request timeout, retries 0).

Cached verdicts (the gateway recipe, `docs/advanced/gateway.md`):
- `connect(transport, { prior: { kind: 'modern', discover } })` connects with zero round trips;
  `{ kind: 'legacy' }` skips the probe.
- "Freshness is your responsibility … a stale legacy verdict succeeds silently forever". Date legacy verdicts (e.g.
  24 h horizon) and re-probe after.
- "**Never share a persisted `DiscoverResult` across principals** — key the blob on the authorization context". For us
  that means keying by (upstream URL, credential hash).
- A modern-verdict client never auto-opens a listen stream; call `client.listen({toolsListChanged:true})` yourself.

### 3.2 Transport options (`client/src/client/streamableHttp.ts`)

- `requestInit.headers` is where the **static upstream credential** goes (e.g. `Authorization: Bearer …` or
  `X-API-Key`). Or use `authProvider: { token: async () => key }` for bearer.
- `fetch` is a custom fetch for SSRF-safe dialing, per-attempt timeouts, metrics and logging. Compose with
  `applyMiddlewares(...)`; the last middleware passed is outermost.
- `redirectPolicy` defaults to **`'same-origin'`** (cross-origin or method-changing redirects fail the request). Good
  against SSRF via redirect.
- `reconnectionOptions` default `{initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5, maxRetries: 2}`
  (applies to SSE stream resumption, legacy).
- **Per-request headers:** `callTool(params, { headers })` adds headers to that POST on **any era**. Reserved and
  skipped: `authorization`, `dpop`, `content-type`, `mcp-protocol-version`, `mcp-method`, `mcp-name`,
  `mcp-session-id`. `mcp-param-*` is **not** reserved, so this is the escape hatch for GitHub's legacy-era Mcp-Param
  requirement (#2639). We compute the headers ourselves; the SDK's codec is in private `core-internal`.
- Session id: captured only from the `initialize` response. A sessionless handshake clears any stale id.

### 3.3 Request options, timeouts, cancellation (`core-internal/src/shared/protocol.ts`)

- `DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`. Options: `timeout`, `signal`, `onprogress`, `resetTimeoutOnProgress`,
  `maxTotalTimeout`, `allowInputRequired`, `headers`.
- Timeout or abort → `cancel()`:
  - **Legacy:** sends `notifications/cancelled {requestId, reason}`. The underlying HTTP POST is **not aborted** by
    this.
  - **Modern:** aborts the request's stream, which is the spec cancel.

  Either way the promise rejects with `SdkError(REQUEST_TIMEOUT)` (or the abort reason).
- Open bugs that matter: #2695 `maxTotalTimeout` never enforced unless progress arrives; #2739 POSTs left pending when
  their SSE response ends or errors; #2247 invalid frames dropped so the client hangs.

→ us: **enforce deadlines below the SDK too.** Wrap the transport's `fetch` so every HTTP attempt carries
`AbortSignal.any([callerSignal, AbortSignal.timeout(deadline)])`. Then a hung legacy upstream frees its socket,
and the gateway answers `isError: "upstream X timed out after 10s"` regardless of SDK bugs.

### 3.4 `callTool` behaviour a proxy must know

- **Output-schema validation:** if a cached `tools/list` gave the client the tool's `outputSchema`, `callTool` validates
  `structuredContent` and **throws `ProtocolError(-32602)`** on mismatch. If `outputSchema` exists but
  `structuredContent` is missing (non-error), it **throws `ProtocolError(-32600)`**. A schema that won't compile throws
  before sending.
  - For a gateway this turns an upstream's sloppy output (WooCommerce #64195's dates and nulls) into a hard failure.
  - Options: catch these and convert to `isError`; or call `client.request({method:'tools/call', params})` directly
    (no output validation, but also no automatic Mcp-Param mirroring); or pass `toolDefinition` without
    `outputSchema`.
  - Whichever we pick, decide whether to **re-export** an upstream's `outputSchema` downstream, because Claude Code
    validates too.
- **Mcp-Param mirroring** happens only on modern connections, and only from the cached tool definition (or
  `options.toolDefinition`). On `-32020` it evicts the cache, re-lists, and retries once.
- **Pagination:** `listTools()` follows `nextCursor` and returns one aggregated list. `listMaxPages` defaults to 64;
  exceeding it throws `LIST_PAGINATION_EXCEEDED`.
- **Response cache:**
  - On by default. `ttlMs` is honoured, capped at **24 h**; `cacheMode: 'use' | 'refresh' | 'bypass'`.
  - `defaultCacheTtlMs` (0) applies to hint-less legacy servers.
  - `list_changed` evicts.
  - Use `cachePartition` if one store serves several principals.
- **listChanged option:** `listChanged: { tools: { onChanged(err, tools) } }`. On modern connections the SDK opens and
  manages the listen stream (`autoOpenedSubscription`). On legacy it relies on unsolicited notifications on the GET
  stream.
  - Open bug #2964: the auto-opened listen stream is **never reopened** after a server restart or stream drop.
  - `McpSubscription.closed` resolves `'local' | 'graceful' | 'remote'`, and "**The SDK never re-listens for you**".
    Re-listen on `'remote'` with backoff.
- **404 on a legacy session:** not handled (#1708, open). The POST throws
  `SdkHttpError(CLIENT_HTTP_NOT_IMPLEMENTED, status 404)`. The gateway must discard that `Client`, reconnect (new
  `initialize`), and retry the call once.
- On connect over legacy, the client also issues a **GET** to open the server→client stream. A stateless server answers
  405, which the client tolerates (seen in `withLogging` output: POST 200, POST 202, GET 405, POST 200).

### 3.5 Error taxonomy (what the gateway catches)

| Class | When | Gateway mapping |
|---|---|---|
| `ProtocolError` (code = JSON-RPC code) | upstream JSON-RPC error (modern 400 bodies delivered in-band), output-schema failures | `-32602` from upstream "unknown tool" → refresh catalog; others → `isError` with sanitised message |
| `SdkHttpError` (`status`) | non-2xx HTTP: 401 (`CLIENT_HTTP_AUTHENTICATION`), 403 (`CLIENT_HTTP_FORBIDDEN`), 404 session, 5xx | 401/403 → status `auth_failed` (admin must fix credential); 404 → re-init+retry; 5xx → `isError` + health signal |
| `SdkError(REQUEST_TIMEOUT)` | deadline | `isError` "timed out after Ns"; circuit-breaker failure count |
| `SdkError(CONNECTION_CLOSED / SEND_FAILED)` | network | `isError` "unreachable"; health signal |
| `SdkError(ERA_NEGOTIATION_FAILED)` | probe unusable/5xx/no overlap | status `protocol_error` with message |

Full `SdkErrorCode` list: NOT_CONNECTED, ALREADY_CONNECTED, NOT_INITIALIZED, CAPABILITY_NOT_SUPPORTED, REQUEST_TIMEOUT,
CONNECTION_CLOSED, SEND_FAILED, INVALID_RESULT, UNSUPPORTED_RESULT_TYPE, INPUT_REQUIRED_ROUNDS_EXCEEDED,
LIST_PAGINATION_EXCEEDED, METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION, ERA_NEGOTIATION_FAILED, CLIENT_HTTP_NOT_IMPLEMENTED,
CLIENT_HTTP_AUTHENTICATION, CLIENT_HTTP_FORBIDDEN, CLIENT_HTTP_UNEXPECTED_CONTENT, CLIENT_HTTP_FAILED_TO_OPEN_STREAM,
CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION.

---

## 4. Open SDK issues that touch our design (checked 2026-10-09)

| # | State | Issue | Our mitigation |
|---|---|---|---|
| 2844 | open | `createMcpHandler` is validation-free (Host/Origin/token) | own middleware in front (§2.1) |
| 2695 | open | `maxTotalTimeout` not enforced without progress | fetch-level `AbortSignal.timeout` |
| 2739 | open | client leaves POSTs pending when SSE ends/errors | fetch-level timeout + per-upstream concurrency cap |
| 2247 | open | invalid frames dropped → client hangs | fetch-level timeout |
| 1708 | open | no re-init on 404 session | catch 404 → reconnect → retry once |
| 2964 | open | auto-opened listen not reopened | manage `listen()` ourselves, re-listen on `'remote'` |
| 2639 | open | no supported Mcp-Param on legacy (GitHub) | per-request `headers` escape hatch, our own codec |
| 2677 / 2721 | open | Zod-derived schemas emitted as draft-07 | irrelevant for proxied JSON schemas; relevant for `McpServer`+Zod (our Woo server) → use `fromJsonSchema` or verify output |
| 2232 | open | list_changed dropped on stateless legacy transports | accept: legacy clients poll |
| 2868 | closed 09-29 | `listChanged` defaulted to true | — |
| 2607 | closed 09-28 | reused-instance leak | fresh instance per request |
| 2838 | closed 09-29 | Zod schemas re-converted per instance | — (fixed) |
| 2589 | closed 08-17 | modern POST without `MCP-Protocol-Version` accepted | — (fixed) |

---

## 5. Mapping SDK pieces onto the gateway (what we write vs what we get)

| Gateway function | SDK gives us | We write |
|---|---|---|
| Serve modern + legacy on one URL | `createMcpHandler` (classification, header ladder, version errors, listen router, keep-alives, 405s, legacy projection) | — |
| DNS-rebinding defence | `hostHeaderValidationResponse`, `originValidationResponse` | allow-lists from Helm values |
| API-key auth | `authInfo` pass-through | key parsing, hash lookup, revocation, 401 body |
| Per-user tool list | per-request factory + low-level `Server` | catalog filter by role/permissions; deterministic order; `cacheHints` |
| Call routing + policy | `ctx.mcpReq.signal`, `envelope` | name parsing, permission check at call time, argument policies, audit |
| Upstream connections | `Client` + transport, era probe, `prior` verdicts, listen, response cache | client pool per upstream, verdict cache with dates, credential injection, SSRF-safe fetch, deadlines, 404 re-init, re-listen, health/breaker |
| Errors to the model | `isError` result shape | mapping table §3.5; never leak upstream internals |
| Change push | `handler.notify.toolsChanged()`, `ServerEventBus` | publish on admin edits and upstream `list_changed`; a shared bus if replicas > 1 |
| Graceful shutdown | `handler.close()` (graceful listen results) | SIGTERM → stop readiness → drain → `close()` |

---

## 6. Things to verify in experiments (not answerable from source alone)

- E1: Claude Code (pinned version) against our `createMcpHandler` endpoint in both eras; listen push works through
  Traefik; `ttlMs: 30000` behaviour.
- E13: soak 20k requests through the per-request low-level `Server`; heap flat (post-#2607).
- E14: kill/restart an upstream with sessions → our 404 → re-init → retry path.
- E12: DeepWiki (legacy) through our upstream client; GitHub `/readonly` with our Mcp-Param escape hatch.

## Sources
- Source: [typescript-sdk @ b022522](https://github.com/modelcontextprotocol/typescript-sdk/tree/b022522089a0c8b632595c6e7b536453945ed5a9) —
  `packages/server/src/server/createMcpHandler.ts`, `listenRouter.ts`, `perRequestTransport.ts`, `middleware/*`;
  `packages/client/src/client/client.ts`, `streamableHttp.ts`, `probeClassifier.ts`, `versionNegotiation.ts`;
  `packages/core-internal/src/shared/protocol.ts`, `inboundClassification.ts`, `resultCacheHints.ts`;
  `packages/core-internal/src/wire/rev2025-11-25/codec.ts`; `packages/middleware/node/src/toNodeHandler.ts`
- Docs in the same repo: `docs/advanced/gateway.md`, `docs/advanced/low-level-server.md`, `docs/protocol-versions.md`,
  `docs/serving/{http,legacy-clients,sessions-state-scaling,authorization,express}.md`, `docs/clients/{connect,calling,caching,subscriptions,middleware}.md`,
  `docs/servers/notifications.md`, `docs/troubleshooting.md`
- Issues: [#2844](https://github.com/modelcontextprotocol/typescript-sdk/issues/2844), [#2695](https://github.com/modelcontextprotocol/typescript-sdk/issues/2695),
  [#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739), [#2247](https://github.com/modelcontextprotocol/typescript-sdk/issues/2247),
  [#1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708), [#2964](https://github.com/modelcontextprotocol/typescript-sdk/issues/2964),
  [#2639](https://github.com/modelcontextprotocol/typescript-sdk/issues/2639), [#2232](https://github.com/modelcontextprotocol/typescript-sdk/issues/2232)
- npm: `npm view @modelcontextprotocol/{server,client,core,node,express,hono} version` (2026-10-09)
