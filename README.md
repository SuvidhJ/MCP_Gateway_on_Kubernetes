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
| `packages/dashboard` | built into the gateway image | Vite + React 19 SPA: servers (and hosted servers), stores, members, API keys, audit log, chat, account (password, connected OAuth apps). |
| `packages/demo-upstream` | Deployment `demo-upstream` | A tiny MCP server we own (`echo`, `current_time`, `slow_task`): the one we kill and time out in the demo. |
| `packages/provisioner` | Deployment `provisioner` | Creates stores and hosted MCP servers, each in its own namespace, and registers them in the gateway. No ingress; Kubernetes writes confined by an admission policy. |
| `images/wordpress` | Deployment `wordpress` + Job `store-bootstrap` | Immutable WordPress 7.1.3 + WooCommerce 11.2.0 + wp-cli image; an idempotent bootstrap Job configures the shop. |
| `charts/urumi` | Helm chart | Everything above + MariaDB, Postgres, Secrets (generated, kept across upgrades), Ingress, NetworkPolicies, RBAC. |

Docs: [system design and tradeoffs](docs/design.md) · [threat model](docs/threat-model.md) · [admin API](docs/api.md)

## Local setup (k3d)

Needs Docker, [k3d](https://k3d.io) ≥ 5.9, Helm ≥ 3.18 (tested with 4.3.0), kubectl, bash (Git Bash on Windows), Node 24
only for the check scripts. Optional: [Ollama](https://ollama.com) with a tool-calling model for the chat agent.

```bash
bash scripts/up.sh            # creates k3d cluster "urumi-dev", builds + imports images, helm install, prints logins
bash scripts/demo-check.sh    # scripted Definition-of-Done check (37 checks, ~80 s; --no-chat skips the LLM)
```

`up.sh` prints the generated admin passwords. Re-read them any time:

```bash
kubectl -n urumi get secret gateway-app -o jsonpath='{.data.admin-password}' | base64 -d   # dashboard: admin@urumi.local
kubectl -n urumi get secret store-app   -o jsonpath='{.data.admin-password}' | base64 -d   # WordPress: admin
```

**Uninstall:** delete provisioned stores and hosted servers first (dashboard, or
`kubectl delete ns -l urumi.ai/managed-by=urumi-provisioner`): their namespaces belong to the provisioner, not to the
Helm release. Then `helm uninstall urumi -n urumi` (the generated Secrets are kept on purpose: `helm.sh/resource-policy:
keep`; delete them too for a clean slate).

**Local domains:** `*.127.0.0.1.nip.io` (public wildcard DNS that answers 127.0.0.1) on port 8080, which k3d maps to
Traefik's port 80. No hosts-file edits; works in browsers *and* in Node (`*.localhost` does not resolve in Node).
- Dashboard + MCP: http://gateway.127.0.0.1.nip.io:8080 (MCP endpoint `/mcp`)
- Store: http://store.127.0.0.1.nip.io:8080/shop/ (admin at `/wp-admin/`)

**Chat model:** by default the gateway calls Ollama on the host at `http://host.k3d.internal:11434/v1` with model
`qwen3.5-agent` (Qwen 3.5 9B with an 8 K context; `ollama create qwen3.5-agent -f Modelfile` with
`FROM qwen3.5:9b` / `PARAMETER num_ctx 8192`). Any OpenAI-compatible endpoint works:
`--set gateway.llm.baseUrl=... --set gateway.llm.model=... --set gateway.llm.apiKey=...` (the key goes into the
`gateway-app` Secret, never into the image or the browser). `model` may be a comma-separated list: each step tries
the models in order and moves on when one fails (503/429) or sends nothing within `LLM_FIRST_CHUNK_MS` (20 s), which
keeps the chat usable on overloaded free tiers (the VPS values list four Gemini models).

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

**OAuth instead of a key:** clients that support MCP OAuth connect with just the URL and a browser sign-in
(`claude mcp add --transport http urumi http://localhost:8080/mcp`, then `/mcp` → *Authenticate* in Claude Code).
Locally use `http://localhost:8080`: OAuth clients only accept plain-HTTP sign-in on loopback (production is https).
The app then shows under *Account → Connected apps*, where it can be revoked.

**Chat agent:** dashboard → *Chat*. Read-only tools run directly; anything not marked `readOnlyHint` (create product,
update order status) shows an approval card first. Every call goes through `/mcp` as you and lands in the audit log
with `via = chat`.

**Servers:** *Servers* → add by URL with an optional header credential (e.g. `Authorization: Bearer …`), edit,
disable/enable, remove; live status (Connected / Unreachable / auth failed / Disabled) with history and the tool list.
Admins can also **deploy an MCP server from a container image** (*Servers → Hosted MCP servers → Deploy from image*).

**Stores:** *Stores → New store* (any user, up to 3 each): a whole WooCommerce store in its own namespace at
`http://<slug>.127.0.0.1.nip.io:8080`, its MCP server registered automatically as `<slug>__…` tools (about a minute).
Ask the chat e.g. "compare today's orders in the Urumi store and Shop B". Deleting a store removes its namespace,
volumes, Secrets, Ingress and tools.

## Tests

| Suite | What | Run |
|---|---|---|
| unit (vitest) | gateway, woo-mcp, provisioner pure logic (names, SSRF, OAuth redirect rules, manifests, …) | `npm test` |
| `scripts/demo-check.sh` | the Definition of Done, two users, chat with approval, external client, revoke/disable/kill pod, audit | 37 checks |
| `scripts/attack-check.sh` | authentication, what members can't do, input validation, secret exposure, MCP guards, rug pulls, failure modes | 83 checks |
| `scripts/oauth-check.mjs` | OAuth with the MCP SDK client: discovery, DCR, CIMD (as Claude Code), PKCE, rotation, replay, revocation | 49 checks (`ADMIN_PASSWORD=… node scripts/oauth-check.mjs`) |
| `scripts/provision-check.sh` | stores + hosted servers: parallel, idempotent, quotas, isolation, failures, recovery, teardown, chat across stores | |
| `scripts/ui-check.mjs` | headless browser over every dashboard page (screenshots, no console errors) | `UI_CHAT=1` adds the chat |

## Production-like VPS (k3s)

Same chart, different values ([`charts/urumi/values-prod.yaml`](charts/urumi/values-prod.yaml)). On a fresh Ubuntu VM
(tested on Azure, 2 vCPU / 4 GB) one script does it all: k3s, images built on the VM, cert-manager with a Let's
Encrypt issuer, `helm upgrade --install` with `values-prod.yaml`:

```bash
# DNS first: gateway.<domain>, store.<domain> and *.<domain> -> the VM (e.g. a free DuckDNS name resolves all three)
read -rs LLM_API_KEY && export LLM_API_KEY          # e.g. a Gemini API key (Google AI Studio); kept in a Secret
DOMAIN=<name>.duckdns.org EMAIL=<you@example.com> bash scripts/vps-up.sh
```

By hand, the same steps:

```bash
curl -sfL https://get.k3s.io | sh -                       # single node; bundles Traefik + local-path storage
# push the five images (wordpress, woo-mcp, demo-upstream, gateway, provisioner) to a registry, or build them on the VPS
# and `k3s ctr images import` them; point DNS A records store.<domain> and gateway.<domain> at the VPS, plus a
# wildcard *.<domain> (or one record per store slug) for provisioned stores
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
- Probes (readiness checks the database where it matters), CPU + memory requests and limits on every container; all non-root, read-only root FS, dropped capabilities.
- Secrets: generated in-cluster (`store-db`, `store-app`, `gateway-db`, `gateway-app`), referenced via `secretKeyRef`.
- woo-mcp internal only: no Ingress, NetworkPolicy `upstreams-from-gateway-only`, and it requires a bearer token only the gateway has.
- Name collisions: `<server-slug>__<tool>` namespacing (see design note).
- Timeouts + dead upstream: per-server timeout, clear `isError` results, health loop + EndpointSlice watch.
- Upstream credentials never leave the gateway: the API returns only `hasCredential`.
- Roles admin/member; per-user API keys, revocable, stored as HMAC-SHA256 with a pepper; audit log in the dashboard (refused calls too).
- Chat agent acts as the user via a 10-minute delegated JWT (`sub` = user, `act` = chat-agent).

## Bonus and stand-outs attempted

- **Bonus: multi-store provisioning** — *Stores* page; `packages/provisioner`, `charts/urumi/templates/provisioner.yaml`.
  Each store: own namespace (Pod Security `restricted`), MariaDB + PVC, WordPress + uploads PVC, Secrets, Ingress host,
  bootstrap Job, woo-mcp; ResourceQuota + LimitRange; default-deny NetworkPolicies (its MCP server reaches only its
  own WordPress; only the gateway reaches its MCP server). Status Provisioning / Ready / Failed with the current step
  and failure reason; several in parallel; safe to retry (same request → same store; server-side apply); survives a
  provisioner restart mid-way; per-user cap (3) and installation cap (10); timeout (default 10 min). Deleting
  removes the namespace, volumes, Secrets and its MCP registration. `scripts/provision-check.sh`.
- **OAuth on the gateway** — `packages/gateway/src/oauth.ts`: MCP authorization spec 2026-07-28 (protected resource
  metadata, AS metadata, Client ID Metadata Documents + DCR, PKCE S256, resource indicators, `iss`, rotating
  refresh tokens with reuse detection, revocation, connected apps in the dashboard). `scripts/oauth-check.mjs`.
- **Hosted MCP servers** — add a server by container image: own namespace, Secret (secret env), limits, NetworkPolicy
  (ingress from the gateway only; egress none or public internet), registered automatically, removed cleanly.
- **Tool permissions** — per tool, *Everyone* / *Admins only* / *Off*: hidden from `tools/list` and rejected (`denied`)
  if called by name; `list_changed` pushed on change. `mcp.ts` (`allowed`), table `tool_policies`.
- **Rug-pull defence** — tool definitions pinned on first sight; a changed definition *or a tool that appears later*
  is quarantined until an admin approves it (*Approve change* / *Approve all changes*). Table `tool_pins`.
- **Security hardening** — SSRF guard on the dialled address + no upstream redirects (`ssrf.ts`, `upstreams.ts`);
  least-privilege RBAC (gateway: read-only EndpointSlices; provisioner: write-only, confined by a
  ValidatingAdmissionPolicy, no Secret reads); **default-deny NetworkPolicies in both directions**; every container
  non-root with a read-only root filesystem (WordPress included: served from the immutable image as uid 33 on :8080);
  upstream credentials encrypted at rest (`sealed.ts`); bearer tokens on our own MCP servers; Host/Origin checks;
  CSP/frame protection; throttled sign-in; temporary passwords; body and result size limits. `scripts/attack-check.sh`.
- **Handling many tools** — `/mcp?tools=search`: `gateway__search_tools` + `gateway__call_tool`, same authz and audit.
- **Scaling** — 2 gateway replicas (LISTEN/NOTIFY for admin changes, revocations, approvals); rate limits per key /
  OAuth grant / chat user in **Postgres token buckets shared by all replicas** (`attack-check.sh` E).
- **Observability** — `/metrics` (port 9091, `networkPolicy.metricsFromNamespaces` to let Prometheus in), per-server
  *Last hour* stats, status history with classified reasons, audit outcomes (`timeout`, `unreachable`, `rejected`, …).
- **Upgrades and rollback** — `helm upgrade` / `helm rollback` verified; secrets kept across upgrades (the LLM key
  too); our own MCP servers' changed tool definitions are reviewed after an upgrade (*Approve all changes*).

Audit and hardening log (every bug found and how it was fixed and tested): `planning/09-audit-and-hardening.md`.
