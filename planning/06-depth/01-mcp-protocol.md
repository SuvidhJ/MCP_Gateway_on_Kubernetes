# 06·01 — MCP Wire Protocol, Exactly (2026-07-28 and the legacy era)

Written 2026-10-09 from the **raw spec source** (`modelcontextprotocol/modelcontextprotocol`, files under
`docs/specification/2026-07-28/`, `docs/specification/2025-11-25/` and `schema/*/schema.ts`), not from summaries.
Quotes are verbatim; "→ us" lines are our reading for the gateway. Where the spec is ambiguous or inconsistent, §14 says so.

Why this doc exists: the gateway is a server to clients and a client to upstreams, in **two protocol eras on each side**.
Every status code, header and field below is something the gateway must produce, accept, validate or translate.

---

## 1. Versions and eras

| Version | Era | Transport over HTTP | Notes |
|---|---|---|---|
| 2024-11-05 | legacy | HTTP+SSE (GET `/sse` + POST endpoint) | deprecated; "eligible for removal three months after SEP-2596 reaches Final" |
| 2025-03-26 | legacy | Streamable HTTP (sessions, GET stream) | default assumed when a request has no `MCP-Protocol-Version` header |
| 2025-06-18 | legacy | Streamable HTTP | introduced `MCP-Protocol-Version` header, `structuredContent`, `outputSchema` |
| 2025-11-25 | legacy | Streamable HTTP | tasks (experimental), URL elicitation, tool-name rules, icons |
| **2026-07-28** | **modern** | Streamable HTTP, **stateless, POST only** | `LATEST_PROTOCOL_VERSION = "2026-07-28"` in schema.ts |

Terminology (spec, versioning.mdx): **modern** = per-request metadata (2026-07-28+); **legacy** = `initialize`
handshake (2025-11-25 and earlier); **dual-era** = supports both.

---

## 2. The modern HTTP request, field by field

```http
POST /mcp HTTP/1.1
Host: gateway.example.com
Authorization: Bearer urumi_live_...                 ← our auth (spec: "MUST be included in every HTTP request")
Content-Type: application/json
Accept: application/json, text/event-stream          ← client MUST list both
MCP-Protocol-Version: 2026-07-28                     ← MUST, every POST; MUST equal _meta protocolVersion
Mcp-Method: tools/call                               ← REQUIRED on all requests (= body.method)
Mcp-Name: woo__list_orders                           ← REQUIRED for tools/call, resources/read, prompts/get
Mcp-Param-Region: us-west1                           ← only if the tool's inputSchema marks a property x-mcp-header

{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{
  "name":"woo__list_orders","arguments":{"status":"processing"},
  "_meta":{
    "io.modelcontextprotocol/protocolVersion":"2026-07-28",          ← REQUIRED
    "io.modelcontextprotocol/clientCapabilities":{},                  ← REQUIRED ({} = no optional capabilities)
    "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"…"},  ← SHOULD
    "progressToken":"p-7",                                            ← optional: opt in to notifications/progress
    "traceparent":"00-…-…-01"                                          ← optional: W3C trace context (OTel)
  }}}
```

Rules, verbatim where it matters:

- **Body:** "a single JSON-RPC _request_ or _notification_. The client **MUST NOT** send JSON-RPC _responses_."
  (Legacy allowed responses in POST bodies; modern does not, because servers no longer send requests.)
- **IDs:** string or integer, "**MUST NOT** be `null`", unique among the sender's in-flight requests.
- **Missing required `_meta` field** → "the server **MUST** reject it with JSON-RPC error code `-32602` (Invalid
  params). On HTTP, the response status **MUST** be `400 Bad Request`."
- **Statelessness:** "Servers **MUST NOT** rely on prior requests over the same connection to establish context (e.g.,
  capabilities, protocol version, client identity)."
- **`clientInfo` / `serverInfo` are self-reported**: "**SHOULD NOT** use them to change the behavior … and **SHOULD NOT**
  rely on them for security decisions." → us: the audit "via" column may *display* clientInfo, but must never authorise on it.
- **Capabilities:** "A server **MUST NOT** rely on capabilities the client has not declared." If a request needs an
  undeclared one → `-32021 MissingRequiredClientCapability`, `data.requiredCapabilities`, HTTP 400.

### 2.1 Header ⇄ body validation (server side)

"Servers that process the request body **MUST** reject requests where the values specified in the headers do not match
the corresponding values in the request body." Failure → **HTTP 400 + `-32020 HeaderMismatch`**. Failure conditions:

