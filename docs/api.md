# Gateway admin API (served by `packages/gateway`, same origin as the dashboard)

All JSON. Session cookie `urumi_session` (HttpOnly, SameSite=Lax, Path=/). Every non-GET request under `/api`
except `POST /api/auth/login` must send header `x-csrf-token: <csrf>` (value from login or `/api/me`).
Errors: `{ "error": "message" }` with 4xx (never a 500 for bad input). Roles: `admin`, `member`.
Body limits: 256 KB (`/api`), 2 MB (`/api/chat`), 4 MB (`/mcp`), 64 KB (`/oauth`); larger bodies get `413` and the
connection is closed.

## Auth
- `POST /api/auth/login` `{email, password}` → `200 {user, csrf}` + cookie; `401` wrong email/password (same answer
  for an unknown email); `429` + `Retry-After` after too many failures (10/min per account, 50/min per address).
- `POST /api/auth/logout` → `204`.
- `GET /api/me` → `{user: {id, email, name, role, mustChangePassword}, csrf}` or `401`.
- `POST /api/auth/password` `{current, password}` → `204` (≥ 10 characters; the user's other sessions end).
  While `mustChangePassword` (an invite or reset password) every other route answers `403`.
- `GET /api/info` (no auth) → `{mcpUrl, version, chat: {enabled, model}}`.

## Servers (upstream MCP servers). GET: any user. Writes: admin.
- `GET /api/servers` → `Server[]`:
  `{id, slug, name, url, enabled, status: 'connecting'|'connected'|'unreachable'|'auth_failed'|'disabled',
    era: 'modern'|'legacy'|null, protocolVersion, lastError, statusSince (ISO), timeoutMs, hasCredential,
    authHeader (header name or null), managed /* registered by the provisioner */,
    tools: [{name, gatewayName, title?, description?, annotations?, inputSchema, access: 'member'|'admin'|'off',
             changed?, change?: 'changed'|'new', approvedDescription?}]}`
  (`gatewayName` = `<slug>__<name>`, what MCP clients see; names are sanitised to `[A-Za-z0-9_-]{1,64}`).
  Members get the URL without userinfo and with query values replaced by `***`.
- `POST /api/servers` `{name, slug, url, authHeader?, credential? /* full header value, e.g. "Bearer xyz" */,
  timeoutMs?}` → `201 Server`. slug `^[a-z][a-z0-9-]{1,30}$`, unique, not reserved; URL http(s) without
  `user:pass@` or `#fragment`; header names the transport owns (`Host`, `Content-Length`, `Mcp-*`, …) and values with
  line breaks are refused (`400`).
- `PATCH /api/servers/:id` any of `{name, url, enabled, authHeader, credential, timeoutMs}` → `Server`.
  `credential: ""` clears it, `timeoutMs: null` resets to the default. Moving a server with a credential to another
  host requires the credential again. Changing the URL resets its pinned tool definitions. Managed servers: only
  `name`, `enabled`, `timeoutMs`.
- `DELETE /api/servers/:id` → `204` (`409` for a managed server: delete its store / hosted server).
- `PUT /api/servers/:id/tools/:tool/access` `{access}` → `Server` (per-tool permission).
- `POST /api/servers/:id/tools/:tool/approve` → `Server` (accept a changed or new tool definition).
- `POST /api/servers/:id/approve-all` → `{approved: string[], server}`.
- `GET /api/servers/:id/events` → `[{at, status, error}]` (status history, newest first, max 50).

## Members. GET: any user. Writes: admin.
- `GET /api/members` → `[{id, email, name, role, disabled, createdAt}]`.
- `POST /api/members` `{email, name, role}` → `201 {member, password}` (temporary: must be changed at first sign-in).
- `PATCH /api/members/:id` `{role?, disabled?, name?}` → member. Disabling revokes the user's keys and OAuth grants
  and ends their sessions.
- `POST /api/members/:id/reset-password` → `{member, password}` (temporary; sessions end).
- `DELETE /api/members/:id` → `204`.

## API keys (for MCP clients: `Authorization: Bearer urumi_...`)
- `GET /api/keys` → own keys; admin with `?all=1` gets everyone's:
  `[{id, name, prefix, userId, userEmail, createdAt, lastUsedAt, revokedAt}]`.
- `POST /api/keys` `{name, userId? /* admins: issue for another member */}` → `201 {key, secret: "urumi_..."}`
  (secret shown once; at most 25 active keys per member).
- `DELETE /api/keys/:id` → `204` (revokes; owner or admin). Open MCP listen streams of that key are closed on every
  replica.

## OAuth connected apps
- `GET /api/oauth/grants` → own grants (`?all=1` for admins):
  `[{id, clientId, clientName, redirectHost, createdAt, lastUsedAt, revokedAt, userEmail, verified}]`.
- `DELETE /api/oauth/grants/:id` → `204` (owner or admin): the app's tokens stop working at once.

## Stores (bonus) — any user, at most 3 each (installation: 10)
- `GET /api/stores` → `Provision[]` (the team's stores):
  `{id, kind: 'store', slug, name, ownerId, ownerEmail, status: 'provisioning'|'ready'|'failed'|'deleting',
    step, reason, namespace, url, timeoutS, attempts, createdAt, startedAt, readyAt, upstreamId}`.
- `POST /api/stores` `{name, slug, timeoutS? /* admins */}` → `201` (or `200` with the existing store when the same
  owner repeats the request: safe to retry); `409` limit reached / slug taken.
- `POST /api/stores/:id/retry` `{timeoutS? /* admins */}` → a failed store provisions again.
- `DELETE /api/stores/:id` → `202` (owner or admin): namespace, volumes, Secrets, Ingress and MCP registration go.

## Hosted MCP servers (stand-out) — admins
- `GET /api/hosted` → `Provision[]` with `spec: {image, port, path, env, egress, secretEnvNames}` (secret values are
  never returned).
- `POST /api/hosted` `{name, slug, image /* pinned tag or digest */, port /* 1024-65535 */, path?, env?: {K: v},
  secretEnv?: {K: v}, egress?: 'none'|'internet', timeoutS?}` → `201`.
- `POST /api/hosted/:id/retry`, `DELETE /api/hosted/:id` as for stores.

## Audit log. Members see their own rows; admins see all.
- `GET /api/audit?limit=100&before=<id>&user=<email>&server=<slug>&outcome=<o>` →
  `{items: [{id, at, userEmail, via /* "key:<name>" | "chat" | "oauth:<client>" */, server, tool, durationMs,
    outcome: 'ok'|'tool_error'|'denied'|'quarantined'|'unknown_tool'|'disabled'|'unreachable'|'timeout'
      |'upstream_auth'|'cancelled'|'too_large'|'rejected'|'error',
    error, era, client}], nextBefore}`.
  `rejected` = a revoked key / disabled user / revoked OAuth grant, attributed to its owner.
- `GET /api/stats` → per-server calls, failures, p50/p95 latency in the last hour.

## Chat
- `POST /api/chat` — AI SDK UI message stream protocol (`useChat` with `DefaultChatTransport({api: '/api/chat',
  headers: {'x-csrf-token': csrf}})`). Body `{messages: UIMessage[]}` (validated; client `system` messages are
  dropped; 20 turns/min per user). Tools whose MCP annotations are not `readOnlyHint: true` need user approval. The
  agent calls tools through the gateway's own `/mcp` as the logged-in user (delegated 10-minute JWT), so every call
  lands in the audit log under that user.

## MCP
- `POST|GET /mcp` — the aggregated MCP endpoint (both protocol eras). `Authorization: Bearer urumi_...` (API key) or
  `Bearer uat_...` (OAuth access token). `/mcp?tools=search` = the two meta-tools (`gateway__search_tools`,
  `gateway__call_tool`). 120 requests/min per key or grant (burst 40), shared by all replicas.

## OAuth (MCP authorization spec 2026-07-28)
- `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728), `GET /.well-known/oauth-authorization-server`
  (RFC 8414): issuer = the origin the request came in on (`PUBLIC_URL`, or an `EXTRA_ORIGINS` entry such as
  `http://localhost:8080` locally).
- `POST /oauth/register` (RFC 7591, public clients), `GET|POST /oauth/authorize` (login + consent; PKCE S256
  required; `resource` per RFC 8707; `iss` in the redirect per RFC 9207), `POST /oauth/token`
  (`authorization_code`, `refresh_token` with rotation and reuse detection), `POST /oauth/revoke` (RFC 7009).
  Client ID Metadata Documents: an `https://…` `client_id` is fetched (SSRF-guarded, ≤ 64 KB, cached).
