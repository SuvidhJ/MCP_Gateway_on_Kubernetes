# Urumi MCP Gateway on Kubernetes

A WooCommerce store, our own WooCommerce MCP server, and an **MCP gateway with a team dashboard and chat agent**, all
on Kubernetes and installed with one Helm chart.

```
                 ┌──────────────────────── k8s namespace "urumi" (default-deny NetworkPolicies) ─────────────────────────┐
 browser ──┐     │                                                                                                         │
 Claude    │  Traefik   ┌──────────────── gateway (one Deployment, one port) ───────────────┐      ┌──────────┐         │
 Code /    ├─ Ingress ─▶│ /mcp   aggregated MCP endpoint (2026-07-28 + 2025 eras, one URL)   │─────▶│ woo-mcp  │──REST──▶ WordPress + WooCommerce ── MariaDB
 Inspector │  gateway.* │ /api   dashboard REST API (session cookie + CSRF)                  │      └──────────┘         │      (PVC)               (PVC)
           │            │ /api/chat  chat agent (AI SDK 7) → calls our own /mcp as the user  │─────▶ demo-upstream         │
           │            │ /*     React dashboard (static)                                    │─────▶ DeepWiki (public, internet)
           │            └──────────────┬───────────────────────────────────┬────────────────┘                             │
           │                           │ Postgres (users, keys, servers,   │ EndpointSlice watch (read-only Role)         │
           │                           ▼  audit log)  PVC                   ▼ = pod-death detection in ~0.2 s             │
           └─ Ingress store.* ─▶ WordPress storefront                                                                   │
                 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
 LLM: any OpenAI-compatible endpoint (local: Ollama on the host GPU via host.k3d.internal; prod: a hosted free tier).
```

| Component | Where | What |
|---|---|---|
| `packages/woo-mcp` | Deployment `woo-mcp` | Our WooCommerce MCP server (TypeScript, MCP TS SDK v2): `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status`. Internal only. |
| `packages/gateway` | Deployment `gateway` | MCP aggregation + routing, upstream health, auth (users, roles, API keys, sessions), audit log, admin API, chat agent backend, serves the dashboard. |
| `packages/dashboard` | built into the gateway image | Vite + React 19 SPA: servers, members, API keys, audit log, chat. |
| `packages/demo-upstream` | Deployment `demo-upstream` | A tiny MCP server we own (`echo`, `current_time`, `slow_task`): the one we kill and time out in the demo. |
| `images/wordpress` | Deployment `wordpress` + Job `store-bootstrap` | Immutable WordPress 7.1.3 + WooCommerce 11.2.0 + wp-cli image; an idempotent bootstrap Job configures the shop. |
| `charts/urumi` | Helm chart | Everything above + MariaDB, Postgres, Secrets (generated, kept across upgrades), Ingress, NetworkPolicies, RBAC. |

Docs: [system design and tradeoffs](docs/design.md) · [threat model](docs/threat-model.md) · [admin API](docs/api.md)

## Local setup (k3d)