1. A required standard header (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) is missing.
2. A header value differs from the body value (decode `=?base64?…?=` first; compare integers numerically, `42.0 == 42`).
3. A header value contains invalid characters.

Header *names* are case-insensitive; header *values* (method names, tool names) are case-sensitive.

"Intermediaries **MUST** return an appropriate HTTP error status (e.g., `400 Bad Request`) for validation failures but are
not required to return a JSON-RPC error response." And: intermediaries that route or rate-limit on mirrored headers
"**SHOULD** verify that the `MCP-Protocol-Version` header indicates a version that requires header–body validation. If the
version is older or the header is absent, the intermediary **SHOULD** reject the request rather than trusting unvalidated
header values."

→ us: the gateway *processes the body*, so it is a "server" for this rule and must validate. It must never route on
`Mcp-Name` alone; route on the parsed body after validation.

### 2.2 Mcp-Param headers (`x-mcp-header`)

- A tool's `inputSchema` property may carry `"x-mcp-header": "Region"`; clients **MUST** then send `Mcp-Param-Region`.
- Constraints (violations make the *tool definition invalid*): non-empty; RFC 9110 token chars; case-insensitively
  unique; only on `string`/`integer`/`boolean` (not `number`); integers within ±(2^53−1); property must be reachable only
  through `properties` keys (not via `items`, `oneOf/anyOf/allOf/not`, `if/then/else`, `$ref`).
- Clients **MUST** drop invalid tools from their `tools/list` view (and SHOULD log a warning).
- Encoding: plain value if visible ASCII (0x21–0x7E, space, tab) with no leading/trailing whitespace; otherwise
  `=?base64?<base64(utf8)>?=` (lowercase markers). A plain value that *looks like* the sentinel must also be encoded.
  `boolean` → `"true"`/`"false"`; `integer` → decimal.
- Value `null` or absent → header omitted, server MUST NOT expect it. Value present but header missing → server MUST reject.
- Intermediaries that do not recognise an `Mcp-Param-*` header **MUST** forward it and otherwise ignore it.
- On `-32020` caused by Mcp-Param headers, the client SHOULD re-list tools and retry.
- Security: "Server developers **SHOULD NOT** mark sensitive parameters (passwords, API keys, tokens, PII) with
  `x-mcp-header`" (headers are visible to intermediaries).

→ us (two roles):
- **As a client of modern upstreams** we must mirror `x-mcp-header` parameters ourselves when calling them.
- **As a server to clients** we choose what schemas we re-export. Stripping `x-mcp-header` from re-exported schemas means
  clients never send `Mcp-Param-*` to us, and only our upstream client adds them. That keeps one validation point.
- GitHub's hosted server requires `Mcp-Param-*` even on *legacy* calls, and no SDK sends them there (TS SDK #2639,
  doc 05). Only our own upstream client can fix that, by mirroring on every era.
  - **Round 6 (07 §8):** GitHub's `/mcp/readonly` now negotiates **2026-07-28** as well as legacy. On legacy,
    `get_file_contents` (whose `owner`/`repo` carry `x-mcp-header`) succeeded **without** any `Mcp-Param-*` header
    from SDK client 2.3.1. The legacy-era requirement didn't reproduce today; keep the escape hatch in mind, but
    it's no longer a blocker.

### 2.3 What the server sends back

| Situation | HTTP | Body |
|---|---|---|
| Request handled, single answer | 200, `Content-Type: application/json` | JSON-RPC response |
| Request handled, streaming (progress, then answer) | 200, `Content-Type: text/event-stream` | SSE events, final event = response; "**SHOULD** terminate the stream" |
| Notification accepted | **202**, no body | — |
| Notification rejected | 4xx (e.g. 400) | MAY be a JSON-RPC error with no `id` |
| Missing/mismatched mirrored header | **400** | `-32020` |
| Missing required `_meta` field | **400** | `-32602` |
| Unsupported protocol version | **400** | `-32022` + `data.supported[]` + `data.requested` |
| Needs an undeclared client capability | **400** | `-32021` + `data.requiredCapabilities` |
| Unknown RPC method | **404** | `-32601` (the JSON-RPC body distinguishes it from a "no MCP here" 404) |
| Invalid `Origin` header present | **403** | MAY be a JSON-RPC error with no `id` |
| Legacy `GET`/`DELETE` to a modern-only server | **405** | — (SHOULD) |
| Auth missing/invalid | **401** | per OAuth 2.1 §5.3 (see §11) |
| Insufficient permission/scope | **403** | per RFC 6750 (see §11) |

