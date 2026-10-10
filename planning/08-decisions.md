# 08 — Final decisions (2026-10-11)

The 17 open items from `06-depth/00-index.md` §3, decided with the evidence in `07-experiment-results.md` (cited as
07 §n). One line of choice, one line of why. Defaults pre-authorized by the user for the overnight build.

1. **Gateway build:** TypeScript on Node 24, MCP TS SDK v2: low-level `Server` behind `createMcpHandler` downstream;
   `Client` with `versionNegotiation: {mode:'auto'}` upstream.
   Why: the only setup verified dual-era on one URL with Claude Code 2.1.296 and a working `toolsChanged` push (07 §0, §17).
2. **HTTP framework:** Hono 4.13.
   Why: fetch-native like `createMcpHandler` (Request → Response), so no adapter glue; tiny and fast to build.
3. **Dashboard:** Vite 8 + React 19 SPA + TanStack Query, built static and served by the gateway.
   Why: one origin (no CORS, simple cookies), one fewer Deployment; Next adds SSR we don't need.
4. **Persistence:** Postgres 18 with plain `pg`; SQL migrations at app start under `pg_advisory_lock`.
   Why: multi-replica-safe, the audit log is relational, and `pg` keeps every query explainable.
5. **Auth:** hand-rolled: scrypt passwords, session cookie + CSRF header, roles admin/member, API keys `urumi_…`
   stored as HMAC-SHA256 with a pepper, revocable.
   Why: ~400 lines we can explain line by line; Better Auth's defaults (rate limit) fight us (06 §2.4).
6. **Chat identity:** delegated short-lived JWT (`sub` = user, `act` = chat-agent); the agent is a normal MCP client.
   Why: the audit log and authorization see the real user on the same path as any client (06 §4).
7. **Chat framework:** AI SDK 7 (`useChat`, `toolApproval`).
   Why: E8 scored AI SDK and LangGraph both 6/6 pass^3 with approvals through our gateway (07 §9); AI SDK is
   faster to integrate in the React UI. Mind the adapter's tool-name prefix.
8. **LLM default:** OpenAI-compatible base URL; local Ollama `qwen3.5-agent` at `http://host.k3d.internal:11434/v1`,
   reasoning off; a hosted free-tier provider configurable by env.
   Why: verified reachable from pods and passing E8 (07 §9); no key needed for the local demo.
9. **Extra upstreams:** our woo-mcp + DeepWiki (public, legacy era) + `demo-upstream` (our own small in-cluster server).
   Why: DeepWiki verified in the DoD walk; our own server is what we kill for the dead-upstream demo (07 §8, §14).
10. **`tools/list` TTL:** short (5 s) and always per-user `private`.
    Why: lists are filtered per user; a short TTL keeps changes visible without hammering upstreams (03 §4).
11. **Unreachable server's tools:** stay listed briefly with a clear error result, hidden after 3 strikes.
    Why: a blip shouldn't churn client tool lists; a dead server shouldn't advertise tools (03 §2, 09 §2).
12. **New/changed tools:** first sight approved by the admin who adds the server; a *changed* tool definition is
    quarantined until re-approved (part of S-2; default-allow until S-2 lands).
    Why: tool-poisoning defence without blocking the DoD (08 §4).
13. **Kill-pod detection:** EndpointSlice watch (SA + read-only Role) for in-cluster upstreams + call-time failure
    classification + 1–2 s tick for external ones + fast re-probe + status history.
    Why: watch flagged a killed pod in ~0.2 s; a 5 s tick never saw it (pod back in ~2 s) (07 §14).
14. **`create_product` status:** explicit `status` param (agent passes `publish`), shown in the approval card.
    Why: DoD needs storefront visibility, and the approval should show what will happen (04 §2.2).
15. **"Today" for orders:** date + store timezone in the system prompt + a `created_after` tool param.
    Why: WC REST dates lack offsets; we use `*_gmt` + `Z` and let the model pass an explicit bound (04 §2.3).
16. **Local hostnames:** `*.127.0.0.1.nip.io` on :8080 (8443 for TLS).
    Why: resolves here and in Node; `*.localhost` fails in Node (07 §7).
17. **Stand-outs:** only after `demo-check.sh` passes: S-2 (tool permissions/argument rules + TOFU), then S-6
    (hardening), then S-8 (OTel) if time.
    Why: "a working core is worth more than an unfinished bonus" (brief).
