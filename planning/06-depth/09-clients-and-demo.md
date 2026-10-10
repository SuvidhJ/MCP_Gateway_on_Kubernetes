# 06·09 — The Demo Clients and the Definition of Done, Step by Step

Written 2026-10-10. Client versions today:
- **Claude Code 2.1.295** (npm `@anthropic-ai/claude-code`);
- **MCP Inspector 2.10.1** (2026-10-08);
- Cursor (version not published on npm; config docs at cursor.com/docs/context/mcp).

Behaviour quotes are from the Claude Code MCP docs, the Cursor docs, the Inspector repo docs, and the forum and issues
cited.

---

## 1. Client matrix for "user B" (only the gateway URL + B's API key)

| | Claude Code | MCP Inspector (CLI/web) | Cursor |
|---|---|---|---|
| Add server | `claude mcp add -t http urumi https://gw.example/mcp -H "Authorization: Bearer $URUMI_KEY"` (scopes: `local` default → `~/.claude.json` per project; `project` → `.mcp.json`; `user` → `~/.claude.json` global) | `npx @modelcontextprotocol/inspector@2.10.1 --cli --transport http --server-url https://gw.example/mcp --header "Authorization: Bearer $URUMI_KEY" --method tools/list` | `.cursor/mcp.json` or `~/.cursor/mcp.json`: `{"mcpServers":{"urumi":{"url":"https://gw.example/mcp","headers":{"Authorization":"Bearer ${env:URUMI_KEY}"}}}}` |
| Env expansion | `${VAR}`, `${VAR:-default}` in `url`/`headers` (credential vars like `ANTHROPIC_API_KEY` read as empty there) | `--header` flag; catalog file | `${env:NAME}`, `${userHome}`, `${workspaceFolder}` |
| Era | `MCP_PROTOCOL_NEGOTIATION=auto` (default) negotiates modern; `MCP_SDK_GENERATION` auto = SDK v2 since 2.1.274 | `--protocol-era legacy\|auto\|modern` (lets us test **both** eras of the gateway) | not documented → treat as legacy-capable; our dual-era endpoint covers it |
| Bad/revoked key | "a `401` or `403` while connecting doesn't flag the server … Claude Code reports the connection as failed **instead of falling back to OAuth**" (static `Authorization` configured) | exit code **3** ("Server requires authentication (401/403…)") | unknown → test |
| Tool names | `mcp__urumi__<exposed>`; non-alphanumerics except `-` become `_`; ≤ 64 total (06·03 §3) | raw | server+tool ≤ 60 chars (doc 05) |
| Change notifications | interactive: refetches on `list_changed`. On the v2 runtime via a persistent stream: if it closes within 10 s, reopened up to 3×; if after 10+ s, up to 5×/hour then ~6 h wait; "Until the stream reopens, you keep the server's last fetched tools … reconnect the server from `/mcp`" | re-run `tools/list` | unknown |
| Timeouts | per-server `"timeout"` in `.mcp.json`; `MCP_TOOL_TIMEOUT` (default ~28 h); `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` **5 min** for HTTP; `MAX_MCP_OUTPUT_TOKENS` 25,000 | `--connect-timeout` 15 s default | — |
| Useful commands | `/mcp` (status: ✔ Connected / ! Needs authentication / ✘ Failed), `/mcp reconnect all` | `--format json`, `--strict` (schema portability, exit 6) | Output panel → "MCP Logs" |
| Known risks | open bugs (doc 05): #88128 (missing cache hints; our SDK v2 server always sends them, 06·02), #97369 (stale definitions, so call-time checks matter), #95504 (root `allOf` drops tools) | — | forum 2026-08-20: custom headers **dropped on `tools/call`** (unresolved; Authorization not confirmed either way). **Prefer Claude Code or Inspector for user B**; test Cursor before showing it |

---

## 2. The definition of done, mapped to mechanics and assertions

The brief's list, verbatim headings. For each step: what happens inside, which doc explains it, and how a script
proves it.

### Store
**"Open the storefront, add a product to the cart and check out with a test-friendly method (COD…). Confirm the order
is visible in WooCommerce admin."**
- Needs (06·04 §5):
  - `woocommerce_coming_soon = no`;
  - COD enabled;
  - a shipping method on zone 0, or virtual products;
  - block checkout pages exist;
  - `WP_HOME` equals the Ingress hostname.
- The order lands as **`processing`** (COD `process_payment`).
- Script: `curl` the Store API, or Playwright for the real UI (optional). Assert via
  `GET /wc/v3/orders?status=processing` using the admin key.

### Chat agent, as user A
**"Ask the agent to create a product with a name and price. The product appears on the storefront."**
- `create_product` must end with **`status: publish`**. The WC default is publish; our tool may default to draft
  (06·04 §2.2), so the agent passes publish.
- With approval gating, the card shows `{name, regular_price, status: publish}` and A approves.
- Assert: product visible at `/?post_type=product` or the Store API `wc/store/v1/products`.

**"Place an order for it on the storefront by hand, then ask the agent what orders came in today. It returns that
order."**
- "Today" is a timezone trap:
  - WooCommerce's `after` is interpreted in the **site timezone** unless `dates_are_gmt=true` (06·04 §2.3);
  - the model doesn't know today's date.
  - Inputs for design: put the current date/time and store timezone in the system prompt, or give `list_orders` a
    `created_after` (ISO) param and let the model compute it, or support `period: "today"` in the tool.
- Assert: the tool result contains the new order id.

### External MCP client, as user B
**"Connect … using only the gateway URL and user B's API key. See the tools of every enabled server, and ask the same
orders question successfully."**
- Gateway auth: key → principal B (06·06 §2.3).
- `tools/list` from the catalog, filtered for B; deterministic order; `cacheScope: private` (06·03 §4).
- Assert:
  `inspector --cli … --method tools/list --format json | jq '[.result.tools[].name] | map(split("__")[0]) | unique'`
  returns every enabled slug.

