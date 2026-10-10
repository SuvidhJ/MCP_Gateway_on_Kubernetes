# 06·03 — Gateway Mechanics: How Aggregation, Naming, Health, Caching and Calls Really Work

Written 2026-10-09 from the source of three gateways that solve our problem in different languages:
- **Kuadrant mcp-gateway** (Go, Envoy + broker), commit `1e85e3d`, 2026-10-06:
  `internal/broker/upstream/manager.go`, `validate.go`, `internal/broker/broker.go`, `protocol_handler_2026.go`.
- **agentgateway** (Rust): `crates/agentgateway/src/mcp/{README.md,handler.rs,mergestream.rs}`.
- **MetaMCP** (TypeScript, SDK client per upstream): `apps/backend/src/lib/metamcp/metamcp-proxy.ts`,
  `metamcp-middleware/filter-tools.functional.ts`, `utils.ts`.

Combined with 06·01 (protocol) and 06·02 (SDK), this is the internal design space for our gateway. Each section ends
with **→ input** (an option and its evidence). No decision is taken here.

---

## 1. The components every working gateway converges on

```
               ┌──────────── control plane ────────────┐
 admin UI ───► │ registry (servers, creds*, policies)  │──► change events
               └───────────────────────────────────────┘          │
                                                                   ▼
 client ──► auth ──► request router ──► policy ──► upstream client pool ──► upstream MCP servers
              │            │   ▲            │             ▲      │
              │            ▼   │            ▼             │      └─ per-upstream manager (health, era, catalog refresh)
              │        catalog (exposed name → upstream id + original tool)        │
              ▼                                                                    ▼
            audit ◄───────────────────────────────────────────── notifier (list_changed → clients)
```
\* credentials encrypted at rest, never returned by the API (06·06).

Kuadrant splits the managers (broker) from the hot path (Envoy). MetaMCP and agentgateway keep them in one process.
For us (one Node process, small scale), one process with a clear module boundary is enough.

---

## 2. Per-upstream manager (Kuadrant's design, the most complete)

`MCPManager` is a long-lived goroutine, 1:1 with an upstream, and "the only thing that should be connecting to the MCP
Server for the broker". What it does:

| Mechanism | Kuadrant code | Values |
|---|---|---|
| Event loop | ticker + three 1-slot channels (`toolEvents`, `promptEvents`, `reconnectEvents`) so "one event type cannot block another while still coalescing rapid same-type notifications" | — |
| Health tick | `manage()`: `Connect` → **`Ping`** → fetch tools if needed | `DefaultTickerInterval = 1m` |
| Backoff on failure | `wait.Backoff{Duration: 1s, Factor: 2, Jitter: 0.1, Cap: tickerInterval}`; reset on success | 1s, 2s, 4s … ≤ 1 min |
| Grace before dropping tools | `maxConsecutiveFailures = 3`: cached tools stay served through transient blips ("serving a cached list through a transient upstream blip is no worse than the staleness already allowed between health ticks") | 3 |
| Disabled server | `!IsEnabled()` → remove all tools, `Disconnect()`, status "server is disabled", manager stays alive | — |
| Refresh trigger | `notifications/tools/list_changed` from upstream, or tick | — |
| Modern upstreams | poll interval adapts to the upstream's `tools/list` `ttlMs`, clamped ≥ 1 min | — |
| Tool validation | `ValidateTools`: name non-empty; `inputSchema` must exist, be an object with `type:"object"`, property `type`s valid JSON-Schema types; `outputSchema` (if present) object-typed | invalid → policy: **drop the tool** or **reject the server** (`InvalidToolPolicy`) |
| Diff + conflicts | `diffTools(current, fetched)`; `findToolConflicts` against all served tools (keyed by `_meta[GatewayServerID]`) → conflict = error status, tools not added | — |
| Change detection | `toolSpecChanged`: description, inputSchema or outputSchema differ (`reflect.DeepEqual`) | rug-pull signal |
| Status | `ServerValidationStatus{Ready, Message, LastValidated, tool count, invalid tools, protocol}` | shown by the CRD |
| Metrics | `mcp_broker_discovery`, `_discovery_duration_seconds`, `_tools_discovered`, `_upstream_connection_failures`, `_tools_list_response_bytes` | OTel |

