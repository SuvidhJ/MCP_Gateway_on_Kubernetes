# System design and tradeoffs

## Architecture choices

- **One gateway process serves everything** (`/mcp`, `/api`, `/api/chat`, the static dashboard) on one origin:
  no CORS, a plain `HttpOnly` + `SameSite=Lax` session cookie with a CSRF header, one Deployment to secure.
- **TypeScript on Node 24 with the official MCP TS SDK v2.** Downstream: `createMcpHandler` + a low-level `Server`
  built per request for the calling user, which serves **both protocol eras on one URL** (2026-07-28 modern, e.g.
  Claude Code 2.1.296; 2025-11-25 legacy, e.g. older Inspector/Cursor builds). Upstream: one SDK `Client` per server
  with `versionNegotiation: {mode: 'auto'}`, so we talk to modern upstreams (our woo-mcp, demo-upstream) and legacy
  ones (DeepWiki) alike.
- **Hono** for HTTP: it is fetch-native like `createMcpHandler` (Request → Response), so no adapter glue.
- **Postgres** for users, sessions, keys, servers, status history and the audit log; migrations at start under
  `pg_advisory_lock` (multi-replica safe). **MariaDB** stays the store's own database.
- **Our own WooCommerce MCP server** talks to the **WooCommerce REST API v3** in-cluster (`http://wordpress`) with a
  dedicated WC API key whose WordPress user has a minimal custom role (`mcp_store_agent`: products + orders only).
  Why REST over WP-CLI: it goes through WooCommerce's own validation, hooks and HPOS order storage; it needs no shell
  or shared volume with WordPress; and the API key is revocable in WooCommerce admin. Gotchas handled: WordPress only
  accepts Basic auth when it thinks the request is HTTPS (`X-Forwarded-Proto: https`), REST dates have no offset
  (we use `*_gmt` + `Z` and also report store-local time), WooCommerce has no order status rules (our transition
  policy keeps `completed`/`cancelled`/`refunded` final), `customer_note` is labelled untrusted.
- **Chat agent = a normal MCP client of our own gateway** (AI SDK 7 + `@ai-sdk/mcp`). It connects to `/mcp` with a
  10-minute delegated JWT (`sub` = user, `act` = chat-agent), so authorization and audit see the real user on exactly
  the path Claude Code uses. Write tools (not `readOnlyHint`) need an approval click; approvals are HMAC-signed by
  the server so a client can't forge one. The LLM is any OpenAI-compatible endpoint (local Ollama by default).

## Tool aggregation and routing

- `tools/list` = the union of the cached tool lists of enabled, healthy upstreams, each tool renamed
  **`<server-slug>__<tool>`**, description prefixed with the server name. Slugs are unique, `^[a-z][a-z0-9-]{1,30}$`
  and can't contain `__`, so the split at the first `__` is unambiguous and **two servers exposing the same tool
  name never collide** (`store__list_orders` vs `store2__list_orders`). Lists are cached per upstream (refreshed by
  the health loop every 5 s) and returned with a `private` cache hint (lists are per user).
- `tools/call` splits the name, finds the upstream, checks it is enabled and connected, forwards with the upstream's
  own credential and a per-server timeout, and returns the upstream's result unchanged (content, `structuredContent`,
  `isError`). Unknown tools, disabled/unreachable servers, timeouts and upstream errors become **`isError` results
  with a clear sentence** (a thrown error would reach clients as an opaque `-32603`).
- When the set of tools changes (server added/removed/disabled, upstream died/recovered, upstream tool list changed),
  the gateway pushes `notifications/tools/list_changed` to open `subscriptions/listen` streams (coalesced 100 ms).
  Claude Code refreshes its tool list immediately.

## Failure handling

- **Every upstream has its own non-overlapping health loop**, so a slow server never delays another. Failures are
  classified: *hard* (connection refused, DNS, reset, 502–504, SSRF block) → unreachable at once; *soft* (timeouts)
  → strikes, unreachable after 3; *auth* (401/403) → `auth_failed` (an admin must fix the credential). After a
  failure the loop re-probes fast (250 ms doubling to 5 s), so a restarted pod is back in ~2–4 s.
- **Pod death is seen in ~0.2 s** through a Kubernetes **EndpointSlice watch** (read-only, namespace-scoped Role):
  a 5 s health tick alone never notices a pod that is replaced in 2 s (measured, 07 §14).
- **Connect timeout 2 s** (a SYN dropped during kube-proxy rule changes otherwise hangs ~10 s), **per-call timeout**
  (default 30 s, per server in the dashboard; `slow_task` demonstrates it), a fetch-level deadline under the SDK, and
  no body timeout on long-lived listen streams. SSE responses carry 15 s keep-alives (Node's fetch cuts streams
  after 300 s of silence).
- If an upstream restarted and lost our session (`404` on a known session id), the gateway reconnects and retries
  the call once.
- A server that just became unreachable keeps its tools listed for 15 s (a blip shouldn't churn client tool lists);
  calls during that window get "Server X is unreachable (…). Other servers are unaffected."

## Security model (summary; details in `threat-model.md`)

API keys `urumi_<32 random bytes>` stored as HMAC-SHA256 with a server-side pepper, checked on **every** HTTP request
(revocation is immediate, and revoking a key also closes its open listen streams); scrypt passwords; sessions stored
hashed; Host and Origin checks on `/mcp` (DNS rebinding); SSRF guard on upstream URLs; default-deny NetworkPolicies
so upstream MCP servers accept traffic only from the gateway.

## What changes for production

| Concern | Local (k3d) | VPS (k3s) |
|---|---|---|
| DNS | `*.127.0.0.1.nip.io` | A records `store.<domain>`, `gateway.<domain>` → VPS IP |
| Ingress | k3s Traefik, HTTP on host :8080 | k3s Traefik on :80/:443, `tls.enabled=true` (cert-manager or a TLS Secret), cookie `Secure` |
| Images | built locally, `k3d image import`, tag `:dev` | registry tags, `pullPolicy: IfNotPresent` |
| Storage | `local-path` PVCs (1–2 Gi) | `local-path` or the cloud StorageClass, larger sizes; back up MariaDB + Postgres |
| Secrets | generated by the chart with `lookup` (stable across upgrades) | same, or pre-created / External Secrets; LLM key via `--set` or a pre-created Secret |
| LLM | Ollama on the host GPU | hosted OpenAI-compatible free tier |

Replicas: the chart runs two. Admin intent is shared through Postgres `LISTEN/NOTIFY`; each replica runs its own
health loops (so status can differ for a moment between replicas) and pushes `list_changed` to the listen streams it
holds. Rate limits are per replica (a shared limiter would need Redis or Postgres counters). Upstream credentials are sealed with AES-256-GCM before they reach Postgres (key in the
`gateway-app` Secret), so a DB dump or backup alone doesn't leak them; anyone with both the DB and the Secret can.