Every result **MUST** include `resultType` (`"complete"` | `"input_required"` | extension values; unknown values are
invalid to the client). Clients **MUST** treat an *absent* `resultType` as `"complete"` (that's how legacy results are read).
Servers **SHOULD** put `_meta["io.modelcontextprotocol/serverInfo"] = {name, version}` in every result.

SSE details: servers **SHOULD** send `X-Accel-Buffering: no` on any SSE response; long-lived streams are "encouraged to
periodically emit an SSE comment line (… `:\r\n`) as a keep-alive". "Resumable SSE streams via `Last-Event-ID` are not
supported", so a broken stream loses the in-flight request and the client must re-issue it with a new id.

Request-scoped notifications (`notifications/progress`, `notifications/message`) flow **only** on that request's response
stream, never on the listen stream. The server "**MUST NOT** send independent JSON-RPC _requests_" on any stream.

---

## 3. Error codes (complete table for both eras)

| Code | Name | Era | HTTP (modern) | Gateway use |
|---|---|---|---|---|
| -32700 | Parse error | both | 400 | malformed JSON |
| -32600 | Invalid request | both | 400 | not JSON-RPC |
| -32601 | Method not found | both | **404** | unknown method (e.g. `prompts/get` if we don't serve prompts) |
| -32602 | Invalid params | both | 400 / 200* | unknown or hidden tool, missing `_meta`, bad cursor, resource not found (modern) |
| -32603 | Internal error | both | 500 | our bugs only |
| -32000…-32019 | implementation-defined, **legacy sub-range** | legacy | — | "new implementations **SHOULD NOT** use"; receivers must not assume meanings (SDKs used -32000 "session not found", -32001 timeouts) |
| -32002 | Resource not found | ≤2025-11-25 | — | clients SHOULD still accept it from legacy servers; modern servers MUST NOT emit |
| **-32020** | HeaderMismatch | modern | 400 | header/body validation |
| **-32021** | MissingRequiredClientCapability | modern | 400 | e.g. MRTR elicitation to a client without `elicitation` |
| **-32022** | UnsupportedProtocolVersion | modern | 400 | `data: {supported, requested}` |
| -32042 | URL elicitation required | 2025-11-25 only | — | modern MUST NOT emit |
| -32021…-32099 others | reserved for the spec | — | — | "**MUST NOT** emit any code from this sub-range that is not defined by this specification" |

\* JSON-RPC errors for a well-formed request on an existing method are carried in a 200 response in practice (the spec
only fixes HTTP statuses for the cases listed in §2.3).

Policy for codes *we* invent: "New error codes for purposes not defined by this specification **SHOULD** be allocated
outside the JSON-RPC reserved range (`-32768` to `-32000`)". And: local errors (e.g. an SDK-side timeout) "should ensure
they cannot be mistaken for errors received from the peer".

→ us: gateway-level failures that the model should see (upstream timeout, upstream down, server disabled, policy denied)
are **tool execution errors** (`isError: true` result, see §5.3), not new JSON-RPC codes. Unknown/hidden tool names are
`-32602`. If we ever need a machine-readable gateway code, put it in `_meta` under our own prefix (e.g.
`ai.urumi/errorCode`), not in the reserved ranges.

---

## 4. `server/discover` (modern; servers MUST implement)

Request: no params beyond `_meta`. Result (`DiscoverResult extends CacheableResult`):

```json
{"resultType":"complete",
 "supportedVersions":["2026-07-28","2025-11-25"],
 "capabilities":{"tools":{"listChanged":true}},
 "instructions":"optional natural-language guidance for LLMs",
 "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"urumi-gateway","version":"0.1.0"}},
 "ttlMs":60000, "cacheScope":"private"}
```

- Calling it is optional for clients ("free to invoke any RPC inline and handle `UnsupportedProtocolVersionError`").
- It is the **stdio** era probe; on HTTP the era probe is "any modern request" (§9), which in practice SDKs make with discover.
- `instructions` should not duplicate tool descriptions.

→ us: our discover result advertises `tools.listChanged: true`; `supportedVersions` should list every version we serve.
Should it be `private`? Capabilities don't vary by user, but `instructions` might. Keep it `private` if it varies, else
`public`. (Our tool lists are per-user, see §6.)

---

## 5. Tools (exact)

### 5.1 `Tool`

```ts
interface Tool {                // 2026-07-28 schema.ts
  name: string;                 // SHOULD 1–128 chars [A-Za-z0-9_.-], case-sensitive, unique per server
  title?: string;               // display; precedence: title > annotations.title > name
  description?: string;
  icons?: Icon[];
  inputSchema: { $schema?: string; type: "object"; [k: string]: unknown };  // ANY 2020-12 keyword allowed
  outputSchema?: { $schema?: string; [k: string]: unknown };                // ANY root type allowed (e.g. array)
  annotations?: ToolAnnotations;
  _meta?: MetaObject;
}
interface ToolAnnotations {     // all are HINTS; "MUST consider … untrusted unless they come from trusted servers"
  title?: string;
  readOnlyHint?: boolean;       // default false
  destructiveHint?: boolean;    // default TRUE  (meaningful only when readOnlyHint == false)
  idempotentHint?: boolean;     // default false (meaningful only when readOnlyHint == false)
  openWorldHint?: boolean;      // default TRUE
}
```

**Legacy difference (2025-11-25 schema.ts):** `inputSchema` was typed `{type:"object"; properties?; required?}`;
`outputSchema` was "**Currently restricted to type: "object" at the root level**"; tools could carry
`execution.taskSupport: "forbidden"|"optional"|"required"`.

Schema rules (basic/index.mdx "JSON Schema Usage"):
- No `$schema` → JSON Schema **2020-12**. Implementations MUST support 2020-12 and "**MUST** handle unsupported dialects
  gracefully by returning an appropriate error".
- `$ref` to a network URI **MUST NOT** be dereferenced automatically; unresolved external `$ref` SHOULD be rejected.
- Validation of composition keywords SHOULD be bounded (depth, subschema count, time) as a DoS defence.
- No-parameter tool: recommended `{"type":"object","additionalProperties":false}`.

### 5.2 `tools/list`

- Paginated (`cursor` → `nextCursor`; missing `nextCursor` = end; empty string is a *valid* cursor; invalid cursor →
  `-32602`). Page size is the server's choice.
- **Per-caller lists are explicitly legal:** "**MUST NOT** vary per-connection or as a side effect of other requests …
  The set **MAY** vary by the authorization presented on the request — for example, returning only the tools the caller's
  granted scopes permit".
- "Servers **SHOULD** return tools in a deterministic order" (prompt-cache hit rates).
- Result: `{resultType, tools[], nextCursor?, ttlMs, cacheScope, _meta?}`.

### 5.3 `tools/call`

Params: `{name, arguments?, _meta, inputResponses?, requestState?}`. Result: `CallToolResult | InputRequiredResult`.

```ts
interface CallToolResult {
  resultType: "complete";
  content: ContentBlock[];        // text | image | audio | resource_link | resource   (each may carry annotations)
  structuredContent?: unknown;    // modern: ANY JSON value; legacy: object only
  isError?: boolean;              // default false
}
```

Two error channels (tools.mdx "Error Handling"):
1. **Protocol errors** (JSON-RPC `error`): unknown tool, request that fails the CallToolRequest schema, server errors.
2. **Tool execution errors** (`isError: true`): "API failures, Input validation errors (e.g., date in wrong format, value
   out of range), Business logic errors". "Clients **SHOULD** provide tool execution errors to language models to enable
   self-correction." schema.ts: "Any errors that originate from the tool SHOULD be reported inside the result object …
   _not_ as an MCP protocol-level error response."

Structured output: if `outputSchema` exists, "Servers **MUST** provide structured results that conform … Clients **SHOULD**
validate". For back-compat a tool returning `structuredContent` "SHOULD also return the serialized JSON in a TextContent block".

Security MUSTs for servers: "Validate all tool inputs; Implement proper access controls; Rate limit tool invocations;
Sanitize tool outputs." Clients SHOULD confirm sensitive operations, show inputs before calling, time out calls, log usage.

**Stateful tools** (non-normative): no protocol session, so cross-call state uses explicit handles returned by a tool and
passed back as arguments; handles must be authorised per call ("a handle is a name, not a capability").

### 5.4 Change notification

`notifications/tools/list_changed` (no params) is delivered **only** on a `subscriptions/listen` stream opened with
`toolsListChanged: true` (modern), or on the legacy GET/POST SSE stream (legacy).

---

## 6. Caching hints (`ttlMs`, `cacheScope`) — required in modern results

- **MUST** be present on `resultType:"complete"` results of: `server/discover`, `tools/list`, `prompts/list`,
  `resources/list`, `resources/templates/list`, `resources/read`. Not on `input_required` results. Retried MRTR results
  (carrying `inputResponses`/`requestState`) **MUST NOT** be cached.
- `ttlMs` ≥ 0 (server MUST). 0 = immediately stale. Absent → client assumes 0 ("should only occur in older server
  versions"). Negative → treat as 0. Fresh while `now < t_received + ttlMs`.
- TTL is not a polling interval; clients that poll MUST use jitter and backoff. Clients MAY refetch early on an
  "unexpected error on a tool call indicating the method was not found or the parameters were invalid", and MAY serve
  stale on refetch errors.
- `cacheScope`: `"public"` = no user-specific data, any shared cache may serve it to anyone; `"private"` = reuse only
  within the same authorization context ("a different access token requires a different cache").
- A notification **invalidates** a fresh cached list immediately.
- Pagination: each page has its own `ttlMs`; same `cacheScope` on all pages of one list.
- Security: "MUST apply appropriate per-primitive access controls, and MUST NOT rely on `cacheScope` alone".

→ us: our `tools/list` is filtered per user (roles/permissions, disabled servers), so **`cacheScope: "private"`** always.
Pick a short `ttlMs` (e.g. 30–60 s) so a client that misses a notification still converges; never omit the fields (Claude
Code #88128 drops all tools when they're missing, doc 05). Call-time enforcement remains the real guarantee (§13).

---

## 7. `subscriptions/listen` (modern change notifications)

Request params: `{notifications: {toolsListChanged?, promptsListChanged?, resourcesListChanged?, resourceSubscriptions?: string[]}, _meta}`.

1. Response is an SSE stream that stays open.
2. First message **MUST** be `notifications/subscriptions/acknowledged` with
   `params.notifications` = the subset the server will honour, and
   `_meta["io.modelcontextprotocol/subscriptionId"]` = the listen request's JSON-RPC `id`.
3. Every later notification carries the same `subscriptionId` in `_meta`. The server "**MUST NOT** send notification types
   the client has not explicitly requested".
4. Ends when: the client closes the stream; the server ends it (SHOULD send a final *result* for the listen `id`,
   `{"resultType":"complete","_meta":{"io.modelcontextprotocol/subscriptionId":<id>}}`, then close); or the transport
   drops (no result → "client **MAY** treat as a trigger to reconnect").
5. Multiple concurrent subscriptions are allowed (each identified by its request id).

→ us: one listen stream per connected modern client. On admin changes and upstream list changes, push
`notifications/tools/list_changed` to every stream whose filter asked for it. The notification has no payload, so a
broadcast leaks nothing; each client re-lists with its own credentials. On pod shutdown send the graceful result first
(clients then know it wasn't a crash), and send `:` comment keep-alives well under every idle timeout on the path (doc 06·05).

---

## 8. Cancellation, timeouts, progress

| | Modern (2026-07-28) | Legacy (≤ 2025-11-25) |
|---|---|---|
| Client cancels a request | **close the SSE response stream**; server "**MUST** treat a client disconnect as cancellation"; no `notifications/cancelled` on HTTP | send `notifications/cancelled {requestId, reason}`; "Disconnection **SHOULD NOT** be interpreted as the client cancelling" |
| Server after cancel | SHOULD stop work, MUST NOT send further messages for it | SHOULD stop, free resources, not respond |
| Timeouts | "Implementations **SHOULD** establish timeouts for all sent requests"; on timeout, cancel (= close stream on HTTP); MAY reset on progress but "**SHOULD** always enforce a maximum timeout" | same guidance |
| Progress | `_meta.progressToken` (string/int, unique among active requests) → `notifications/progress {progressToken, progress, total?, message?}`; progress MUST increase; on the request's own stream only | same, legacy could also carry them on streams |
| Ping | **removed** | `ping` request exists |

→ us: a client disconnect (modern) must abort the upstream call (`AbortSignal` wired to the request's `close` event). For
legacy clients a disconnect isn't formally a cancel, but in our stateless mode the response could never be delivered
anyway, so aborting the upstream work is the pragmatic choice. Our upstream deadline is our own timeout; forward a
`progressToken` upstream only if we relay progress (optional).

---

## 9. Era detection and the dual-era server

**Client side (how *we* probe upstreams, and how Claude Code probes *us*):**
1. Send a modern request first (SDKs use `server/discover`).
2. 2xx with a modern result → modern.
3. `400`/`404`/`405` → **inspect the body**: a *recognised modern JSON-RPC error* (`-32022` with `supported`, `-32021`,
   `-32020`, or `-32601` on 404) means modern: fix the request or retry with a supported version. Anything else (empty
   body, legacy error text, "Mcp-Session-Id required", `-32601` from a legacy server …) means legacy: send `initialize`.
4. Optional further fallback to HTTP+SSE: GET the URL, expect an `endpoint` event.
5. "Clients **SHOULD** cache the result for … origin (HTTP), and **MAY** persist it across restarts of the same server
   configuration, re-probing if the cached assumption later fails."

**Server side (how we serve both):** "A request carrying modern per-request `_meta` is served statelessly according to this
revision. An `initialize` request selects legacy semantics, scoped to … the session (HTTP)." "A dual-era server **MAY**
serve both eras concurrently on the same endpoint." A modern-only server receiving `initialize` "**SHOULD** name the protocol
versions it supports in any error" (legacy clients can't fall forward).

**Matrix:** modern↔modern ✓ · dual→legacy ✓ (fallback) · legacy→dual ✓ · **legacy→modern-only ✗** · **modern-only→legacy ✗**.

Edge: a legacy server that answers the modern probe with **200** (processing an era-ambiguous method like `tools/list`
under legacy semantics) is possible ("may … even process an era-ambiguous method under legacy semantics"). This is why
SDKs probe with `server/discover`, which no legacy server implements.

---

## 10. The legacy era in detail (what VS Code and legacy upstreams speak)

```text
1  POST initialize {protocolVersion, capabilities, clientInfo}          (no session header)
   ← 200 {protocolVersion, capabilities, serverInfo, instructions?}    (+ optional "Mcp-Session-Id: <visible ASCII>")
2  POST notifications/initialized                                       ← 202
3  POST tools/list | tools/call | ping …  with Mcp-Session-Id (if issued) + MCP-Protocol-Version: <negotiated>
   ← application/json OR text/event-stream (server may send requests+notifications on it, then the response)
4  GET  (Accept: text/event-stream) → standalone stream, or 405 if not offered
5  DELETE with Mcp-Session-Id → end session (server MAY 405)
```

- **Version negotiation:** client sends its latest; server answers the same version if supported, else another it
  supports (SHOULD be its latest); client SHOULD disconnect if it can't speak that.
- **`MCP-Protocol-Version` header** required on requests after init (since 2025-06-18). Absent header and no other way to
  know → server "SHOULD assume protocol version `2025-03-26`". Invalid/unsupported → `400`.
- **Sessions:** MAY be assigned at init; ID must be visible ASCII 0x21–0x7E, "globally unique and cryptographically
  secure". Client MUST echo it. Servers requiring it SHOULD answer requests without it with `400`. Terminated/unknown
  session → **`404`**, and the client "**MUST** start a new session by sending a new `InitializeRequest`".
- **Streams:** server MAY send requests (sampling, elicitation, roots) and notifications on a POST's SSE stream before the
  response; SHOULD send a priming event with an `id` and empty `data`; MAY close the connection early with a `retry:`
  field and let the client "poll" via GET + `Last-Event-ID`. Each message goes on exactly one stream (no broadcast).
- **GET stream:** MUST be `text/event-stream` or `405`. Messages there "SHOULD be unrelated to any concurrently-running"
  request; no responses except when resuming.
- **Ordering:** client SHOULD NOT send requests other than pings before the init response; server SHOULD NOT send requests
  other than pings/logging before `initialized`.

→ us as a **legacy server** (to VS Code etc.): we can run legacy **statelessly** (no session id minted, every POST
self-contained, GET → 405). Spec-legal: sessions are "MAY". Consequence: legacy clients get no push, so they see
changes on their next `tools/list` (call-time enforcement covers the gap).
→ us as a **legacy client** (to DeepWiki-style upstreams): we must keep the upstream's session id, send
`MCP-Protocol-Version`, and on `404` **re-initialise and retry once** (TS SDK doesn't do this for us, #1708, doc 05).

---

## 11. Authorization as it affects a static-key gateway

- Authorization is **optional**; "clients and servers **MAY** negotiate their own custom authentication". Static bearer
  keys are spec-legal. But clients implement the OAuth flow, so our **responses must not trigger it accidentally**.
- Every request MUST carry `Authorization: Bearer …`; tokens **MUST NOT** be in the query string.
- "Invalid or expired tokens **MUST** receive a HTTP 401." "MCP servers **MUST NOT** accept or transit any other tokens."
- Client behaviour on 401: parse `WWW-Authenticate`; if it has `resource_metadata=`, fetch it; **otherwise "fall back to
  constructing and requesting the well-known URIs"**: `/.well-known/oauth-protected-resource/<mcp-path>` then
  `/.well-known/oauth-protected-resource`; if none found → "Abort or use pre-configured values".
- 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` is the **step-up** trigger (client re-authorises
  with more scopes).

→ us:
- Invalid or revoked key → `401`, `WWW-Authenticate: Bearer error="invalid_token", error_description="API key revoked"`,
  no `resource_metadata`, plus a JSON body with a human-readable reason.
- Our gateway must **not** serve `/.well-known/oauth-protected-resource*` (404), so clients stop at "abort".
- A per-tool *policy* denial is not an HTTP 403. Use `-32602` for hidden tools, or `isError` with "denied by policy".
  An HTTP 403 with `insufficient_scope` would start an OAuth step-up loop.
- Whether Claude Code, Cursor and Inspector show this cleanly is experiment E4 (doc 05: Inspector #2515 starts OAuth on
  a plain 403).

From the official security best practices (2026-07-28 tutorial):
- **Token passthrough** is forbidden: "MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the
  MCP server". For us this means never forward the client's key upstream.
- **SSRF:** block private ranges (10/8, 172.16/12, 192.168/16, 127/8, ::1, 169.254/16, fc00::/7, fe80::/10).
  "Avoid implementing IP validation manually" (octal, hex, IPv4-mapped IPv6 tricks). Validate every redirect hop. Pin
  DNS between check and use. Consider an egress proxy (Stripe Smokescreen).
- **State handle hijacking:** bind handles to the authenticated user server-side (`<user_id>:<handle>`); possession of a
  handle is not authentication.
- **Origin:** servers MUST validate `Origin` on all incoming connections; present and invalid → 403.

---

## 12. MRTR (server→client input, modern) — what a gateway must do with it

- Allowed only on `tools/call`, `resources/read`, `prompts/get`. Result
  `{"resultType":"input_required","inputRequests":{key:{method:"elicitation/create"|"sampling/createMessage"|"roots/list",params}},"requestState":"<opaque>"}`
  (at least one of the two fields).
- Client retries the **original** request with a **new id**, plus `inputResponses` (same keys) and the exact
  `requestState`. Clients must not parse `requestState`; servers must integrity-protect it if it matters and bind it to
  the principal, a short expiry, and the originating request.
- Servers MUST NOT include input requests for capabilities the client didn't declare.

→ us: our own upstreams (WooCommerce MCP, the in-cluster one) never use MRTR. For third-party upstreams the gateway
has two options:
- **Relay:** pass `inputRequests` through to the client, and pass the client's retry (`inputResponses` + opaque
  `requestState`) back to the same upstream tool.
- **Reject:** turn `input_required` into a tool execution error: "this tool needs interactive input, which the gateway
  doesn't relay".

Relaying is stateless for us and works only for modern clients, which declare `elicitation` themselves. Legacy clients
would need a server-initiated request on a stream, which our stateless legacy mode can't send.

---

## 13. Cross-era translation table (terminating gateway)

| Aspect | Modern client ← gateway | Legacy client ← gateway | Gateway → modern upstream | Gateway → legacy upstream |
|---|---|---|---|---|
| Handshake | none (validate `_meta` + headers per request) | answer `initialize`; 202 to `initialized`; stateless (no session id) | per-request `_meta`; discover once to cache era | `initialize` + `initialized`; keep session id; 404 → re-init |
| `resultType` | add `"complete"` | omit (harmless if present? legacy clients ignore unknown fields, but strip for strict clients) | expect it | absent → treat as `complete` |
| `ttlMs`/`cacheScope` on lists | **always add** (`private`) | omit | read & respect (cache upstream catalog) | absent → our own TTL/refresh policy |
| `structuredContent` | any JSON | **object only**: if upstream returned a non-object, drop it (text block still carries it) | any JSON | object |
| `outputSchema` | any root | **object root only**: drop non-object outputSchemas when exporting to legacy | any | object |
| `inputSchema` | 2020-12 default; strip `x-mcp-header` (our choice) | same normalisation | mirror `x-mcp-header` params into headers | (GitHub quirk: still mirror) |
| Resource not found | `-32602` | `-32002` historically; accept both from upstreams | `-32602` | `-32002` |
| Change push | `subscriptions/listen` | GET → 405 (stateless) ⇒ no push | listen stream per upstream (if `listChanged`) | GET stream on the session (if offered) |
| Cancel | client closes stream → abort upstream | pragmatic abort on disconnect | close the upstream stream (abort fetch) | `notifications/cancelled` + abort fetch |
| `ping` | removed | answer `ping` with `{}` | — | — |
| Logging | only if `_meta.logLevel` set (deprecated) | `logging/setLevel` (we can ignore) | don't request | don't request |
| Server→client input | MRTR relay or reject (§12) | not supported in stateless mode | MRTR | legacy server-initiated requests on streams: we decline (we don't declare sampling/elicitation capabilities) |
| Tasks | extension `io.modelcontextprotocol/tasks` (we don't advertise) | `execution.taskSupport`: strip from exported tools | — | don't request task augmentation |

The gateway declares **no client capabilities** upstream (`clientCapabilities: {}`). That way upstreams never ask us
for sampling, elicitation or roots, and §12's relay becomes an explicit opt-in.

---

## 14. Ambiguities and inconsistencies found in the spec text

1. **Server ending a listen stream:**
   - `subscriptions.mdx` says the server SHOULD send a completion *result* for the listen `id`.
   - `cancellation.mdx` says "A server **MUST** send `notifications/cancelled` referencing a `subscriptions/listen` request
     ID when it tears down that subscription stream".

   The two contradict each other. Do both: send `notifications/cancelled`, then the final result, then close. That
   satisfies either reading.
2. **Notification POST headers** "are not defined by this revision"; modern clients send no notifications over HTTP
   anyway. Answer any notification POST with 202 and ignore it.
3. **Era-ambiguous methods:** a legacy server may answer a modern `tools/list` with 200, so the era probe must use
   `server/discover` (§9).
4. **`-32602` vs `isError` for input validation:**
   - Tools.mdx lists "Malformed requests (requests that fail to satisfy CallToolRequest schema)" as protocol errors.
   - It lists "Input validation errors" (wrong date format) as execution errors.

   Read together: *structurally* bad params (missing `name`) are `-32602`; bad *argument values* go back as `isError`, so
   the model can fix them.
5. **HTTP status for ordinary JSON-RPC errors** (e.g. `-32602` unknown tool) isn't pinned down. 200 with an error body is
   the common SDK practice. Statuses are fixed only for the §2.3 cases.

---

## 15. Compliance checklist for our gateway (testable)

Modern endpoint:
- [ ] Rejects missing/mismatched `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` with 400/-32020; decodes base64 sentinel.
- [ ] Missing required `_meta` → 400/-32602. Unknown version → 400/-32022 with `supported` + `requested`.
- [ ] Unknown method → 404/-32601. GET/DELETE → 405. Ignores `Mcp-Session-Id` and `Last-Event-ID`.
- [ ] `server/discover` implemented with `supportedVersions`, capabilities, `serverInfo`, `ttlMs`, `cacheScope`.
- [ ] Every result has `resultType`; list/discover results have `ttlMs` ≥ 0 and `cacheScope`; tools in deterministic order.
- [ ] `subscriptions/listen`: ack first, `subscriptionId` on everything, only requested types, keep-alives, graceful end.
- [ ] Client disconnect aborts upstream work.
- [ ] `Origin` validated (403 if present and not allowed); `Host` allow-list (doc 06·08).

Legacy endpoint (same URL):
- [ ] `initialize` → negotiated version (prefer the client's if supported); no session id (stateless) or a secure one.
- [ ] `notifications/initialized` → 202; `ping` → `{}`; GET → 405; DELETE → 405.
- [ ] Results without modern-only fields; non-object `structuredContent`/`outputSchema` dropped.

Upstream client:
- [ ] Probe with discover; cache verdict per (URL, credential); re-probe on failure.
- [ ] Mirror `x-mcp-header` params; send required headers + `_meta`; `clientCapabilities: {}`.
- [ ] Legacy: keep session, re-init on 404 (retry once), send `MCP-Protocol-Version`.
- [ ] Never forward client headers/tokens; inject only the stored credential.

---

## Sources (raw spec files, fetched 2026-10-09)
- 2026-07-28: [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) ·
  [Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) ·
  [Overview/_meta/errors](https://modelcontextprotocol.io/specification/2026-07-28/basic/index) ·
  [Discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) ·
  [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) ·
  [Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching) ·
  [Pagination](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination) ·
  [Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions) ·
  [Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) ·
  [Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress) ·
  [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) ·
  [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) ·
  [Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) ·
  [Deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) ·
  [Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) ·
  [schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
- 2025-11-25: [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) ·
  [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) ·
  [schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)