→ input: port this structure to TypeScript. One `UpstreamManager` per registry row with:
- state `{era verdict + date, client, catalog snapshot, status, consecutiveFailures, lastError}`;
- a timer loop (tick 30–60 s, jittered backoff, max 3 strikes before hiding tools);
- refresh on `list_changed`;
- immediate actions on admin edit (enable/disable/credential change → reconnect).

Persist the last good catalog snapshot in Postgres (doc 05 Never-do #12), so a gateway restart doesn't depend on every
upstream being up.

---

## 3. Naming and the catalog

| Gateway | Exposed name | Collision handling | Routing on call |
|---|---|---|---|
| Kuadrant | admin-configured **prefix** + tool (`prefixedName(prefix, tool)` = plain concatenation) | conflicting server's tools rejected, status error | `servedToolsMap[exposed]` → original |
| agentgateway | `{target}_{tool}` (`DELIMITER = "_"`), `prefixMode: never` resolves unprefixed names by listing every target and **rejects duplicates** | per-target dedup | `split_once("_")` (target names can't contain `_`) |
| MetaMCP | `${sanitizeName(serverName)}__${tool}`; `sanitizeName` strips `[^a-zA-Z0-9_-]` | none (relies on prefix) | in-memory map, and on a miss **lists upstream tools at call time** (slow path) |

Pitfalls seen:
- Parsing exposed names breaks when a slug or tool contains the delimiter.
- Deriving the prefix from `serverInfo.name` breaks: it isn't unique and is self-reported (06·01 §5.3).
- Call-time re-listing adds latency and hides catalog bugs.

→ input:
- Exposed name = `${slug}__${toolName}`, where `slug` is admin-chosen, `^[a-z][a-z0-9-]{1,15}$` (no `_`), unique, and
  immutable after creation (or renamable with a list_changed).
- **Route by catalog lookup, never by parsing.** The catalog maps `exposed → {upstreamId, originalName, defHash}`.
- Length check: Claude Code's `mcp__<client-server-name>__<exposed>` must be ≤ 64. With client name `urumi` (5), the
  exposed name has ≤ 52 chars. Reject or truncate+hash at registration (Cursor caps server+tool at 60).
- Collisions are impossible across slugs. Within one upstream, duplicate tool names (a broken upstream) → keep the first
  and flag it.

---

## 4. `tools/list` path

What the three do:
- **Kuadrant:** serves from the registry (no fan-out on the request path). Modern requests get aggregated cache hints:
  **min non-zero `ttlMs`; any upstream `ttlMs=0` → `0`/private; any private or user-specific → `private`**
  (`ProtocolHandler2026.AggregateCache`). The 2025 handler strips the fields.
- **agentgateway:** fans out to every selected target **and waits for all** ("setup waits for every selected upstream
  before the gateway can construct its response").
  - Filters each tool through RBAC (`policies.validate(...)`).
  - Then **always** returns `ttlMs: 0, cacheScope: private`, because "we don't know if something is cacheable" once
    request-attribute policies apply ("strictly disable caching of proxied results").
  - `FailureMode::FailOpen` skips an erroring upstream (logged); FailClosed returns the error.
- **MetaMCP:** `Promise.allSettled` over upstream sessions, then middleware: tool overrides, then `filter-tools`
  (status ACTIVE/INACTIVE per namespace; **`null` status = allowed**, i.e. new tools are allowed by default).

→ input for our design:
- Serve from the **in-memory catalog** (refreshed by managers). Request latency doesn't depend on upstreams, and a dead
  upstream can't stall listing.
- Filter per caller: server enabled, upstream status (hide after N strikes, or show-but-fail-fast; open decision
  01 §7 #9), role/tool permissions, quarantine state.
- **Deterministic order**: sort by exposed name.
- Cache hints: `private` always (per-user filter). TTL is a real choice:
  - 0, like agentgateway: freshest; costs a cheap in-memory list per client turn.
  - Short, e.g. 30 s, like Kuadrant's min-TTL idea: fewer calls, and the notification still invalidates immediately.
  - Either way **call-time checks are the guarantee** (Claude Code keeps stale definitions, doc 05).
- New-tool default (MetaMCP allows unknown tools): **default-allow** (simple) vs **quarantine until approved** (TOFU,
  stand-out S-2/S-6). This is a decision for the next chat.

---

## 5. `tools/call` path (step by step, with what each gateway does)

| Step | Kuadrant | agentgateway | MetaMCP | → input |
|---|---|---|---|---|
| Resolve | `servedToolsMap` | parse `target_tool` | map, else list-at-call | catalog lookup; unknown/hidden → `-32602` |
| Authorize | Authorino/policy at Envoy | CEL `mcpAuthorization` per tool | `filter-tools` call middleware → `isError: "Tool X is currently inactive…"` | same rules as list, **evaluated again at call time**; denial = `isError` with a clear reason (+ audit `denied`) |
| Headers upstream | Envoy route config, credential from Secret | policies | `forwardedHeaders` per server (copies selected client headers!) | build from scratch: stored credential only (G4) |
| Deadline | Envoy route timeout | route request-timeout policy | SDK `timeout`, `resetTimeoutOnProgress`, `maxTotalTimeout` from config | SDK timeout **plus** fetch-level `AbortSignal.timeout` (06·02 §3.3); propagate client disconnect via `ctx.mcpReq.signal` |
| Retry | — | — | **session lost → invalidate pool, re-init, retry once** | only: (a) connect never succeeded, (b) legacy 404 session expiry → re-init + retry once. Never re-send after a request may have reached the tool (non-idempotent writes) |
| Result | pass-through | pass-through (+guardrails) | pass-through; errors thrown (JSON-RPC errors) | map to the three-tier model (§6) |
| Audit | — | access log | `audit-requests` middleware | one row per call (06·06) |

---

## 6. Three-tier error model (what the model and the user see)

| Tier | Cause | Wire shape | Example text (written for the agent) |
|---|---|---|---|
| Protocol | malformed request, unknown or hidden tool name | JSON-RPC error `-32602` | "Unknown tool 'woo__list_ordrs'." |
| Gateway | policy denial, server disabled, upstream unreachable, timeout, circuit open, credential rejected (upstream 401/403) | `isError: true` result | "The 'weather' server is disabled by an admin. Other tools are unaffected." / "'store' did not respond within 10 s." / "Your role (member) may not call woo__update_order_status." |
| Application | upstream tool returned `isError` or a domain error | upstream result passed through (size-capped, sanitised) | "Order 999 not found." |

Rules:
- Never leak internal URLs, stack traces or credentials in messages.
- Add a machine-readable reason in `_meta` under our own prefix (e.g. `ai.urumi/error: "upstream_timeout"`) for the
  dashboard and tests (06·01 §3: don't invent JSON-RPC codes in reserved ranges).

---

## 7. Health, circuit breaking, bulkheads

- **Health = exercising the real path, bounded.**
  - Kuadrant pings each tick.
  - For modern upstreams, `server/discover` is also a liveness probe (cached for its `ttlMs`).
  - A legacy server's `ping` exists.
  - G9 in doc 05: ToolHive's health said OK while calls hung. Also count **call outcomes** (timeouts, 5xx) toward the
    breaker, not just ticks.
- **Circuit breaker:**
  - Closed → (N consecutive failures in calls or ticks) → Open: fail fast with "unreachable since T". The next tick is
    the **half-open** probe; success → Closed.
  - Kuadrant's numbers (3 strikes, backoff 1 s→1 min) are reasonable.
- **Bulkhead:** a per-upstream concurrency cap (e.g. 8 in flight, queue 16, then fail fast). One slow upstream can't
  exhaust the Node event loop or sockets. Ties in with SDK #2739 (pending POSTs).
- **Kubernetes signal** (in-cluster upstreams): EndpointSlice with zero ready endpoints = instantly unreachable (needs
  read RBAC on `endpointslices`; doc 03). Optional.
- **Dashboard states:** `disabled` (admin) · `connecting` · `connected (era, n tools, last check)` · `degraded (k/3
  strikes)` · `unreachable (reason, since)` · `auth_failed` · `protocol_error` · `quarantined (definitions changed)`.

---

## 8. Change propagation

```
upstream list_changed ─┐                         ┌─► handler.notify.toolsChanged() ─► modern clients (listen streams)
admin edit / approve ──┼─► manager refresh ─► catalog diff ─┤
health strike-out ─────┘        (coalesce)                 └─► legacy clients: none (they see it on next tools/list)
```

- Coalesce bursts the way Kuadrant does (1-slot channel, i.e. a "dirty" flag plus a short debounce of ~200 ms).
- Only notify when the *visible* catalog changed (Kuadrant notifies on add/remove, or when cache metadata changed).
- Upstream notification sources:
  - **modern**: we hold one `client.listen({toolsListChanged:true})` per upstream and re-listen on `'remote'` close
    (SDK #2964);
  - **legacy**: the SDK opens the GET stream on connect if the server offers it; otherwise poll on the tick.
- Multi-replica: publish catalog-changed events on a shared bus (Postgres `LISTEN/NOTIFY` is enough at our scale) so
  every replica refreshes and notifies its own listen streams.

---

## 9. Schema normalisation (what we re-export)

Facts to design for:
- the spec allows any 2020-12 keyword (06·01 §5.1);
- clients and LLM APIs accept less: Claude Code #95504 drops tools with root-level `allOf`/`if-then`; #86142
  draft-07 dialect (fixed);
- SDK v2 legacy encoding wraps non-object outputSchemas (06·02);
- Kuadrant rejects non-object `outputSchema`.

| Transform on export | Why |
|---|---|
| Ensure `inputSchema.type === "object"` (else mark invalid, don't export) | spec + every client |
| Strip `x-mcp-header` from properties (we mirror upstream ourselves) | one validation point (06·01 §2.2) |
| Drop `$schema` if it's a draft we don't validate, or keep it if 2020-12 | client dialect support varies |
| Flag (don't silently rewrite) root-level `allOf`/`anyOf`/`if` in the admin UI | Claude Code drops such tools |
| Decide whether to export `outputSchema`; if exported, validate upstream results at the gateway and drop non-conforming `structuredContent` (keep text) | avoids WooCommerce #64195-style hard failures in clients (06·02 §3.4) |
| Cap description length; strip control, bidi and Unicode-tag characters | prompt-injection hygiene (06·08) |
| Hash the canonical definition (`defHash`) | rug-pull detection, quarantine on change |

---

## 10. Design inputs collected (to decide next chat)

1. Upstream manager per server: tick, backoff, 3-strike, persisted snapshot (adopt Kuadrant's structure).
2. Naming `${slug}__${tool}` with catalog routing and a length budget (all three prefix; route by map like Kuadrant).
3. `tools/list` from the catalog: TTL 0 (agentgateway) vs short TTL (Kuadrant-like); always `private`.
4. Unreachable upstream's tools: hide after strikes (Kuadrant) vs keep listed + fail fast with a clear message.
5. New/changed tools: default-allow (MetaMCP) vs quarantine + diff approval (Gate22/mcp-context-protector, doc 04).
6. Call path: call-time authz, fresh upstream headers, deadline + abort, retry only on safe conditions, three-tier
   errors.
7. Breaker + bulkhead per upstream; dashboard states as in §7.
8. Fan-out style only for health and refresh (parallel, `allSettled`, each with its own deadline), never on the client
   request path.

## Sources
- Kuadrant: [internal/broker/upstream/manager.go](https://github.com/Kuadrant/mcp-gateway/blob/main/internal/broker/upstream/manager.go),
  [validate.go](https://github.com/Kuadrant/mcp-gateway/blob/main/internal/broker/upstream/validate.go),
  [broker.go](https://github.com/Kuadrant/mcp-gateway/blob/main/internal/broker/broker.go),
  [protocol_handler_2026.go](https://github.com/Kuadrant/mcp-gateway/blob/main/internal/broker/protocol_handler_2026.go)
- agentgateway: [mcp/README.md](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/README.md),
  [handler.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/handler.rs),
  [mergestream.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/mergestream.rs)
- MetaMCP: [metamcp-proxy.ts](https://github.com/metatool-ai/metamcp/blob/main/apps/backend/src/lib/metamcp/metamcp-proxy.ts),
  [filter-tools.functional.ts](https://github.com/metatool-ai/metamcp/blob/main/apps/backend/src/lib/metamcp/metamcp-middleware/filter-tools.functional.ts),
  [utils.ts](https://github.com/metatool-ai/metamcp/blob/main/apps/backend/src/lib/metamcp/utils.ts)