Needs Docker, [k3d](https://k3d.io) ≥ 5.9, Helm ≥ 3.18 (tested with 4.3.0), kubectl, bash (Git Bash on Windows), Node 24
only for the check scripts. Optional: [Ollama](https://ollama.com) with a tool-calling model for the chat agent.

```bash
bash scripts/up.sh            # creates k3d cluster "urumi-dev", builds + imports images, helm install, prints logins
bash scripts/demo-check.sh    # scripted Definition-of-Done check (23 checks, ~25 s)
```

`up.sh` prints the generated admin passwords. Re-read them any time:

```bash
kubectl -n urumi get secret gateway-app -o jsonpath='{.data.admin-password}' | base64 -d   # dashboard: admin@urumi.local
kubectl -n urumi get secret store-app   -o jsonpath='{.data.admin-password}' | base64 -d   # WordPress: admin
```

**Local domains:** `*.127.0.0.1.nip.io` (public wildcard DNS that answers 127.0.0.1) on port 8080, which k3d maps to
Traefik's port 80. No hosts-file edits; works in browsers *and* in Node (`*.localhost` does not resolve in Node).
- Dashboard + MCP: http://gateway.127.0.0.1.nip.io:8080 (MCP endpoint `/mcp`)
- Store: http://store.127.0.0.1.nip.io:8080/shop/ (admin at `/wp-admin/`)

**Chat model:** by default the gateway calls Ollama on the host at `http://host.k3d.internal:11434/v1` with model
`qwen3.5-agent` (Qwen 3.5 9B with an 8 K context; `ollama create qwen3.5-agent -f Modelfile` with
`FROM qwen3.5:9b` / `PARAMETER num_ctx 8192`). Any OpenAI-compatible endpoint works:
`--set gateway.llm.baseUrl=... --set gateway.llm.model=... --set gateway.llm.apiKey=...` (the key goes into the
`gateway-app` Secret, never into the image or the browser).

## Using it

**Place an order:** open the store, add a product to the cart, check out with *Cash on delivery* (enabled by the
bootstrap, with a free-shipping zone). The order is in WooCommerce admin under *WooCommerce → Orders*.

**Team:** log in to the dashboard as admin → *Members* → invite a member (a one-time password is shown once). Each
user creates their own API key under *API keys* (the secret is shown once; only an HMAC of it is stored).

**Connect an external MCP client** with only the gateway URL and your key:

```bash
claude mcp add --transport http urumi http://gateway.127.0.0.1.nip.io:8080/mcp --header "Authorization: Bearer urumi_..."
# or MCP Inspector:  npx @modelcontextprotocol/inspector  → Streamable HTTP, URL above, header Authorization
# or the bundled checker:
node scripts/mcp-call.mjs http://gateway.127.0.0.1.nip.io:8080/mcp --list '{}' urumi_...
```

Tools appear as `<server>__<tool>`, e.g. `store__list_orders`, `deepwiki__ask_wiki_question`, `demo__current_time`.
Verified with Claude Code 2.1.296 (modern era) and 2025-era clients (`MODE=legacy node scripts/mcp-call.mjs ...`).

**Chat agent:** dashboard → *Chat*. Read-only tools run directly; anything not marked `readOnlyHint` (create product,
update order status) shows an approval card first. Every call goes through `/mcp` as you and lands in the audit log
with `via = chat`.

**Servers:** *Servers* → add by URL with an optional header credential (e.g. `Authorization: Bearer …`), edit,
disable/enable, remove; live status (Connected / Unreachable / auth failed / Disabled) with history and the tool list.

## Production-like VPS (k3s)

Same chart, different values ([`charts/urumi/values-prod.yaml`](charts/urumi/values-prod.yaml)):

```bash
curl -sfL https://get.k3s.io | sh -                       # single node; bundles Traefik + local-path storage
# push the four images to a registry (or `k3s ctr images import`), point DNS A records store.<domain>, gateway.<domain> at the VPS
kubectl create namespace urumi
kubectl -n urumi create secret tls urumi-tls --cert=fullchain.pem --key=privkey.pem   # or cert-manager
helm upgrade --install urumi charts/urumi -n urumi -f charts/urumi/values-prod.yaml \
  --set baseDomain=<domain> --set gateway.llm.apiKey=<hosted LLM key>
```

What changes through values: `baseDomain`/`publicPort` (URLs, Ingress hosts, WordPress home URL, cookie `Secure`),
`tls.*`, `images.*` (registry tags instead of locally imported `:dev`), storage sizes (default StorageClass:
`local-path` on k3s), `gateway.llm.*` (hosted OpenAI-compatible provider), `networkPolicy.ingress*` (where the ingress
controller lives). Secrets are generated on first install with `lookup` and kept across upgrades
(`helm.sh/resource-policy: keep`); nothing secret is in the repo or the images.

**Upgrade / rollback:** `helm upgrade urumi charts/urumi -f values-prod.yaml --set images.gateway=<new tag>`;
`helm rollback urumi <revision>`. Gateway schema migrations run at start under `pg_advisory_lock` and are additive;
the store bootstrap Job is idempotent and re-runs on every upgrade; WordPress/WooCommerce versions are baked into the
image, so a store upgrade is an image tag change (back up MariaDB first: plugin DB migrations are one-way).

## Requirements checklist (where to look)

- Helm only, local + prod values: `charts/urumi/values{,-local,-prod}.yaml`.
- Persistence: PVCs for MariaDB, WordPress content, Postgres.
- Probes, requests and limits on every Deployment; non-root, read-only root FS, dropped capabilities for our Node services.
- Secrets: generated in-cluster (`store-db`, `store-app`, `gateway-db`, `gateway-app`), referenced via `secretKeyRef`.
- woo-mcp internal only: no Ingress, and NetworkPolicy `upstreams-from-gateway-only`.
- Name collisions: `<server-slug>__<tool>` namespacing (see design note).
- Timeouts + dead upstream: per-server timeout, clear `isError` results, health loop + EndpointSlice watch.
- Upstream credentials never leave the gateway: the API returns only `hasCredential`.
- Roles admin/member; per-user API keys, revocable, stored as HMAC-SHA256 with a pepper; audit log in the dashboard.
- Chat agent acts as the user via a 10-minute delegated JWT (`sub` = user, `act` = chat-agent).

## Stand-outs attempted

- **Tool permissions (S-2):** per tool, *Everyone* / *Admins only* / *Off* (dashboard → Servers → expand a server →
  Access). Restricted tools are hidden from `tools/list` and rejected (`denied` in the audit log) if called by name;
  clients get a `list_changed` push when a rule changes. Code: `packages/gateway/src/mcp.ts` (`allowed`),
  `upstreams.ts` (`setAccess`), table `tool_policies`. Checked by `demo-check.sh` step 5b.

- **Security hardening (partial):** SSRF guard on upstream connections (checks the address actually dialled, blocks
  private/metadata ranges, admin allow-list for in-cluster names) — `packages/gateway/src/ssrf.ts`; least-privilege
  RBAC (read-only EndpointSlice Role) — `charts/urumi/templates/gateway.yaml`; default-deny NetworkPolicies —
  `charts/urumi/templates/networkpolicies.yaml`; non-root containers; Host/Origin checks on `/mcp`; signed tool
  approvals in the chat (a client can't forge an approval); **upstream credentials encrypted at rest** (AES-256-GCM,
  key in the `gateway-app` Secret; the DB holds only `v1.<iv>.<tag>.<ciphertext>`) — `packages/gateway/src/sealed.ts`.
- **Observability (partial):** upstream status history with the classified reason (refused / timeout / auth),
  structured JSON logs, audit outcomes (`timeout`, `unreachable`, `upstream_auth`, `tool_error`, …).
