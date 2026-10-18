# System design and tradeoffs

The audit and hardening pass (bug log, test suites) is in `docs/audit-and-hardening.md`.

## Architecture choices

```
 clients ─▶ Traefik ─▶ gateway (2 replicas) ──────▶ woo-mcp ─▶ WordPress ─▶ MariaDB        (namespace urumi)
                        │ /mcp /api /oauth /         demo-upstream, DeepWiki (internet)
                        │ dashboard (static)
                        ├─▶ Postgres ◀── provisioner (1, leader-locked) ──▶ Kubernetes API
                        └─▶ store-<slug>/woo-mcp, mcp-<slug>/mcp       (namespaces the provisioner owns)
```

- **One gateway process serves everything** (`/mcp`, `/api`, `/api/chat`, `/oauth`, `/.well-known`, the static
  dashboard) on one origin: no CORS for the dashboard, a plain `HttpOnly` + `SameSite=Lax` session cookie with a
  CSRF header, one Deployment to secure. It holds **no Kubernetes write access**.
- **TypeScript on Node 24 with the official MCP TS SDK v2.** Downstream: `createMcpHandler` + a low-level `Server`
  built per request for the calling user, which serves **both protocol eras on one URL** (2026-07-28 modern, e.g.
  Claude Code; 2025-11-25 legacy). Upstream: one SDK `Client` per server with `versionNegotiation: {mode: 'auto'}`,
  so we talk to modern upstreams (woo-mcp, demo-upstream) and legacy ones (DeepWiki) alike.
- **Hono** for HTTP: fetch-native like `createMcpHandler` (Request → Response), so no adapter glue.
- **Postgres** for users, sessions, keys, OAuth grants, servers, status history, rate-limit buckets, provisioning
  state and the audit log; migrations at start under `pg_advisory_lock` (multi-replica safe). **MariaDB** stays each
  store's own database.
- **Our own WooCommerce MCP server** talks to the **WooCommerce REST API v3** in-cluster (`http://wordpress`) with a
  dedicated WC API key whose WordPress user has a minimal custom role (`mcp_store_agent`: products + orders only).
  Why REST over WP-CLI: it goes through WooCommerce's own validation, hooks and HPOS order storage; it needs no shell
  or shared volume with WordPress; and the API key is revocable in WooCommerce admin. Gotchas handled: WordPress only
  accepts Basic auth when it thinks the request is HTTPS (`X-Forwarded-Proto: https`), REST dates have no offset
  (we use `*_gmt` + `Z` and also report store-local time), WooCommerce has no order status rules (our transition
  policy keeps `completed`/`cancelled`/`refunded` final), buyer-written fields are labelled untrusted, list tools
  page (`page`/`pages`). It requires a bearer token from a Secret (defence in depth next to the NetworkPolicy).
- **Chat agent = a normal MCP client of our own gateway** (AI SDK 7 + `@ai-sdk/mcp`). It connects to `/mcp` with a
  10-minute delegated JWT (`sub` = user, `act` = chat-agent), so authorization and audit see the real user on exactly
  the path Claude Code uses. Write tools (not `readOnlyHint`) need an approval click; approvals are HMAC-signed by
  the server so a client can't forge one. The LLM is any OpenAI-compatible endpoint (local Ollama by default).
- **Provisioning is a separate component** (`packages/provisioner`), not part of the internet-facing gateway. The
  gateway API only writes desired state (`provisions` table) and wakes it (`pg_notify`); the provisioner applies it
  with **server-side apply** (idempotent: a retried or resumed run converges), reports `status`/`step`/`reason` back
  in the same row, and registers the new MCP server as a *managed* upstream (URL and credential not editable via the
  API). One leader at a time (a Postgres advisory lock held on its own connection), so a crash, rollout or node drain
  mid-way just means the next leader picks up the row and re-applies from the top.

## Tool aggregation and routing

- `tools/list` = the union of the cached tool lists of enabled, healthy upstreams, each tool renamed
  **`<server-slug>__<tool>`** (the tool part sanitised to `[A-Za-z0-9_-]`, ≤ 64 chars, collision-suffixed),
  description prefixed with the server name. Slugs are unique, `^[a-z][a-z0-9-]{1,30}$`, can't contain `__`, and
  share one namespace with stores and hosted servers, so **two servers exposing the same tool name never collide**
  (`store__list_orders` vs `shop2__list_orders`: the store a tool acts on is in its name). Filtered per user (tool
  permissions) and returned with a `private` cache hint.
- `tools/call` resolves the name through the per-upstream name map, checks quarantine, permission, enabled and
  status, forwards with the upstream's own credential and a per-server timeout, and returns the result unchanged
  (content, `structuredContent`, `isError`) up to 2 MB. Unknown tools, disabled/unreachable servers, timeouts,
  oversized results and upstream errors become **`isError` results with a clear sentence**; a client cancellation is
  audited `cancelled` and doesn't count against the upstream.
