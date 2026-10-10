# 05 — Failures and Successes: What the Field Already Learned

Round 4 of research (2026-10-09). Rounds 1–3 asked *what exists and how it works*. This round asks *what broke for others and why,
and what kept working*, so we can avoid known mistakes and copy proven moves.

**Method.** Most of this comes from primary sources:
- Mined the most-discussed GitHub issues of 14 open-source MCP gateways, the official TypeScript and Python SDKs, Claude Code,
  VS Code, Inspector, Codex, Gemini CLI, k3d, kind, k3s, Traefik, WooCommerce and the WordPress MCP adapter.
- Read WooCommerce's REST authentication code and the official WordPress image's config.
- Checked incident ledgers and CVE records, MCP Dev Summit 2026 talk abstracts, empirical papers, and official docs.
- Read public submissions from Urumi's *previous* hiring cycle (the store-provisioning brief, which is our bonus).

I deliberately did **not** mine the two public repos from candidates in *this* cycle, so our work stays independent.

**Evidence tags:** [issue] GitHub issue/PR, [code] source read, [docs] official documentation, [cve] advisory,
[talk] conference abstract, [paper] research, [reported] secondary source, [unverified] plausible but untested — goes into an experiment.

---

## 0. The 15 findings that change decisions

1. **The newest protocol is where clients break.** Claude Code has open bugs that silently drop *all* of a server's tools:
   - when a modern `tools/list` omits `ttlMs`/`cacheScope` ([#88128](https://github.com/anthropics/claude-code/issues/88128));
   - when an input schema uses root-level `allOf/if/then` ([#95504](https://github.com/anthropics/claude-code/issues/95504));
   - when an output schema declares JSON Schema draft-07 ([#86142](https://github.com/anthropics/claude-code/issues/86142), since fixed).

   VS Code still only speaks the old protocol ([#329848](https://github.com/microsoft/vscode/issues/329848), open). → Serve
   both eras, always emit cache hints, normalise schemas, and record exact client versions. [issue]
2. **Never trust a client's tool list.** Claude Code keeps an *old* tool description for the rest of a conversation, even
   after reconnect or `--resume` ([#97369](https://github.com/anthropics/claude-code/issues/97369)). Tool-search indexing has
   also lagged behind `list_changed` ([#66084](https://github.com/anthropics/claude-code/issues/66084)). → "Disable server"
   and permissions must be enforced **when a tool is called**, not only by hiding tools. [issue]
3. **Gateways fail in a small number of recurring ways.** Each happened in a real project in 2026 [issue][cve]:
   - **Era vs session confusion** (agentgateway #2982, Kuadrant #1483).
   - **Credentials injected on one path but not the other** (Kuadrant #926).
   - **The client's token forwarded upstream by accident** (MCPJungle #252).
   - **Default secret `"changeme"` let anyone mint an admin token** (ContextForge GHSA-5424-f25v-29r8).
   - **Policy field accepted but ignored** (Obot #8180).
   - **Health check says OK while requests hang** (ToolHive #6345).
   - **URL validator bypassed with odd IP spellings** (ToolHive #6197).
   - **A restart becomes an outage** (MCPHub #1154).
   - **Sequential fan-out made calls 4× slower** (Obot #7625).

   §2.2 maps each to a countermeasure.
4. **The TypeScript SDK v2 fits, but we must add missing guards.** It has:
   - no Host/Origin validation in `createMcpHandler` (#2844);
   - client timeouts that don't fire (#2695, #2739);
   - no re-initialisation when a legacy upstream restarts (#1708);
   - draft-07 schema output (#2677, #2721).

   Its low-level `Server` lets a gateway serve raw upstream schemas without compiling a validator per request. The JS
   LangChain MCP adapter is on SDK v2; the Python one is pinned to SDK v1 (old protocol only). [issue][code][docs]
5. **GitHub's hosted MCP server is a risky upstream.** It rejects the new protocol, so clients fall back to the old one.
   It then *requires* `Mcp-Param-*` headers on `tools/call` for most of its tools. No published SDK sends those headers on
   the old protocol (TS SDK [#2639](https://github.com/modelcontextprotocol/typescript-sdk/issues/2639), Aug 2026).
   **Context7**, another candidate, had a critical prompt-injection CVE (CVE-2026-75130, "ContextCrush"). **DeepWiki**
   (no auth, old protocol) is the safer docs upstream. [issue][cve]
6. **Most real MCP breaches were ordinary bugs, not exotic AI attacks.**
   - Command injection is 11 of 25 entries in one incident ledger, more than double prompt injection.
   - The largest class, OX Security's "STDIO" advisory (~200k instances, 16 CVEs), lives in **stdio** servers.
   - Our brief allows only Streamable HTTP upstreams, so that whole class is out of scope; the design note should say so.
   - Two cautionary bugs for our admin API: in nginx-ui an *empty* allowlist meant *allow everyone*; in LiteLLM the
     add-server endpoint ran commands without authentication (CVSS 9.8).

   [cve][reported]
7. **The in-cluster store channel is settled by reading the code.**
   - The official WordPress image treats any request with `X-Forwarded-Proto: https` as HTTPS. That turns on WooCommerce's
     Basic auth for our MCP server's in-cluster calls, with no OAuth signing.
   - WooCommerce is actively hardening API-key auth (Sep–Oct 2026 commits), so **pin the version**.
   - WooCommerce's own MCP returned data that didn't match its declared output schema. Dates lacked a timezone, and
     `null` appeared where numbers were promised. **Every call** failed in clients that validate responses (woocommerce #64195).

   [code][issue]
8. **Windows local development has four traps:**
   - Node and Microsoft's curl don't resolve `*.localhost`.
   - `nip.io` is blocked by routers with DNS-rebind protection and by ad blockers. A previous-cycle candidate hit this.
   - k3d's load balancer can hang on WSL2 (k3d #1661).
   - **kind on WSL2 does not enforce NetworkPolicy** without extra kernel modules (kind #3789).

   → The local-cluster experiment needs a *negative* NetworkPolicy test and a hosts-file plan. [issue]
9. **Long-lived streams have three silent killers.** Combined with Claude Code's limit of 5 reconnects per hour, a cut
   stream can freeze live tool updates for about 6 hours:
   - Traefik's 60 s default `readTimeout` (since v2.11.2; it breaks long uploads). *Resolved in round 5 from Traefik
     and Go source: it bounds reading the request only, so it does not cut SSE responses to small POSTs
     (06-depth/05 §3.1).*
   - Azure's 4-minute idle timeout.
   - Missing keep-alives. [docs][issue]
10. **The free-LLM landscape shrank this year:**
    - **GitHub Models was retired on 2026-07-30.**
    - **Cerebras's free tier is gone.**
    - Gemini no longer publishes free limits; Flash was cut to about 20 requests/day in Dec 2025.
    - Groq caps tokens at 8K per minute.
    - NVIDIA's API catalogue (about 40 requests/min) is the most generous remaining option.

    → Use a provider-agnostic LLM client and a frugal agent loop. [docs][reported]
11. **The free Azure DNS name won't reliably get a Let's Encrypt certificate.** `*.cloudapp.azure.com` is not on the Public
    Suffix List, so every Azure user shares one Let's Encrypt limit (50 certificates/week for azure.com). Users regularly hit
    it. → Use DuckDNS or a Student Pack domain, and start with the staging issuer. [docs][reported]
12. **The best previous-cycle submission won on operability**, not features:
    - a one-command end-to-end check of the Definition of Done (checkout over the Store API with COD);
    - Helm Job names suffixed with the revision, because Job specs are immutable;
    - idempotent seeding;
    - a chart that *refuses* to run more than one replica on SQLite;
    - a troubleshooting table and honest "known limitations". [code]
13. **Production talks converge on a few habits:**
    - Fewer than 20% of remote MCP servers fully follow the spec, so consume upstream output leniently.
    - Classify errors in three tiers: protocol, gateway, application.
    - Write error messages for the agent ("needs X, do Y"), not just "403".
    - Read-only guardrails and human-in-the-loop for writes.
    - Fewer tools, each matching a task.
    - Wipro presented almost our exact architecture for a regulated bank: a React portal, a LangGraph agent, Microsoft's MCP
      Gateway and a 19-tool FastMCP server. [talk]
14. **Research names our two biggest risks.** A 2026 study of 833 MCP server faults calls out *"configuration parameters
    that are accepted but not enforced at runtime"*. A study of 1,723 MCP apps found that only **37.2%** require approval
    before a tool runs. Tested policy enforcement and approval for writes are therefore where we can differ. [paper]
15. **Agents are inconsistent.**
    - On a retail-orders benchmark, GPT-4o succeeded on 60% of tasks in one try, but only 38% passed four tries in a row.
    - In production, 3–15% of tool calls fail; the worst failures look like success (HTTP 200, empty data).

    → Cap the agent's steps, detect repeated calls, give it today's date and the store's timezone, confirm writes, and
    surface errors as they are. [reported]

---

## 1. Corrections to earlier docs

| Earlier claim | Correction (2026-10-09) | Evidence |
|---|---|---|
| GitHub Models usable (15 RPM / 150 RPD) (03 §5.6, 04 §4.3) | **Retired 2026-07-30**; closed to new users 2026-06-16 | [github.blog changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/) |
| Cerebras free tier | Gone; now a $5 trial that needs a card | [reported] dev.to Oct 2026, OpenRouter blog |
| Gemini free tier limits as published | Google no longer publishes them (AI Studio only, "not guaranteed"); Flash cut 250 → 20 RPD on 2025-12-07; 3rd-party Sep 2026: ~20 RPD for 3.5–3.8 Flash, ~500 RPD Flash-Lite | [docs][reported] |
| Azure DNS label as a free hostname for TLS | Works for DNS, but Let's Encrypt limits are shared with all of `azure.com`, and are often exhausted | PSL check + LE community threads |
| Kind enforces NetworkPolicy (≥ 0.24) | True on Linux; **not on WSL2 without nfqueue modules** | kind #3789 |
| Legacy clients get no push (405 on GET) | Still true, and some client versions treated 405 as a fatal error (Claude Code 2.1.84, Desktop toast) | CC #39790, #78193 |

---

## 2. Layer by layer: what failed, what worked, what we do

### 2.1 MCP clients (the people who will judge our endpoint)

**Failures seen in 2026 [issue]**

| Client | Failure | Status | Our countermeasure |
|---|---|---|---|
| Claude Code | Modern `tools/list` without `ttlMs`/`cacheScope` → 4 retries → *all tools silently gone* ([#88128](https://github.com/anthropics/claude-code/issues/88128)) | open | Always emit both hints (gateway and our MCP server) |
| Claude Code | Root-level `allOf/if/then` input schema → tools dropped ([#95504](https://github.com/anthropics/claude-code/issues/95504)); draft-07 output schema "unsupported dialect" ([#86142](https://github.com/anthropics/claude-code/issues/86142)) | open / fixed | Normalise proxied schemas: strip `$schema`, keep root `type: object` with properties; flag exotic schemas in the dashboard |
| Claude Code | Changed tool definition never reaches a session that already loaded it ([#97369](https://github.com/anthropics/claude-code/issues/97369)); ToolSearch index lag ([#66084](https://github.com/anthropics/claude-code/issues/66084)) | open | Enforce at call time; demo "tools disappear" in a fresh session; `ENABLE_TOOL_SEARCH=false` for the demo |
| Claude Code | Static `Authorization` header dropped or ignored in some versions (#28293, [#29562](https://github.com/anthropics/claude-code/issues/29562), [#48514](https://github.com/anthropics/claude-code/issues/48514), [#33817](https://github.com/anthropics/claude-code/issues/33817)) | fixed per version | Pin and record the client version; Inspector CLI as backup client |
| Claude Code | 405 on GET treated as fatal (2.1.84, [#39790](https://github.com/anthropics/claude-code/issues/39790)) | fixed | Test the exact version against our legacy path |
| Claude Code via claude.ai connectors | Header says 2025-11-25, body says 2026-07-28 → strict servers reject every call ([#93290](https://github.com/anthropics/claude-code/issues/93290)) | open | Demo with `claude mcp add` (direct), not connectors; log mismatches with a clear message |
| Claude Code (stdio) | Successful modern discover then sends legacy `initialize` ([#96183](https://github.com/anthropics/claude-code/issues/96183)) | open | Our gateway accepts both on the same endpoint |
| VS Code | No 2026-07-28 negotiation yet ([#329848](https://github.com/microsoft/vscode/issues/329848)) | open | Legacy path must be first-class |
| VS Code | Auth discovery expects RFC 9728 metadata when using OAuth ([microsoft/mcp-gateway#17](https://github.com/microsoft/mcp-gateway/issues/17)) | — | Static header path for the demo; metadata only if we do the OAuth stand-out |
| Cursor | Only one custom header forwarded on `tools/call` (forum, 2026-08-20); warning above 40 tools | open | One standard header (`Authorization: Bearer`); keep each member's tool count well under 40 |
| Inspector | Plain 403 without `WWW-Authenticate` starts OAuth discovery ([#2515](https://github.com/modelcontextprotocol/inspector/issues/2515)) | open | Decide the 401/403 shape in E4 |
| Several (Claude Code, Cline, Codex, LangChain4j) | Don't persist `Mcp-Session-Id` → "Session not found" | — | Stateless legacy serving (SDK v2 default) |

**What Claude Code documents [docs]** (useful for E4 and D-8):
- **Rejected static key:** if a statically configured `Authorization` header is rejected, Claude Code "reports the connection
  as failed instead of falling back to OAuth". So a revoked key gives a clear failure, not a sign-in prompt.
- **Tool search:** on by default; `ENABLE_TOOL_SEARCH=false` turns it off.
- **Reconnect budget for the update stream:** a stream that closes within 10 s is reopened up to 3 times. One that lived
  longer is reopened up to 5 times per hour, then Claude Code waits about 6 hours.
- **Timeouts:** each request waits at least 60 s. HTTP tools time out after 5 minutes of inactivity.
- **Output size:** a warning above 10k tokens; `MAX_MCP_OUTPUT_TOKENS` defaults to 25k.

**Lesson.** Fast-moving clients regress often. Pin and record the versions used in the video, and keep a second client
ready (the Inspector CLI is scriptable).

### 2.2 Gateways: the failure catalogue

| # | Failure (project, issue) | Root cause | Countermeasure in our design |
|---|---|---|---|
| G1 | Modern client + legacy *stateful* upstream → "400 Missing session ID" ([agentgateway#2982](https://github.com/agentgateway/agentgateway/issues/2982)) | Derived the upstream's needs from the *client's* era | Per-upstream state: era + session id, owned by the gateway's upstream client |
| G2 | Upstream on 2026-07-28 fetched but tools never listed; logs looked healthy ([Kuadrant#1483](https://github.com/Kuadrant/mcp-gateway/issues/1483)) | Untested era combination | Test matrix: {legacy, modern} client × {legacy, modern, dual} upstream |
| G3 | Credentials applied at discovery but not invocation → 401 ([Kuadrant#926](https://github.com/Kuadrant/mcp-gateway/issues/926)) | Two code paths built requests | One upstream-client factory used by list *and* call |
| G4 | Client's `Authorization` forwarded to an upstream that had none ([MCPJungle#252](https://github.com/mcpjungle/MCPJungle/issues/252)) | Forwarded the downstream request object as-is | Build upstream requests from scratch; **strip all client headers** ("headers belong to the hop") |
| G5 | Default JWT secret `"changeme"` accepted → admin token minted by anyone ([ContextForge GHSA-5424-f25v-29r8](https://github.com/IBM/mcp-context-forge/issues/6664)) | Insecure default + guard skipped in default env | No defaults for secrets; Helm generates them; process refuses to start if missing or weak |
| G6 | Policy field accepted by the API, stored, ignored → 71 tools callable instead of 41 ([Obot#8180](https://github.com/obot-platform/obot/issues/8180)) | No test proving denial | Every policy has a *denial* test; the dashboard shows the effective tool list per user |
| G7 | Rules referencing post-request fields never matched → denied everything ([agentgateway#3092](https://github.com/agentgateway/agentgateway/issues/3092)) | Policy not validated on save | Validate policy on save; preview "what this user can call" |
| G8 | Fan-out reached upstreams the caller was denied ([agentgateway#3586](https://github.com/agentgateway/agentgateway/issues/3586)) | Authorization applied after fan-out | Filter upstreams *before* fan-out |
| G9 | `/health` OK while `initialize` hung >12 s ([ToolHive#6345](https://github.com/stacklok/toolhive/issues/6345)) | Health didn't exercise the real path | Readiness = can serve a bounded `tools/list` from cache; per-upstream status separate from pod health |
| G10 | URL validator bypassed: `http://:8080/`, `localhost.`, `[fe80::1%25eth0]`, `2130706433`, `0177.0.0.1` ([ToolHive#6197](https://github.com/stacklok/toolhive/issues/6197)) | String-matching host names | Resolve, then check the **IP at dial time**; no redirects (`redirect: 'manual'`) |
| G11 | SSRF guard blocked a legitimate in-cluster upstream ([Unla#299](https://github.com/AmoyLab/Unla/issues/299)) | No allowlist concept | Admin-managed allowlist for cluster-internal hosts (`*.svc.cluster.local`); metadata/link-local always blocked |
| G12 | ~100 upstreams: unbounded concurrent startup + catalog only in memory → restart = outage ([MCPHub#1154](https://github.com/samanhappy/mcphub/issues/1154)) | No concurrency limit, no persisted cache | Bounded parallel refresh; persist last-known catalog in the DB; serve stale-but-marked |
| G13 | Upstream restart → "Session not found" forever; reconnect matched an error *string* ([MCPHub#742](https://github.com/samanhappy/mcphub/issues/742)) | Brittle error matching (the SDK also lacks re-init on 404, TS #1708) | On 404/session-not-found: drop session, re-initialise, retry once (idempotent methods only) |
| G14 | SSE upstream unusable after ~5 min ([MCPHub#375](https://github.com/samanhappy/mcphub/issues/375)); OAuth upstream fails silently on expiry ([MetaMCP#142](https://github.com/metatool-ai/metamcp/issues/142)) | Idle timeouts; no token lifecycle | Per-call connections or keep-alives; static creds in scope (no OAuth upstream refresh needed) |
| G15 | Tool calls 5 s → 20 s after a refactor: sequential per-server init in `ListTools` ([Obot#7625](https://github.com/obot-platform/obot/issues/7625)) | Serial fan-out | `Promise.allSettled` with per-upstream deadline; cached catalog for list |
| G16 | Chart's ClusterRole: cluster-wide Secrets get/list/create/delete ([agentgateway#3063](https://github.com/agentgateway/agentgateway/issues/3063)) | Convenience RBAC | Namespace-scoped Role, minimal verbs; most pods need no K8s API access at all |
| G17 | Async create skipped the audit entry ([ContextForge#6869](https://github.com/IBM/mcp-context-forge/issues/6869)); masked failure causes / wrong HTTP status (#6724); PUT 500 vs POST 400 (#7144) | Admin paths treated as second-class | Audit admin actions too (add/edit/disable server, key create/revoke); one validation layer |
| G18 | Visibility conflated "see config" with "use tools" ([MCPHub#1036](https://github.com/samanhappy/mcphub/issues/1036)) | Single permission bit | Members use tools; only admins see upstream config; credentials never readable by anyone |
| G19 | Memory 2–3× growth over 24 h ([ToolHive#5860](https://github.com/stacklok/toolhive/issues/5860)); stdio children never reaped → OOM ([MetaMCP#162](https://github.com/metatool-ai/metamcp/issues/162)) | Leaks in long-lived proxies | Memory limit + a soak test (E13); no stdio |
| G20 | Unbounded `mcp>=1.17` resolved to 2.0.0 → crash on import ([mcp-proxy#235](https://github.com/sparfenyuk/mcp-proxy/issues/235)) | Unpinned major version | Lockfiles; pin SDK majors |

**Successes worth copying.** These are taken from the same projects' designs (see 02 §2.2 and 04 §1):
- Docker's shape-only call logging.
- agentgateway's "disable caching of proxied results".
- MetaMCP's per-namespace tool overrides.
- ToolHive's configurable naming strategies.
- LiteLLM's permission intersection.

### 2.3 The SDK we'd build on (TypeScript v2) and its Python sibling

| Issue | What breaks | What we do |
|---|---|---|
| [TS#2844](https://github.com/modelcontextprotocol/typescript-sdk/issues/2844) (open) | `createMcpHandler` has no Host/Origin validation (DNS-rebinding guard) | Add our own allowlist check before the handler |
| [TS#2695](https://github.com/modelcontextprotocol/typescript-sdk/issues/2695), [#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739), [#2247](https://github.com/modelcontextprotocol/typescript-sdk/issues/2247) (open) | Total timeout not enforced; POST left pending when SSE ends; invalid frames dropped → hangs | Our own `AbortController` deadline on every upstream call |
| [TS#1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708) (open) | Client doesn't clear session and re-init on 404 | G13 logic in the gateway |
| [TS#2964](https://github.com/modelcontextprotocol/typescript-sdk/issues/2964) (open) | Client's listen stream not reopened after upstream restart | Periodic catalog refresh regardless of push |
| [TS#2677](https://github.com/modelcontextprotocol/typescript-sdk/issues/2677), [#2721](https://github.com/modelcontextprotocol/typescript-sdk/issues/2721) (open) | Emits draft-07 `$schema` | Normalise schemas we emit |
| [TS#2639](https://github.com/modelcontextprotocol/typescript-sdk/issues/2639) (open) | Can't send `Mcp-Param-*` headers on the old protocol; GitHub requires them | Avoid GitHub as an upstream, or add header mirroring ourselves (E12) |
| [TS#2232](https://github.com/modelcontextprotocol/typescript-sdk/issues/2232), [#2868](https://github.com/modelcontextprotocol/typescript-sdk/issues/2868) | `list_changed` dropped on stateless transports; `listChanged` advertised even if never sent | Advertise only what we send; E1 verifies push end to end |
| Fixed: [#2607](https://github.com/modelcontextprotocol/typescript-sdk/issues/2607), [#2838](https://github.com/modelcontextprotocol/typescript-sdk/issues/2838), [#2589](https://github.com/modelcontextprotocol/typescript-sdk/issues/2589) | Reused server instance leaked until crash after ~20k requests; schemas re-converted every request; accepted modern POST without version header | Fresh server per request (factory); low-level `Server` for proxied tools |
| [PY#3358](https://github.com/modelcontextprotocol/python-sdk/issues/3358) (open) | Python client follows redirects into internal/loopback hosts (SSRF) | Same risk in Node `fetch` (follows by default) → `redirect: 'manual'` |
| [PY#3572](https://github.com/modelcontextprotocol/python-sdk/issues/3572) (open) | Validation errors echo the rejected input (PII into logs) | Redact arguments in errors and audit |
| [PY#3091](https://github.com/modelcontextprotocol/python-sdk/issues/3091) (fixed) | 401/403/5xx looked like timeouts | Map upstream HTTP status into classified `isError` results |

**Substrate fact [docs].** v2 can serve raw upstream schemas in two ways:
- `fromJsonSchema(doc, validator)`, which compiles a validator per schema;
- the low-level `Server`, which returns your `tools/list` unchanged.

For a gateway that builds a server per request, the low-level `Server` avoids recompiling validators on every call. A
Windows proxy crashed because compiling a schema took more than 250 ms (1mcp #564). Our own small WooCommerce server can use
the high-level `registerTool`.

**Ecosystem fact [code].**
- `@langchain/mcp-adapters` (JS) 2.0.1 depends on `@modelcontextprotocol/client ^2.2.0`, and LangGraph JS is at 1.4.21.
- Python `langchain-mcp-adapters` 0.3.2 pins `mcp>=1.24,<2.0`, so it only speaks the old protocol.

On the new protocol, the TypeScript ecosystem is ahead.

### 2.4 Security: incidents that actually happened, and the frameworks that explain them

**Incidents beyond 02 §11.2 [cve][reported]**

| When | What | Root cause | Lesson for us |
|---|---|---|---|
| 2025-06 | Smithery hosting: `dockerBuildPath: ".."` → builder home → over-privileged fly.io token → 3,243 apps, root exec (GitGuardian) | Path traversal + broad token | Least-privilege credentials everywhere, including CI/registry |
| 2025-07/08 | Cursor MCPoison (CVE-2025-54136): approved config swapped silently; CurXecute (CVE-2025-54135): agent writes `mcp.json` | Trust keyed to a *name*, not *content* | Pin upstream tool definitions by hash; re-approve on change (P20) |
| 2026-01–04 | 40+ CVEs across SDK-based servers; OX "Mother of All AI Supply Chains": stdio config → command execution, ~200k instances; Anthropic: intended, sanitisation is downstream's job | Spawning processes from config | **We never spawn upstreams** (HTTP only) |
| 2026-02 / 2026-08 | Context7 "ContextCrush" + CVE-2026-75130 (CVSS 9): library "Custom Rules" served verbatim → agent exfiltrates `.env`, deletes files | Trusted server relaying untrusted content | Upstream *content* is untrusted even when the server is "trusted" |
| 2026-02 | Oura MCP malicious clone carrying StealC | Registry vetting | Admin approval + provenance for new upstreams |
| 2026-03 | nginx-ui CVE-2026-33032 (CVSS 9.8): `/mcp_message` unauthenticated; **empty IP allowlist = allow all** | Fail-open default | Empty allowlist = **deny** |
| 2026-07 | LiteLLM CVE-2026-30623 (CVSS 9.8): unauthenticated "add MCP server" took `command/args` → RCE | Control plane unauthenticated + spawning | Admin API: auth, role check, input validation, no spawning |
| 2026-08 | ContextForge GHSA-5424-f25v-29r8 (High): default `"changeme"` JWT secret | Insecure default | G5 |
| 2026-09 | Go SDK CVE-2026-34742 (8.1): DNS-rebinding protection off by default before 1.4.0; 14 production servers still accepted loopback Host headers weeks later | Default-off guard | Host/Origin allowlist on every HTTP endpoint (incl. dashboard API) |
| 2025-07 | Scan: ≥1,862 MCP servers answering unauthenticated | Auth optional in spec | Auth on by default; no anonymous mode |

**Framing for the threat-model note [reported][docs].**
- **Meta's "Agents Rule of Two"** (late 2025). Within one session an agent should have at most two of:
  - [A] untrustworthy inputs;
  - [B] sensitive systems or private data;
  - [C] the ability to change state or communicate externally.

  Otherwise a human approves. Our chat agent has all three (product text written by anyone, customer PII in orders, and
  write tools), which justifies approval for writes and read-only third-party upstreams.
- **OWASP Top 10 for Agentic Applications 2026:** ASI01 Goal Hijack · ASI02 Tool Misuse · ASI03 Identity & Privilege Abuse ·
  ASI04 Agentic Supply Chain · ASI05 Unexpected Code Execution · ASI06 Memory & Context Poisoning · ASI07 Insecure
  Inter-Agent Communication · ASI08 Cascading Failures · ASI09 Human-Agent Trust Exploitation · ASI10 Rogue Agents. It was
  built from real 2025 incidents (EchoLeak, the Amazon Q extension compromise, the Replit agent deleting a production database).
- **The authzed timeline's cross-cutting lesson:** over-privileged credentials are the most common recurring cause.
  GitHub's toxic-flow attack needed a broad PAT, so a narrowly scoped upstream credential limits the damage.

### 2.5 WordPress and WooCommerce

**Code-verified mechanics [code]**
- **Official WordPress image (`wp-config-docker.php`).** If `X-Forwarded-Proto` contains `https`, it sets `$_SERVER['HTTPS']='on'`.
  This is unconditional: anyone who can reach Apache can claim HTTPS. The image's `.htaccess` keeps the `Authorization`
  header, and `mod_remoteip` trusts private ranges.
- **`WC_REST_Authentication::authenticate`.** If `is_ssl()` it uses Basic auth, otherwise OAuth 1.0a.
  - The OAuth base string uses `get_home_url()`, i.e. the **public** URL.
  - The timestamp must be within ±15 minutes.
  - Used nonces are stored serialised per key in the database, so there is a write on every request. `last_access` is
    also updated per request.
- **WooCommerce ≥ 11.1** rejects API keys outside its own namespaces. Hardening commits landed on 2026-09-02, 09-17 and
  10-07, so pin the version.
- **Implication for our in-cluster calls.** The MCP server calls `http://<wp-svc>` with `X-Forwarded-Proto: https` and Basic
  auth. That avoids OAuth signing and per-request nonce writes. NetworkPolicy must ensure only Traefik and our MCP server
  can reach WordPress, and the design note should say traffic is plaintext inside the cluster.
- **Credential choice.** A WooCommerce key is scoped `read`/`write`/`read_write` but its secret is stored in plaintext.
  A WordPress Application Password is hashed with BLAKE2b since WP 6.8, but inherits all of its user's capabilities.
  Either way it should belong to a dedicated **non-admin** user, which matches Urumi's "scoped user, never an
  administrator account".

**Failures in WooCommerce's own MCP (from the team that will review us) [issue]**
- **[woocommerce#64195](https://github.com/woocommerce/woocommerce/issues/64195).** Output schemas were copied verbatim from
  the REST schema, but the data differed. Dates looked like `Y-m-d\TH:i:s` with no timezone; `stock_quantity` etc. were
  `null` where integers were promised. Clients that validate rejected every result with `-32602`. → If we declare output
  schemas, write them by hand, normalise dates (`*_gmt` + `Z`), allow `null` explicitly, and test each tool against its
  schema.
- **[woocommerce#69325](https://github.com/woocommerce/woocommerce/issues/69325)** (2026-10-02). The new order/product
  abilities return too little to be useful: no customer name, address or shipping method on orders; no categories on
  products. → Shape tools around tasks: a summary for lists, detail for single records. Make deliberate choices about
  personal data per tier.
- **WordPress mcp-adapter:**
  - an empty object `{}` was rejected as "not an object", PHP's `[]` vs `{}` ambiguity
    ([#116](https://github.com/WordPress/mcp-adapter/issues/116));
  - the adapter renamed abilities and broke ChatGPT's search/fetch compatibility (#149);
  - errors were logged on every request in WP 7.1 (#332).

  → Be lenient when parsing WooCommerce JSON (`meta_data: []`), and keep tool names stable.

**Operations failures [reported][code]**
- **Loopback requests fail in containers.** WordPress calls its own public URL (cURL error 7), so WP-Cron and Action
  Scheduler's async runner silently never run. → Set `DISABLE_WP_CRON` and run a CronJob.
- **Liveness probe on a PHP page under load.** Workers are busy, the probe times out, the pod is killed, and the problem
  loops. → Make liveness cheap; readiness can hit PHP.
- **Proxy misconfiguration** causes redirect loops ("too many redirects"). A forced HTTP→HTTPS redirect drops
  `Authorization`.
- **Block checkout:** a cart that is all virtual skips shipping (COD has an "enable for virtual orders" option). Physical
  products need a shipping zone, or checkout dead-ends.

### 2.6 Kubernetes: local Windows, the VPS, and streams

**Local (Windows 11 + Docker Desktop) [issue][reported]**

| Trap | Evidence | Plan |
|---|---|---|
| `*.localhost` doesn't resolve outside browsers (Node, PowerShell, Microsoft's `curl.exe`) | daniel.haxx.se notes; node-offline-localhost | Hosts-file entries or `*.127.0.0.1.nip.io`, chosen in E7 |
| `nip.io` answers dropped by DNS-rebind protection (OpenWrt/pfSense/campus) and blocked by ad blockers | OpenWrt/Netgate forums; previous-cycle README | Test on the user's actual network; keep a hosts-file fallback |
| Windows `winnat` reserves port ranges (can include 80/443) → "access a socket in a way forbidden" | docker/for-win #9272 | `netsh interface ipv4 show excludedportrange protocol=tcp` before choosing ports |
| k3d on WSL2: load balancer stays "Created", `/etc/confd/values.yaml` missing | [k3d#1661](https://github.com/k3d-io/k3d/issues/1661) (open), #1622 | E7 smoke test; workaround documented in issue |
| kind on WSL2: **NetworkPolicy not enforced** (needs nfqueue modules) | [kind#3789](https://github.com/kubernetes-sigs/kind/issues/3789) (open) | Negative test; Calico if kind; else show enforcement on the VPS |
| k3s: policy applied *after* pod start → brief leak window | [k3s#13432](https://github.com/k3s-io/k3s/issues/13432) | Mention in the design note; default-deny flag pending (#14711) |

**Streams and shutdown [docs][issue]**
- **Traefik:** `respondingTimeouts.readTimeout` has defaulted to **60 s** since v2.11.2. Uploads fail at about 60,000 ms as
  a bare 502 with no reason logged (traefik #13503; #11788 declined to change the default). *Round 5: Go's
  `startBackgroundRead` clears the read deadline once the request body is consumed, so SSE responses are not cut by
  `readTimeout`; only a non-zero `writeTimeout` (default 0) would cut them (06-depth/05 §3.1). E3 stays as a
  confirmation test.* Use patched Traefik (v3.7.12+) because of the HTTP/3 timeout CVE.
- **Other idle limits:** NGINX defaults to a 60 s read timeout with buffering on; Azure's load balancer idles out after
  4 minutes. → Send SSE keep-alives at least every 30 s.
- **Shutdown.** Endpoint removal races `SIGTERM`. Use the native `preStop: sleep` action (beta and on by default since
  K8s 1.30, GA in 1.34; corrected in round 5 from the raw feature-gate files), a grace period
  longer than the drain time, end listen streams so clients reconnect elsewhere, and roll out with `maxUnavailable: 0`.
- **Browser connection limit.** Over HTTP/1.1, browsers allow about 6 connections per origin, so each `EventSource` tab
  uses one; local plain HTTP is HTTP/1.1. `EventSource` also can't send `Authorization`. → No permanent SSE in the
  dashboard: poll the audit log, and stream only per chat turn with `fetch()`.

**VPS [docs][reported]**
- **TLS hostname:** as in §0.11, avoid `cloudapp.azure.com` with Let's Encrypt. Limits are 50 new certificates/week per
  registered domain and 5 duplicates/week; staging allows 30,000. → Use a staging issuer first.
- **Helm 4** applies with server-side apply by default. Fields owned by another manager (e.g. after a `kubectl edit`) now
  fail loudly (`--force-conflicts` or `--server-side=false`).
- **MySQL:** 8.4 disables `mysql_native_password` by default. On cloud disks, the `lost+found` directory breaks
  `--initialize` (use `subPath`); `local-path` storage doesn't have it. MariaDB avoids both and uses less RAM.

### 2.7 LLMs and agent reliability

**Free tiers, October 2026 [docs][reported]**

| Provider | Free limits | Catches |
|---|---|---|
| Gemini (AI Studio) | Unpublished; ~20 RPD Flash, ~500 RPD Flash-Lite (3rd-party, Sep 2026) | Prompts used to improve products (outside EEA/UK/CH); Gemini 3 needs `thought_signature` echoed or 400; schema subset |
| Groq | 30 RPM, 1K RPD, **8K TPM**, 200K TPD per model | Tool schemas + history can exceed 8K tokens/min |
| NVIDIA API catalogue | ~40 RPM, rate-limited (credits phased out) | Tool-calling quality varies by model; verify (E8) |
| Mistral | ~$10/month credits | Trains on prompts unless you opt out |
| OpenRouter free models | 20 RPM, 50 RPD (1,000 RPD after a $10 top-up) | Free providers may log prompts |
| ~~GitHub Models~~ | Retired 2026-07-30 | — |
| ~~Cerebras free~~ | Gone ($5 trial with card) | — |

**Agent reliability [reported]**
- **τ-bench retail.** GPT-4o succeeded on 60% of tasks in one try but only 38% passed four tries in a row; 2025–26
  leaders score about 0.86–0.88. Agents using native function calling beat ReAct-style prompting on the same model.
- **Production failure rates.** 3–15% of tool calls fail. Silent failures (HTTP 200 with empty data), loops on the same
  call and arguments, and hallucinated arguments are the main patterns.
- → Design: `MAX_STEPS` with a final best-effort answer; stop on a repeated identical call; inject today's date and the
  store's timezone; confirm writes; return tool errors as they are; enforce limits in the gateway, not the prompt.

### 2.8 Keys, audit and roles [reported][docs]

- **API keys:**
  - Use a recognisable prefix (secret scanners can then detect leaked keys, as with GitHub `ghp_`, PyPI `pypi-`,
    Stripe `sk_live_`) plus a CRC32 checksum that rejects garbage without a database hit.
  - Show the key once. Store a fast keyed hash (Stripe stores HMAC-SHA256); bcrypt/argon2 add latency on every request and
    aren't needed for high-entropy keys.
  - Record last-used time. GitHub auto-revokes tokens unused for a year.
- **Audit:**
  - Record admin actions as well as tool calls (G17).
  - Record denials, not just successes.
  - Log the *shape* of arguments, or redacted values, never raw secrets or personal data (Docker; PY#3572).
- **Roles:** an empty allowlist means deny (nginx-ui). Separate "use" from "see config" (G18). Credentials are write-only.

### 2.9 The previous hiring cycle (store provisioning = our bonus) [code]

From `geekyhead/Urumi-system-design`, the most complete public submission:
- **`make test` runs the Definition of Done end to end.** It replays a request with an idempotency key, polls until Ready,
  then goes through the Store API cart (nonce + Cart-Token) to checkout with `payment_method: cod`. It asserts an order id
  and status, then deletes the store and checks the namespace and PVs are gone.
- **Helm Jobs are named with the revision**, because "a Job's pod template is immutable, so a fixed name would make every
  upgrade fail".
- **The seeder is idempotent.** It pins WooCommerce, Storefront and WordPress versions, runs `wp core update-db` and
  `wp wc update`, and seeds content once (guarded by an option flag).
- **Scaling guards.** A Postgres advisory lock serialises quota checks; a Lease elects one replica as leader. The chart
  **refuses `replicas > 1` with SQLite**.
- **Troubleshooting table:** port 80 in use, slow first image pull, a seeder that needs internet. It also offers a
  `*.localhost` fallback when `nip.io` is blocked.

From `nandan2003/urumi-kubernetes`: a "Known limitations" section, and a Round 2 that added a **LangGraph** agent driving
WP-CLI through `kubectl exec`. That suggests what a later round may ask, and why the current brief insists on an MCP server
with network isolation instead.

### 2.10 Production successes and talks [talk][reported]

- **GitHub MCP server lessons:**
  - 108 tools mapped 1:1 to the API was "a poor goal". Toolsets fixed it.
  - It filters tools by what the token allows: a classic PAT sees 20 read-only tools.
  - Error messages tell the agent what to do next.
  - Annotations flag destructive tools.
  - Embedding-based tool selection was **tried and shelved**.
  - Remote configuration via `/readonly` URLs and `X-MCP-Readonly`/`X-MCP-Lockdown` headers; lockdown is "a best-effort
    content filter, not a security boundary".
- **MCP Dev Summit NA 2026:**
  - Fewer than 20% of remote servers fully comply with the spec (Arcade).
  - The gateway as control plane: separate caller identity from downstream authorization (Arcade).
  - "Your server is deterministic, your user (the agent) is stochastic", so evaluate the agent (Red Hat; `mcpchecker`).
  - The server controls which tools are visible at each step ("progressive tool exposure", Concierge).
  - Read-only guardrails, query validation and human-in-the-loop "friction points" at 6M tool calls a month (Google).
  - Most of 56k MCP servers go unmaintained within 2 years; working CI from day one and a README that onboards in under
    5 minutes prevent it (AWS).
  - Code Mode collapses tools into search/execute; Cloudflare reports about 98% fewer tokens on complex workflows.
- **MCP Dev Summit Bengaluru 2026:**
  - Wipro, regulated banking: React portal + LangGraph agent + Microsoft MCP Gateway + 19-tool FastMCP server.
  - Freshworks: tenant context through the handshake, a distributed session store for rolling deploys, a **three-tier
    error model** (protocol/gateway/application), rate limiting and circuit breaking for third-party servers.
  - NitroStack anti-patterns: too many tools, excessive context sharing, weak boundaries, no observability, no governance.

### 2.11 Research on faults [paper]

- **arXiv 2606.05339** — 833 runtime fault threads from 473 server repos, sorted into 11 categories and 27 subcategories:
  protocol interactions, tool invocation, schema enforcement, state, model-provider integration, security validation,
  timeouts/cancellation. It names "configuration parameters that are accepted but not enforced at runtime". Developers had
  seen on average 20 of the 27 subcategories.
- **arXiv 2603.05637** — 407 faults from 279 server repos. The most common were server settings and server/tool/host
  configuration.
- **arXiv 2607.25635** — 1,723 MCP apps. 85.2% configure servers with files, 81.1% use an official SDK, and 90.8% log
  calls. Only **37.2% require approval before a tool runs**.

---

## 3. Never do (consolidated anti-patterns)

1. Forward client headers or tokens upstream (G4).
2. Ship a default secret or a "development" mode that skips security checks (G5).
3. Accept a policy field you don't enforce, or test only the "allowed" path (G6, the 2026 fault taxonomy).
4. Treat an empty allowlist as "allow all" (nginx-ui).
5. Build list and call requests on separate code paths (G3).
6. Derive the upstream's protocol or session needs from the client's (G1).
7. Fan out sequentially, or with all-or-nothing `Promise.all` (G15).
8. Trust a client to stop calling a tool it once saw (CC #97369).
9. Match error *strings* to decide reconnects (G13).
10. Validate URLs by parsing host names; let redirects through (G10, PY#3358).
11. Let a health check report OK without exercising a bounded version of the real path (G9).
12. Keep the catalog only in memory, or connect to every upstream at once on startup (G12).
13. Declare an output schema you haven't contract-tested (woocommerce #64195).
14. Grant cluster-wide Secrets access to an app's service account (G16).
15. Spawn processes from admin-supplied configuration (OX, LiteLLM).
16. Log raw tool arguments or personal data (Docker, PY#3572).
17. Rely on `nip.io` or `*.localhost` working the same on every network and in every client.
18. Rely on Let's Encrypt with a shared-suffix hostname.
19. Leave proxy timeouts at defaults for long-lived streams.
20. Build the demo on a free LLM tier without checking today's quota.

## 4. Always do (consolidated proven patterns)

1. **A terminating gateway serving both eras** on one endpoint; stateless for legacy; always emit `ttlMs`/`cacheScope`;
   normalise schemas.
2. **Per-upstream connection state** (era, session, last error, last-known catalog persisted). Bounded, parallel refresh.
   Re-initialise on 404. Own deadlines with `AbortController`.
3. **Authorization at list *and* call time.** Filter upstreams before fan-out. The dashboard shows each user's effective
   tool set. Every rule has a denial test.
4. **Build upstream requests from scratch.** Inject the stored credential; strip everything from the client.
5. **Errors in three tiers** (protocol / gateway / upstream-application), written for the agent ("server X is disabled by
   an admin"), with audit codes.
6. **Least privilege everywhere:**
   - a non-admin WooCommerce user;
   - read-only third-party upstreams (GitHub `/readonly`);
   - namespace-scoped RBAC, or none;
   - NetworkPolicy with a negative test.
7. **Audit admin actions and denials**, with redacted arguments and a correlation id that runs from chat to gateway to
   upstream.
8. **Operability as a feature:**
   - a one-command DoD check;
   - pinned versions with a recorded client matrix;
   - a troubleshooting table and a "known limitations" section;
   - a chart that refuses unsafe settings (`values.schema.json`, `fail` in templates).
9. **Approval for write tools in chat.** This is Rule of Two compliance, and only 37% of apps do it.
10. **Keep-alives, generous proxy timeouts, `preStop` sleep and drain**, so live updates survive.

---

## 5. What this means for each open decision (inputs, not decisions)

| Open decision (01 §7) | What the field evidence says | Leaning |
|---|---|---|
| Gateway style | Pass-through can't bridge eras (Kuadrant); terminating bridges, but must own per-upstream session state (agentgateway#2982) | Terminating |
| Gateway language / SDK | TS v2 has per-request factory, low-level Server, LangGraph JS adapters on v2; Python LangChain adapters still v1; known v2 gaps are patchable (§2.3) | TypeScript, SDK v2, low-level Server for proxied tools |
| WooCommerce MCP server language | Same SDK and test harness as the gateway reduces surface; Woo's own outputSchema failure argues for small, contract-tested tools | Same as gateway (TS) |
| Store channel | Basic over in-cluster HTTP with `X-Forwarded-Proto: https` works with the official image; OAuth1 needs public-URL signing + nonce writes | Basic + dedicated non-admin user + NetworkPolicy; pinned Woo |
| Extra upstreams (≥2) | GitHub: legacy + `Mcp-Param` requirement (TS#2639) → risky; Context7: critical CVE history; DeepWiki: no auth, legacy, read-only; an in-cluster server we own: offline-safe, perfect for kill-pod | DeepWiki + one in-cluster server; GitHub (read-only PAT) only if E12 passes |
| LLM | GitHub Models gone; Gemini limits opaque and low; Groq TPM tight; NVIDIA generous | Provider-agnostic client (OpenAI-compatible + Gemini); pick the default after E8 |
| Chat agent framework | Urumi's FDE posting names LangGraph; LangGraph JS + MCP adapters (v2) is small; hand-rolled loop is fewer deps | Either; LangGraph JS is a cheap signal if E8 shows it's stable |
| Local cluster | k3d matches k3s/Traefik on the VPS but has a WSL2 load-balancer bug; kind doesn't enforce NetworkPolicy on WSL2 | k3d if E7 passes; else kind + Calico |
| Gateway persistence | SQLite blocks replicas (S-7) and kill-pod-with-2-replicas demos; previous cycle's chart refused replicas>1 on SQLite | Postgres StatefulSet (small) |
| DB for WordPress | MySQL 8.4 auth plugin change + lost+found; MariaDB lighter | MariaDB 11.4 LTS (verify WC requirement ≥ 10.6) |
| VPS DNS/TLS | Azure label shares LE limits; DuckDNS on PSL; Student Pack domain is cleanest | Student Pack domain or DuckDNS; staging issuer first |
| Stand-out picks | Approval gating (37% do it), tested policy enforcement, client-compat matrix, DoD script are cheap and evidenced gaps | S-2 (tool permissions incl. argument rules) + S-6 hardening |

---

## 6. Experiments, updated

> **Round 6 (2026-10-10):** these were executed. Outcomes are in [07-experiment-results.md](07-experiment-results.md)
> §0:
> - **PASS:** E1, E3, E4, E5, E7, E12, E13, E14, E15, E16;
> - **finding:** E17 (kill-pod detection needs sub-restart detection and a 2 s connect timeout);
> - **not run:** E11 (Azure) and E18 (Cursor not installed);
> - E8 is in 07 §9.

| ID | Priority | What to verify | New since round 3 |
|---|---|---|---|
| E1 | P0 | Claude Code (pinned version) on both eras through our endpoint; `ttlMs`/`cacheScope` required; listen push works; `ENABLE_TOOL_SEARCH=false` effect; disable-server shows call-time denial | Cache-hint bug, stale-definition bug |
| E3 | P0 | Listen stream survives >60 s through k3s Traefik (readTimeout) and >4 min idle (keep-alives) | Promoted from P1 |
| E4 | P0 | Revoked key: Claude Code shows "failed" (docs say so); Inspector behaviour on 401 vs 403 (#2515); choose response shape | Partly answered by docs |
| E5 | P0 | Basic auth in-cluster via `X-Forwarded-Proto`; key scope; date/null normalisation for our tool outputs | Code-verified path |
| E7 | P0 | k3d on this Windows box: LB bug, `winnat` ports, `*.localhost` from Node, `nip.io` on this network, **negative NetworkPolicy test** | WSL2 enforcement gap |
| E8 | P1 | AI Studio quota page for this account; Gemini thought signatures in multi-turn tool use; Groq TPM with our tools; NVIDIA tool calling | Free-tier changes |
| E12 | P1 | DeepWiki through our gateway (legacy session handling); GitHub `/readonly` with PAT and `Mcp-Param` requirement | GitHub interop risk |
| E13 | P1 | Soak: 20k requests through per-request low-level Server; memory flat | SDK leak history |
| E14 | P1 | Upstream restart → 404 → re-init → retry once | MCPHub#742, TS#1708 |
| E15 | P2 | SSRF test vectors from ToolHive#6197 + redirect to 169.254.169.254 | — |
| E16 | P1 | `make demo-check` style DoD script locally and on the VPS | Previous-cycle success pattern |
| E11 | P2 | Azure VM + k3s + DuckDNS/Student domain + cert-manager staging→prod | Azure label LE trap |

---

## 7. Limits of this round

- I read issue *titles and bodies*, not every comment. Several findings are open bugs that may be fixed by the time we
  build, which is why E1/E4 pin versions and test.
- Free-tier numbers move monthly and Google no longer publishes its own. Treat §2.7 as a snapshot.
- Conference content is from abstracts, not recordings.
- Chinese-language sources were only lightly covered (MCPHub, Unla). Discord and Slack communities aren't searchable.
- Nothing in this round was executed. Everything marked [unverified] is an experiment, not a fact.

---

## Sources (this round)

**MCP clients:**
- Claude Code issues: [#88128](https://github.com/anthropics/claude-code/issues/88128), [#95504](https://github.com/anthropics/claude-code/issues/95504), [#86142](https://github.com/anthropics/claude-code/issues/86142), [#97369](https://github.com/anthropics/claude-code/issues/97369), [#66084](https://github.com/anthropics/claude-code/issues/66084), [#96183](https://github.com/anthropics/claude-code/issues/96183), [#93290](https://github.com/anthropics/claude-code/issues/93290), [#39790](https://github.com/anthropics/claude-code/issues/39790), [#78193](https://github.com/anthropics/claude-code/issues/78193), [#33817](https://github.com/anthropics/claude-code/issues/33817), [#29562](https://github.com/anthropics/claude-code/issues/29562), [#48514](https://github.com/anthropics/claude-code/issues/48514)
- Other clients: [VS Code #329848](https://github.com/microsoft/vscode/issues/329848), [Inspector #2515](https://github.com/modelcontextprotocol/inspector/issues/2515), [Cursor forum: headers dropped](https://forum.cursor.com/t/streamable-http-mcp-mcp-json-headers-besides-x-domainhost-key-are-dropped-on-tools-call/169015), [Cursor MCP docs](https://cursor.com/docs/context/mcp), [Cursor 40-tool warning](https://forum.cursor.com/t/mcp-server-40-tool-limit-in-cursor-is-this-frustrating-your-workflow/81627), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**Gateways:**
- agentgateway: [#2982](https://github.com/agentgateway/agentgateway/issues/2982), [#3586](https://github.com/agentgateway/agentgateway/issues/3586), [#3063](https://github.com/agentgateway/agentgateway/issues/3063), [#3092](https://github.com/agentgateway/agentgateway/issues/3092)
- Kuadrant: [#926](https://github.com/Kuadrant/mcp-gateway/issues/926), [#1483](https://github.com/Kuadrant/mcp-gateway/issues/1483)
- [MCPJungle #252](https://github.com/mcpjungle/MCPJungle/issues/252)
- ContextForge: [#6664 (GHSA-5424-f25v-29r8)](https://github.com/IBM/mcp-context-forge/issues/6664), [#6869](https://github.com/IBM/mcp-context-forge/issues/6869)
- Obot: [#8180](https://github.com/obot-platform/obot/issues/8180), [#7625](https://github.com/obot-platform/obot/issues/7625)
- ToolHive: [#6345](https://github.com/stacklok/toolhive/issues/6345), [#6197](https://github.com/stacklok/toolhive/issues/6197), [#5860](https://github.com/stacklok/toolhive/issues/5860)
- MCPHub: [#1154](https://github.com/samanhappy/mcphub/issues/1154), [#742](https://github.com/samanhappy/mcphub/issues/742), [#375](https://github.com/samanhappy/mcphub/issues/375), [#1036](https://github.com/samanhappy/mcphub/issues/1036)
- MetaMCP: [#142](https://github.com/metatool-ai/metamcp/issues/142), [#162](https://github.com/metatool-ai/metamcp/issues/162)
- Others: [Unla #299](https://github.com/AmoyLab/Unla/issues/299), [mcp-proxy #235](https://github.com/sparfenyuk/mcp-proxy/issues/235), [Microsoft mcp-gateway #17](https://github.com/microsoft/mcp-gateway/issues/17)

**SDKs:**
- TypeScript: [#2844](https://github.com/modelcontextprotocol/typescript-sdk/issues/2844), [#2695](https://github.com/modelcontextprotocol/typescript-sdk/issues/2695), [#2739](https://github.com/modelcontextprotocol/typescript-sdk/issues/2739), [#1708](https://github.com/modelcontextprotocol/typescript-sdk/issues/1708), [#2964](https://github.com/modelcontextprotocol/typescript-sdk/issues/2964), [#2639](https://github.com/modelcontextprotocol/typescript-sdk/issues/2639), [#2677](https://github.com/modelcontextprotocol/typescript-sdk/issues/2677), [#2721](https://github.com/modelcontextprotocol/typescript-sdk/issues/2721), [#2607](https://github.com/modelcontextprotocol/typescript-sdk/issues/2607), [schema-libraries doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/schema-libraries.md), [low-level server doc](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/low-level-server.md)
- Python: [#3358](https://github.com/modelcontextprotocol/python-sdk/issues/3358), [#3572](https://github.com/modelcontextprotocol/python-sdk/issues/3572)

**Security:**
- Incident timelines: [Digital Applied incident ledger](https://www.digitalapplied.com/blog/mcp-security-incident-ledger), [AuthZed breach timeline](https://authzed.com/blog/timeline-mcp-breaches), [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-security-crisis-20260504-csa-styled/)
- Specific incidents: [GitGuardian on Smithery](https://blog.gitguardian.com/breaking-mcp-server-hosting/), [Context7 ContextCrush](https://www.infosecurity-magazine.com/news/contextcrush-ai-development-tools), [CVE-2026-30623 (LiteLLM)](https://research.averlon.ai/vulnerability-intelligence/cve/CVE-2026-30623), [CVE-2026-34742 (Go SDK)](https://nvd.nist.gov/vuln/detail/CVE-2026-34742)
- Frameworks: [Agents Rule of Two (Simon Willison summary)](https://simonw.substack.com/p/new-prompt-injection-papers-agents), [OWASP Agentic Top 10 overview](https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026)

**WordPress and WooCommerce:**
- Code: [WooCommerce REST authentication](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-rest-authentication.php), [docker-library wordpress](https://github.com/docker-library/wordpress)
- WooCommerce issues: [#64195](https://github.com/woocommerce/woocommerce/issues/64195), [#69325](https://github.com/woocommerce/woocommerce/issues/69325), [#69345](https://github.com/woocommerce/woocommerce/issues/69345)
- WordPress: [mcp-adapter #116](https://github.com/WordPress/mcp-adapter/issues/116), [WP 6.8 bcrypt/BLAKE2b](https://make.wordpress.org/core/2025/02/17/wordpress-6-8-will-use-bcrypt-for-password-hashing/)
- Docs: [Woo REST API docs](https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication)

**Kubernetes and networking:**
- Local clusters: [k3d #1661](https://github.com/k3d-io/k3d/issues/1661), [kind #3789](https://github.com/kubernetes-sigs/kind/issues/3789), [k3s #13432](https://github.com/k3s-io/k3s/issues/13432)
- Traefik: [#13503](https://github.com/traefik/traefik/issues/13503), [truecharts #20877](https://github.com/truecharts/charts/issues/20877), [Mercure reverse-proxy guide](https://mercure.rocks/docs/1.0/deployment/reverse-proxy)
- Name resolution: [Tailscale DNS rebinding FAQ](https://tailscale.com/docs/reference/faq/dns-rebinding.md), [curl and localhost](https://daniel.haxx.se/blog/?p=16602)
- Kubernetes and Azure: [K8s 1.33 lifecycle updates](https://kubernetes.io/blog/2025/05/14/Kubernetes-v1-33-updates-to-container-lifecycle/), [Azure LB idle timeout](https://azure.microsoft.com/en-us/blog/new-configurable-idle-timeout-for-azure-load-balancer/)
- Let's Encrypt: [rate limits](https://letsencrypt.org/docs/rate-limits/), [cloudapp.azure.com rate-limit thread](https://community.letsencrypt.org/t/rate-limit-issue-with-cloudapp-azure-com/217156), [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat)
- Browsers: [EventSource over HTTP/1.1](https://textslashplain.com/2019/12/04/the-pitfalls-of-eventsource-over-http-1-1/)
- Helm: [Helm 4 migration](https://computingforgeeks.com/migrate-helm-3-to-helm-4-kubernetes/)
- Databases: [MySQL 8.4 native password](https://dev.mysql.com/doc/refman/8.4/en/native-pluggable-authentication.html), [WP trac #61218](https://core.trac.wordpress.org/ticket/61218)

**LLMs and agents:**
- Gemini: [pricing](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures), [free-tier cut thread](https://discuss.ai.google.dev/t/do-they-really-think-we-wouldnt-notice-a-92-free-tier-quota-nerf/111262)
- Other providers: [GitHub Models retired](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/), [Free LLM tiers Oct 2026](https://dev.to/tariqnasser/free-llm-api-tiers-in-october-2026-whats-left-and-how-i-chain-them-227l), [OpenRouter free API comparison](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/), [NVIDIA NIM FAQ](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317)
- Agent reliability: [τ-bench overview](https://benchmarkingagents.com/tau-bench-retail-airline), [Openlayer agent failure modes](https://www.openlayer.com/blog/post/ai-agent-failure-modes-tool-calling-loops-propagation)

**Talks, production lessons, research:**
- Talks: [MCP Dev Summit NA 2026 talks](https://mcpdevsummitna26.sched.com/list/descriptions/type/MCP+Best+Practices), [MCP Dev Summit Bengaluru 2026](https://mcpbengaluru26.sched.com/list/descriptions/company/Any), [Sentry/Cramer talk](https://ai.engineer/talks/mcp-is-not-good-yet-david-cramer-sentry)
- GitHub's MCP server: [Arcade on GitHub's MCP lessons](https://www.arcade.dev/blog/enterprise-mcp-lessons-from-githubs-mcp-server-launch), [GitHub remote MCP server docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- Other: [Cloudflare Code Mode (InfoQ)](https://infoq.com/news/2026/04/cloudflare-code-mode-mcp-server), [GitHub token format](https://github.blog/changelog/2021-03-31-authentication-token-format-updates-are-generally-available/), [API key best practices (Zuplo)](https://zuplo.com/blog/api-key-best-practices)
- Papers: [arXiv 2606.05339](https://arxiv.org/abs/2606.05339), [arXiv 2603.05637](https://arxiv.org/abs/2603.05637), [arXiv 2607.25635](https://arxiv.org/abs/2607.25635)
- Previous-cycle submissions: [geekyhead/Urumi-system-design](https://github.com/geekyhead/Urumi-system-design), [nandan2003/urumi-kubernetes](https://github.com/nandan2003/urumi-kubernetes)