**"Run one prompt that needs tools from two different upstream servers."**
- Example (depends on the chosen upstreams):
  - "Look up what DeepWiki says about \<topic\>, then create a draft product named after it". Two servers plus a write,
    so approval applies.
  - Or a read-only pair: "Compare today's orders with \<data from the in-cluster server\>".
- Assert: audit shows two `server_slug`s for one session or trace.

### Team and control
**"Revoke user B's key. Their next call is rejected."**
- Revocation is immediate (no cache, or cache invalidated by NOTIFY, 06·06 §2.3).
- The gateway answers 401 with `WWW-Authenticate: Bearer error="invalid_token"`, no `resource_metadata`, and no
  `/.well-known/oauth-protected-resource*` (06·01 §11). Claude Code reports failed, without starting OAuth.
- Assert: Inspector CLI **exit code 3**. Audit row `outcome=unauthenticated`, `credential=api_key:<id>`.

**"Disable one upstream server. Its tools disappear from both the chat agent and the external client."**
- Admin toggles `enabled=false` → the manager removes the catalog entries → `handler.notify.toolsChanged()` → Claude
  Code (listen stream) refetches; the chat backend re-lists every turn.
- Calls to the disabled tools are **refused at call time** with a clear message, even from clients holding stale
  definitions (CC #97369).
- Assert: `tools/list` no longer contains the slug. A `tools/call` on an old name gives **exit 5**
  (`isError`/not found).

**"Kill the pod of one upstream server. The other servers keep working, and the dashboard shows the dead one as
unreachable."**
- **Timing trap:** a Deployment replaces a killed pod within seconds, so "dead" lasts only until the new pod is
  Ready.
  - A 1-minute health tick (Kuadrant's default, 06·03 §2) would miss it entirely.
  - Detection must be faster than recovery. Options:
    - **EndpointSlice watch**: zero ready endpoints flips the status instantly (needs `get/list/watch endpointslices`
      RBAC in our namespace);
    - **call-time failure** marks it unreachable immediately;
    - a short tick (5–10 s) for in-cluster upstreams;
    - for the video, a long readiness `initialDelaySeconds` on that upstream to widen the window, stated honestly.
- With no ready endpoints, kube-proxy **rejects** connections to the ClusterIP (fast `ECONNREFUSED`, not a timeout).
  The bulkhead and breaker keep other upstreams unaffected (06·03 §7).
- Show self-healing too: status returns to `connected` when the new pod is Ready.
- Assert: during the window the dashboard API status is `unreachable` and calls to other servers still return 200.

**"Every call above appears in the audit log, attributed to the right user."**
- One row per MCP request (allowed, denied, failed), plus admin actions (06·06 §7).
- Assert: query audit by user A and user B, and count expected rows per step.

---

## 3. A scripted check (the previous cycle's best submission had `make test` for the DoD)

```bash
#!/usr/bin/env bash   # demo-check.sh  (outline; values from env)
set -euo pipefail
I="npx --yes @modelcontextprotocol/inspector@2.10.1 --cli --transport http --server-url $GW_URL --format json"
# 1. both eras answer
$I --protocol-era modern --header "Authorization: Bearer $KEY_B" --method initialize >/dev/null
$I --protocol-era legacy --header "Authorization: Bearer $KEY_B" --method initialize >/dev/null
# 2. every enabled server's tools visible; schemas portable
$I --header "Authorization: Bearer $KEY_B" --method tools/list --strict | jq -e '.result.tools | length > 0'
# 3. orders question via store tools
$I --header "Authorization: Bearer $KEY_B" --method tools/call --tool-name store__list_orders --tool-args-json '{"status":["processing"]}'
# 4. revoke → exit 3
curl -fsS -X POST "$API/keys/$KEY_B_ID/revoke" -b "$ADMIN_COOKIE" -H 'X-Requested-With: x'
set +e; $I --header "Authorization: Bearer $KEY_B" --method tools/list; [ $? -eq 3 ] || exit 1; set -e
# 5. disable server → tool gone; old name call → exit 5
# 6. kubectl delete pod -l app=<in-cluster-upstream>; poll dashboard status until unreachable; other server call OK; wait until connected
# 7. audit assertions per user
```

Run it locally against k3d and on the VPS against the public hostname (doc 05 E16).

---

## 4. Recording the video (what to show so internals are visible)

- Split screen: dashboard (servers, keys, audit) + terminal (Claude Code) + `kubectl get pods -w`.
- For each DoD step, show the **audit row** appearing; that proves attribution.
- On revoke: Claude Code `/mcp` showing ✘ Failed, plus our 401 body.
- On disable: Claude Code's tool list refresh, plus a call to the old tool name returning the "disabled by an admin"
  `isError`.
- On kill: the pod terminating/recreating next to the dashboard status flipping `unreachable` → `connected`.
- 30 seconds on the threat model: the checkout-note injection path and the approval card (06·08 §5).

## Sources
- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) · [Cursor MCP docs](https://cursor.com/docs/context/mcp) ·
  [Cursor forum: headers dropped on tools/call](https://forum.cursor.com/t/streamable-http-mcp-mcp-json-headers-besides-x-domainhost-key-are-dropped-on-tools-call/169015)
- MCP Inspector: [README](https://github.com/modelcontextprotocol/inspector/blob/main/README.md) ·
  [CLI README](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md) ·
  [CLI smoke testing](https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md)
- npm: `@anthropic-ai/claude-code` 2.1.295, `@modelcontextprotocol/inspector` 2.10.1 (2026-10-09/10)
- The brief: project.md "Definition of done (must be testable)"
