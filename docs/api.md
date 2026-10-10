# Gateway admin API (served by `packages/gateway`, same origin as the dashboard)

All JSON. Session cookie `urumi_session` (HttpOnly, SameSite=Lax, Path=/). Every non-GET request under `/api`
except `POST /api/auth/login` must send header `x-csrf-token: <csrf>` (value from login or `/api/me`).
Errors: `{ "error": "message" }` with 4xx/5xx. Roles: `admin`, `member`.

## Auth
- `POST /api/auth/login` `{email, password}` → `200 {user, csrf}` + cookie; `401 {error}`.
- `POST /api/auth/logout` → `204`.
- `GET /api/me` → `{user: {id, email, name, role}, csrf}` or `401`.
- `GET /api/info` (no auth) → `{mcpUrl, version, chat: {enabled, model}}`.

## Servers (upstream MCP servers). GET: any user. Writes: admin.
- `GET /api/servers` → `Server[]`:
  `{id, slug, name, url, enabled, status: 'connecting'|'connected'|'unreachable'|'auth_failed'|'disabled',
    era: 'modern'|'legacy'|null, protocolVersion, lastError, statusSince (ISO), timeoutMs, hasCredential,
    authHeader (header name or null), tools: [{name, gatewayName, title?, description?, annotations?, inputSchema}]}`
  (`gatewayName` = `<slug>__<name>`, what MCP clients see).
- `POST /api/servers` `{name, slug, url, authHeader?: string /* e.g. "Authorization" */, credential?: string
  /* full header value, e.g. "Bearer xyz" */, timeoutMs?: number}` → `201 Server`.
  slug: `^[a-z][a-z0-9-]{1,30}$`, unique.
- `PATCH /api/servers/:id` any of `{name, url, enabled, authHeader, credential, timeoutMs}` → `Server`.
  `credential: ""` clears it.
- `DELETE /api/servers/:id` → `204`.
- `GET /api/servers/:id/events` → `[{at, status, error}]` (status history, newest first, max 50).

## Members. GET: any user. Writes: admin.
- `GET /api/members` → `[{id, email, name, role, disabled, createdAt}]`.
- `POST /api/members` `{email, name, role}` → `201 {member, password}` (temporary password, shown once).
- `PATCH /api/members/:id` `{role?, disabled?, name?}` → member. (Disabling also revokes the user's keys.)
- `DELETE /api/members/:id` → `204`.

## API keys (for MCP clients: `Authorization: Bearer urumi_...`)
- `GET /api/keys` → own keys; admin with `?all=1` gets everyone's:
  `[{id, name, prefix, userId, userEmail, createdAt, lastUsedAt, revokedAt}]`.
- `POST /api/keys` `{name}` → `201 {key: <same shape>, secret: "urumi_..."}` (secret shown once).
- `DELETE /api/keys/:id` → `204` (revokes; owner or admin). Open MCP listen streams of that key are closed.

## Audit log. Members see their own rows; admins see all.
- `GET /api/audit?limit=100&before=<id>&user=<email>&server=<slug>&outcome=<o>` →
  `{items: [{id, at, userEmail, via /* "key:<name>" | "chat" */, server, tool, durationMs,
    outcome: 'ok'|'tool_error'|'denied'|'unknown_tool'|'disabled'|'unreachable'|'timeout'|'upstream_auth'|'error',
    error, era, client}], nextBefore}`.

## Chat
- `POST /api/chat` — AI SDK UI message stream protocol (`useChat` with `DefaultChatTransport({api: '/api/chat',
  headers: {'x-csrf-token': csrf}})`). Body `{messages: UIMessage[]}`. Tools whose MCP annotations are not
  `readOnlyHint: true` need user approval (tool parts arrive in state `approval-requested`; the UI answers with
  `addToolApprovalResponse({id, approved})` and the chat resubmits). The agent calls tools through the gateway's own
  `/mcp` as the logged-in user (delegated short-lived JWT), so every call lands in the audit log under that user.

## MCP
- `POST|GET /mcp` — the aggregated MCP endpoint (both protocol eras). `Authorization: Bearer urumi_...`.
