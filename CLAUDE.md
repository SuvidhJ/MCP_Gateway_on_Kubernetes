# CLAUDE.md: context for any session in this repo

## What this repo is
Round 1 submission for the Urumi.AI Forward Deployed Engineer internship: **"MCP Gateway on Kubernetes"**
(brief: [`project.md`](project.md)). Build, on Kubernetes with a Helm chart:
1. a WooCommerce store (WordPress + DB);
2. our own WooCommerce MCP server (5 tools: list/create products, list/get orders, update order status);
3. a gateway + React dashboard (register upstream MCP servers, one aggregated MCP endpoint, team members, per-user API
   keys, audit log);
4. a chat agent in the dashboard that calls tools through the gateway as the logged-in user.

Graded on a working core (the Definition of Done in `project.md`) plus deep understanding. Budget: **free tiers
only** (student). Deadline told on 2026-10-09: "1.5 weeks", so about **2026-10-19/20** (exact date/time zone still
unconfirmed: ask).

## Where we are (2026-10-10)
| Phase | Status | Output |
|---|---|---|
| 1 Understanding | done | `planning/01-understanding.md` (requirement IDs M-*, D-*, S-*, B-*) |
| 2 Landscape | done | `planning/02-landscape-research.md` |
| 3 Knowledge + deep dive | done | `planning/03-knowledge-base.md`, `planning/04-deep-dive-and-options.md` |
| 4 Failures/successes | done | `planning/05-failures-and-successes.md` (G1–G20, never/always lists, experiments E1–E18) |
| 5 Depth from primary sources | done | `planning/06-depth/` (start at `00-index.md`) |
| 6 Experiments | done (E8 local-model run in 07 §9) | `planning/07-experiment-results.md` + `experiments/` (spike code) |
| **7 Final decisions** | **next** | decide the 17 items in `planning/06-depth/00-index.md` §3 using 07's evidence |
| 8 Build, test, deploy, video, write-up | after 7 | product code (not started) |

**No product code exists yet.** `experiments/` is throwaway spike code: reuse ideas and snippets, don't ship it.

## Reading order for a new session
1. `project.md` (brief), then `planning/06-depth/00-index.md` (the end-to-end path, 25 settled constraints, 17 open
   decisions with leanings, version pins).
2. `planning/07-experiment-results.md` §0 (what was measured), §17 (corrections), §18 (new requirements).
3. The topic doc in `planning/06-depth/` for whatever you're building (01 protocol, 02 SDK, 03 gateway mechanics,
   04 WooCommerce, 05 k8s/Helm, 06 identity/audit, 07 chat agent, 08 security, 09 clients/demo, 10 upstreams/OTel/data).

## Hard-won facts (don't relearn these)
- **The gateway must be dual-era on one URL** (MCP 2026-07-28 modern + 2025 legacy) and talk to both eras upstream.
  TS SDK v2: `createMcpHandler` + low-level `Server` downstream; `Client` with `versionNegotiation: {mode:'auto'}`
  upstream.
- Claude Code 2.1.296 is modern-first: discover → tools/list → `subscriptions/listen`. A push via
  `handler.notify.toolsChanged()` works. On 401/403 it shows our error text and never attempts OAuth.
- `createMcpHandler` validates **no Host/Origin/token**; we add guards and the key check. A handler throw becomes
  `-32603`, so return `isError` results ourselves.
- SDK client gaps: no 404 session re-init (we do it, gated on a session id); output-schema validation throws; listen
  is never re-opened.
- **Upstream dispatcher:** SSRF guard at connect time (`experiments/spike/ssrf-guard.mjs`), **2 s connect timeout**,
  per-upstream call timeout, fetch-level deadlines, `bodyTimeout: 0` for upstream listen streams.
- **Health:** independent loop per upstream; classify failures (hard → unreachable now, soft → strikes, auth →
  `auth_failed`); fast re-probe; a pod kill self-heals in ~2 s, so tick-only detection misses it.
- **WooCommerce:**
  - Basic auth in-cluster works only with `X-Forwarded-Proto: https`;
  - bootstrap must set permalinks, coming-soon `no`, COD, a free-shipping zone, HPOS, timezone, the
    `mcp_store_agent` role, and 43-char WC keys with a checked insert;
  - REST dates have no offset (use `*_gmt` + `Z`);
  - no status transition rules, so our policy guards them;
  - `customer_note` is untrusted buyer text.
- **k8s:**
  - Traefik doesn't cut SSE/long calls; Node `fetch` cuts after 300 s without bytes, so keep 15 s keep-alives;
  - NetworkPolicy enforces ~1.3 s after apply (kube-router REJECT → ECONNREFUSED);
  - Helm 4 hooks don't wait for readiness, so Jobs retry;
  - local hostnames: `*.127.0.0.1.nip.io`, not `*.localhost`.

## Environment on the dev box (Windows 11)
- Docker Desktop, kubectl 1.36, `~/bin/k3d.exe` 5.9.0, `~/bin/helm.exe` 4.3.0, Go, Python 3.14, gh (logged in).
- Node default 22.16; use **`fnm exec --using=24.21.0 node`** (product runtime pin is Node 24).
- k3d cluster **`urumi`** (k3s v1.36.5) is **stopped**. It holds namespaces `exp` (spike gateway, upstreams, woo-mcp,
  NetworkPolicies) and `store` (WordPress + WooCommerce + MariaDB, bootstrapped). Restart with `k3d cluster start urumi`
  (~20 s, data kept); delete with `k3d cluster delete urumi` before creating the product cluster.
- Ollama 0.40.2 with models in `E:\ollama\models`; GPU RTX 4060 Laptop 8 GB (local LLM for dev/evals).
- Claude Code CLI: the VS Code extension binary (`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude.exe`).
- Bash tool = Git Bash: use `MSYS_NO_PATHCONV=1` for container paths; Python on Windows writes CRLF unless
  `newline='\n'`.
- Bandwidth is ~1.5 MB/s: pre-pull images and models. **C: has only ~12 GB free** (Docker's disk image lives there);
  consider moving Docker's disk image to E: before building more images.

## Working rules
- Commits: global git identity (`SuvidhJ <suvidh.jain2023@vitstudent.ac.in>`); never add Claude as author/co-author.
  Commit or push only when asked.
- Free tiers only; prefer primary sources (spec, source code, live probes) over summaries; record versions and dates.
- Keep the DoD flow working before any bonus ("a working core is worth more than an unfinished bonus").
