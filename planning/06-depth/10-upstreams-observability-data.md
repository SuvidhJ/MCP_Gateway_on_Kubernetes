# 06·10 — Upstream Candidates (live-probed), Observability Names, Data Layer

Written 2026-10-10. Upstream facts come from **live probes run today** with the scripts
`scratchpad/r5/probe2.sh` and `tools2.sh`. Observability names come from the OpenTelemetry GenAI semconv repo
(`open-telemetry/semantic-conventions-genai`, `docs/gen-ai/mcp.md`; the MCP page moved there from the main semconv
repo). Postgres facts come from the PostgreSQL 18 docs.

---

## 1. Free, no-auth public MCP servers: era behaviour as seen today

Probe A: modern `server/discover` with 2026-07-28 headers and `_meta`. Probe B: legacy `initialize` (2025-11-25).

| Server (URL) | Probe A (modern) response | Era verdict | Probe B (legacy) | Session id | Tools (name → params) | ~tokens of `tools` JSON |
|---|---|---|---|---|---|---|
| DeepWiki `https://mcp.deepwiki.com/mcp` | **400**, `-32600` "Unsupported protocol version: 2026-07-28. Supported versions: 2024-11-05 … 2025-11-25" (`id:"server-error"`) | legacy (not `-32022`, so not modern evidence) | 200 SSE, 2025-11-25 | none | `ask_wiki_question(repoName, question)`, `read_wiki_contents(repoName)`, `read_wiki_structure(repoName)`; outputSchemas, no annotations | ~410 |
| Microsoft Learn `https://learn.microsoft.com/api/mcp` | **200** SSE with `-32601` "Method 'server/discover' is not available." | legacy | 200 SSE, **2025-06-18** | **yes** (base64 JSON containing clientInfo + a user id claim) | `microsoft_docs_search(query)`, `microsoft_code_sample_search(query, language)`, `microsoft_docs_fetch(url)`; readOnly | ~1,250 |
| Cloudflare Docs `https://docs.mcp.cloudflare.com/mcp` | **200** `DiscoverResult` `supportedVersions:["2026-07-28"]`, `ttlMs:0`, `cacheScope:"private"` | **modern** (also answers legacy, i.e. dual-era) | 200 SSE, 2025-11-25 | none | `search_cloudflare_documentation(query)`, `migrate_pages_to_workers_guide()`; readOnly | ~470 |
| AWS Knowledge `https://knowledge-mcp.global.api.aws` | **200** JSON `-32601` "Method not found: server/discover" | legacy | 200 JSON, **2025-03-26** | **yes** | `aws___search_documentation`, `aws___read_documentation`, `aws___list_regions`, `aws___get_regional_availability`, `aws___retrieve_skill` (note `___` in names); readOnly | ~2,020 |
| Context7 `https://mcp.context7.com/mcp` | **200** `DiscoverResult` 2026-07-28 | **modern** (dual-era) | 200 SSE, 2025-11-25 | none | `resolve-library-id(query, libraryName)`, `query-docs(libraryId, query, language)`; readOnly | ~1,330 (CVE history, doc 05) |
| GitMCP `https://gitmcp.io/docs` | **400** `text/plain` `-32000` "Mcp-Session-Id header is required" | legacy | 200 SSE, **2025-03-26** | **yes** | (not listed) | — |

Round 6 additions (07 §8):
- **GitHub `https://api.githubcopilot.com/mcp/readonly`** (with a GitHub token) is **dual-era**: modern 2026-07-28
  without a session, or legacy 2025-11-25 with a session.
  - 29 tools, 22 with `x-mcp-header`; calls work in both eras without Mcp-Param headers.
  - The list is huge: icons 44 KB and modern `outputSchema` 66 KB. The LLM-relevant part is ≈ 7 K tokens.
- All of DeepWiki, MS Learn and Cloudflare Docs worked through our gateway for both modern and legacy downstream
  clients.
- DeepWiki `ask_wiki_question` took 8.5 s, so call timeouts must be per-upstream.

What this proves about our upstream client:
1. **Four different "not modern" signals** appear in the wild: 400 with a non-standard error, 200 with `-32601`, 400
   plain text, and session-required. Only `DiscoverResult` and `-32022` count as modern evidence. The SDK's
   conservative classifier (06·02 §3.1) handles exactly this; a hand-rolled check on "status == 400" would misclassify
   Microsoft Learn and AWS.