- When the set of tools changes the gateway pushes `notifications/tools/list_changed` to open listen streams
  (coalesced 100 ms); other replicas learn about admin changes over Postgres `LISTEN/NOTIFY`.
- **Many tools:** `/mcp?tools=search` exposes `gateway__search_tools` + `gateway__call_tool` instead of every tool,
  with identical authorization, routing and audit.

## Failure handling

- **Every upstream has its own non-overlapping health loop.** Failures are classified: *hard* (refused, DNS, reset,
  502–504, SSRF block, refused redirect) → unreachable at once; *soft* (timeouts) → strikes, unreachable after 3;
  *auth* (401/403, or a stored credential that can't be decrypted) → `auth_failed`. After a failure the loop
  re-probes fast (250 ms doubling to 5 s). Connects are single-flight and generation-checked, so an admin's URL or
  credential edit can never be overwritten by a connect that started before it.
- **Pod death is seen in ~0.2 s** through **EndpointSlice watches**: one per namespace that holds an upstream (the
  release namespace via the chart's Role; each store / hosted namespace via a RoleBinding the provisioner creates).
- **Timeouts:** 2 s connect in-cluster (5 s for internet hosts: TLS on slow links), per-call timeout (default 30 s,
  per server), a fetch-level deadline under the SDK, no body timeout on listen streams, 15 s SSE keep-alives.
- `404` on a known upstream session → reconnect and retry once.
- **Provisioning fails cleanly:** a store or hosted server that can't come up is marked `failed` with the reason
  (image can't be pulled, container keeps crashing, quota or Pod Security refused the pod, bootstrap Job failed, or
  "timed out after N s while <step>"); Retry starts again, Delete tears down whatever exists.

## Identity, OAuth and rate limits

- API keys `urumi_<24 random bytes>` stored as peppered HMAC-SHA256, checked on every request; scrypt passwords;
  server-side sessions stored hashed; invite/reset passwords are temporary (forced change); failed sign-ins are
  budgeted per account and per address.
- **OAuth 2.1 per the MCP authorization spec:** the gateway is the resource server *and* the authorization server.
  Protected Resource Metadata + a `resource_metadata` challenge on 401, AS metadata, Client ID Metadata Documents
  (fetched SSRF-guarded) and Dynamic Client Registration, PKCE S256 only, exact redirect matching (any port on
  loopback), `resource` audience checks, `iss` in the response, opaque 1 h access tokens and 30-day rotating refresh
  tokens with reuse detection (a replayed refresh token or code revokes the whole grant). A grant acts as its user
  exactly like a key (`via = oauth:<client>`). Locally the gateway also answers as `http://localhost:8080`, because
  OAuth clients only allow plain-HTTP authorization servers on loopback.
- **Rate limits** are token buckets in Postgres (one atomic upsert per request), so the limit per key / grant / chat
  user holds across replicas.

## What changes for production

| Concern | Local (k3d) | VPS (k3s) |
|---|---|---|
| DNS | `*.127.0.0.1.nip.io` (stores get `<slug>.127.0.0.1.nip.io`) | A records (or a wildcard) for `store.`, `gateway.` and each store slug under the domain |
| Ingress / TLS | k3s Traefik, HTTP on host :8080 | Traefik on :443, `tls.enabled=true`, `tls.clusterIssuer` (cert-manager issues one certificate per host, stores included), cookie `Secure`, HSTS |
| OAuth origins | `PUBLIC_URL` + `http://localhost:8080` | the https origin only |
| Images | built locally, `k3d image import`, tag `:dev` | registry tags, `pullPolicy: IfNotPresent`; restrict hosted images with `provisioning.hostedImagePrefixes` |
| Storage | `local-path` PVCs | `local-path` or the cloud StorageClass, larger sizes; back up MariaDB + Postgres |
| Secrets | generated by the chart with `lookup` (stable across upgrades) | same, or pre-created / External Secrets; LLM key via `--set` once (kept on later upgrades) |
| Network | API server on the k3d node (`apiServer.cidr: 0.0.0.0/0`, ports 443/6443) | narrow `networkPolicy.apiServer.cidr` to the node address |
| LLM | Ollama on the host GPU (egress rule for :11434) | hosted OpenAI-compatible free tier (public egress) |

**Upgrades.** `helm upgrade` re-runs the idempotent store bootstrap; gateway migrations are additive. When an
upgrade changes our own MCP servers' tool definitions (new parameters), the rug-pull defence quarantines them until an
admin approves the new definitions (Servers → *Approve all changes*): that review is part of the upgrade.
Upstream credentials are sealed with AES-256-GCM before they reach Postgres (key in the `gateway-app` Secret); a key
that no longer matches marks those servers `auth_failed` instead of crashing the gateway.