2. **Three of six issue legacy sessions**, so our legacy upstream path needs session handling and 404 re-init (06·02 §3.4).
3. Protocol versions span **2025-03-26 → 2026-07-28**; our upstream client must speak all of them (the SDK does).
4. Tool descriptions are long (AWS `read_documentation` 2,118 chars). Free LLM tiers with 8K TPM (06·07 §3) can't
   carry many such servers. A gateway feature to **override or shorten descriptions per tool** (MetaMCP has "tool
   overrides", 06·03) or to select tools per chat is a real need, not polish.
5. Names: `aws___search_documentation` becomes `awsdocs__aws___search_documentation`. Routing by catalog lookup (not
   parsing) keeps this safe (06·03 §3). Length with Claude Code's prefix: 12 + 35 = 47 ≤ 64.

Choosing extra upstreams (decision input):
- For the **cross-server prompt** we want a store-relevant pairing. Options: WooCommerce + DeepWiki ("what does the
  woocommerce/woocommerce wiki say about order statuses? then update this order accordingly"), or WooCommerce +
  Microsoft Learn or Cloudflare Docs.
- **Era coverage for the demo:** Cloudflare Docs (modern) + DeepWiki (legacy, no session) + Microsoft Learn (legacy,
  session) exercise every upstream path.
- **Kill-pod demo:** needs an in-cluster upstream we own (§2). Public servers can't be killed, and they may be down or
  rate-limited on demo day, so keep a fallback.

## 2. The in-cluster upstream we own

Purpose:
- the pod-kill demo;
- an offline-safe server;
- a credential-bearing upstream (shows secret injection);
- optionally a deliberate **name collision** (e.g. it also has a `search` tool) to show namespacing.

Built with `createMcpHandler` + `McpServer` (dual-era for free, 06·02 §2). It requires a static bearer from the
gateway (stored encrypted in the registry).

Example domains (pick one that pairs with the store). Keep it independent of the WooCommerce MCP server, because an
upstream that calls another upstream couples their failures and blurs the kill-pod demo:
- "shipping-quotes": a deterministic rate table.
- "supplier-catalog": a small static dataset.

## 3. Observability: exact OpenTelemetry names for MCP (status: Development)

- **Span names:** `{mcp.method.name} {target}`, where target = `gen_ai.tool.name` (or prompt name) when
  low-cardinality, e.g. `tools/call store__list_orders`. Kind `SERVER` for spans we receive, `CLIENT` for our upstream
  calls (the gateway emits both).
- **Attributes:**
  - `mcp.method.name` (required);
  - `error.type` (iff failed; the JSON-RPC code as a string when applicable);
  - `gen_ai.tool.name`;
  - `jsonrpc.request.id`;
  - `rpc.response.status_code` (e.g. `-32602`);
  - `mcp.protocol.version`;
  - `mcp.session.id` (legacy sessions);
  - `network.transport` (`tcp`);
  - opt-in `gen_ai.tool.call.arguments` / `.result`. **Keep these off** (PII, 06·06 §7).
- **Metrics** (histograms in seconds, bucket advice `[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]`):
  - `mcp.server.operation.duration`, `mcp.client.operation.duration`;
  - `mcp.server.session.duration`, `mcp.client.session.duration`.
- **Context propagation:** "Instrumentations SHOULD propagate context … by injecting it into the MCP request
  `params._meta` property bag". The keys `traceparent`, `tracestate`, `baggage` are written **unprefixed** (SEP-414;
  the spec reserves them, 06·01 §2).
  - The gateway extracts the client's `traceparent` as the parent and injects its own into upstream `_meta`. Then one
    trace runs chat turn → gateway → woo-mcp → WordPress REST call.
- **Cheap stand-out (S-8):**
  - OTel SDK in gateway and woo-mcp;
  - export to a small in-cluster collector + Jaeger, or just to logs;
  - the dashboard's per-upstream p50/p95 come from the same histogram.

## 4. Data layer facts

- **PostgreSQL 18** is current. Node drivers today: `pg` 8.23.1; query builders: Drizzle 0.45.4, Kysely 0.29.6.
- **LISTEN/NOTIFY** (for a multi-replica event bus, 06·03 §8):
  - payload "must be shorter than 8000 bytes";
  - "Notifications are only delivered between transactions", and a NOTIFY inside a transaction is delivered only on
    commit;
  - identical channel+payload in one transaction are folded;
  - order is preserved within a transaction and across commits;
  - the queue is 8 GB, and a full queue makes NOTIFY transactions fail at commit;
  - a listener needs a **dedicated connection** (not a pooled one that's returned between queries).

  Send ids only ("catalog-changed", server id), never data.
- **Migrations in Kubernetes: ordering trap.**
  - If Postgres is part of the same Helm release, a `pre-install` hook Job runs **before** the Postgres StatefulSet
    exists and can't migrate.
  - A `post-install` hook runs after app pods have already started against an empty schema.
  - Robust pattern: the app (or an initContainer in the gateway pod) runs migrations at startup inside
    `pg_advisory_lock(<constant>)`, so replicas serialize. Readiness turns true only after migrations.
  - The WooCommerce bootstrap Job has the same constraint: it must wait for MariaDB. Retry with backoff, or an init
    container that waits for the DB.
- **Backups (prod note):** `pg_dump` and `mysqldump` CronJobs to a PVC or object storage. Mention under "what changes
  for production".

## Sources
- Live probes (2026-10-10): `probe2.sh`, `tools2.sh` in the session scratchpad; endpoints listed in §1.
- OpenTelemetry: [semantic-conventions-genai/docs/gen-ai/mcp.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)
  (moved from [semantic-conventions/docs/gen-ai/mcp.md](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/mcp.md))
- PostgreSQL 18: [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
- npm (2026-10-09): `pg`, `drizzle-orm`, `kysely`
