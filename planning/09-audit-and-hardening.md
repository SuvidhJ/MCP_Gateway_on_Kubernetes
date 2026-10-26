# 09: audit (2026-10-18) and the hardening pass that followed

Live audit on a fresh k3d install (Docker reset, images rebuilt): `demo-check.sh` 35/35 plus extra probes. This file is
the bug log for the follow-up pass: every partial or missing item from `project.md` (except submission and the VPS),
and every defect found by reading the code end to end and attacking the running system.

Status: `fixed` (with the test that proves it), `open`, `wontfix` (with the reason).

## A. Found by the live audit

| # | Area | Defect | Status |
|---|---|---|---|
| A1 | up.sh | Fresh Docker Desktop (containerd image store): BuildKit provenance attestation makes `k3d image import` fail ("content digest not found") while printing success; pulled multi-platform images fail the batch; Helm then times out on the bootstrap hook | fixed: `--provenance=false`, import only our images, verify each with `crictl`, `--timeout 10m` (fresh install passes) |
| A2 | chart | Store Ingress has no `tls:` block; prod sets `WP_HOME=https://…` | fixed: TLS block on both Ingresses; per-host secrets when `tls.clusterIssuer` (cert-manager) is set |
| A3 | chart | `llm-api-key` reset to `none` by any `helm upgrade` without `--set gateway.llm.apiKey` | fixed: `--set` value wins, else the live Secret value (`lookup`), else `none` |
| A4 | gateway | Call with a revoked key (or a disabled user's key) is rejected with 401 but not written to the audit log | fixed: known-but-refused credentials are audited `rejected` under their owner (demo-check step 4) |
| A5 | chart | No CPU limits anywhere (memory limits only) | fixed: CPU + memory limits on every container (values per component) |
| A6 | api | Admin cannot issue a key for another member (story: "issue or revoke their API keys") | fixed: `POST /keys {userId}` for admins; dashboard owner picker (attack-check B) |
| A7 | chart | Default-deny covers ingress only; egress unrestricted | fixed: `default-deny` both directions + DNS + per-workload egress; verified from inside each pod |
| A8 | chart | WordPress (Apache) runs as root | fixed: image serves the root-owned code from /usr/src/wordpress as uid 33 on :8080, read-only rootfs, PHP disabled in uploads |
| A9 | gateway | Rate limit is per replica (2 replicas = 2x the configured limit per key) | fixed: token buckets in Postgres (one atomic upsert); 70 parallel requests on 2 replicas -> <=48 allowed (attack-check E) |

## B. Found by reading the code

| # | Area | Defect | Status |
|---|---|---|---|
| B1 | gateway/upstreams | Upstream fetches follow redirects: a malicious registered server can 307 the gateway's POSTs to in-cluster `woo-mcp` (allow-listed host), bypassing tool permissions under its own slug | fixed: `redirect: 'error'` on every upstream fetch (unit test `redirect.test.ts`) |
| B2 | woo-mcp | No authentication; relies on NetworkPolicy alone (defence in depth: bearer token from a Secret) | fixed: woo-mcp + demo-upstream require a bearer token from a Secret; gateway seeds/syncs it (`credentialEnv`) |
| B3 | gateway/config | Hard-coded dev fallbacks for pepper / JWT / credential key / admin password / DB URL are used if env is missing | fixed: secrets required when NODE_ENV=production; random per-process values in dev; no literals in source |
| B4 | gateway/upstreams | Race: an in-flight connect for the old URL/credential can install its client after an admin edit (no generation check); concurrent `call()`s with no client each create a Client (leak) | fixed: generation counter + single-flight connect; stale connects close themselves |
| B5 | gateway/mcp | A call cancelled by the client counts as an upstream timeout strike and is audited `timeout` | fixed: aborted calls are `cancelled`, no strike |
| B6 | gateway/mcp | Calls while status is `connecting` (startup, after re-enable) fail with "unreachable" instead of trying | fixed: `connecting` servers are tried (call connects) |
| B7 | api | Upstream URL shown to members verbatim: query-string keys / userinfo (`?api_key=…`, `user:pass@`) leak; same in `lastError` | fixed: members get URLs without userinfo/query values, also in `lastError` and history; userinfo rejected at input (attack-check D) |
| B8 | gateway/sealed | A credential that cannot be decrypted (key rotated) throws inside `load()` and crash-loops the gateway | fixed: undecryptable credential -> that server `auth_failed` with the reason; gateway healthy (attack-check G) |
| B9 | gateway/pins | Admin changing a server URL keeps the old pins, so the new server's tools are quarantined | fixed: URL change resets that server's pins (trust on first use for the new server) |
| B10 | gateway/pins | A tool newly added by an upstream after approval is exposed immediately (rug pull by addition) | fixed: tools appearing after approval are quarantined as `new` (attack-check F) |
| B11 | api | No rate limit on `/api/auth/login` (password guessing) | fixed: failed-login budget per account (10/min) and per address (50/min), shared buckets, constant-time unknown-user path (attack-check A) |
| B12 | gateway | No request body limits (`/api/*`, `/api/chat`, `/mcp`) | fixed: 256 KB `/api`, 2 MB chat, 4 MB `/mcp`; refused bodies close the connection (a reused proxy connection 502'd the next request) |
| B13 | gateway | `/api/chat`: invalid JSON → 500; `messages` unvalidated; no per-user chat rate limit | fixed: schema-validated body, 400 on bad JSON, client `system` messages dropped, 20 turns/min per user |
| B14 | api/ui | Members can't change their temporary password; admins can't reset one | fixed: invite/reset passwords are temporary (forced change, API-enforced); change ends other sessions; admin reset |
| B15 | api | Unlimited API keys per user | fixed: 25 active keys per member |
| B16 | gateway/db | Expired sessions, audit log and upstream events grow forever (no retention) | fixed: 10-min housekeeping under an advisory lock (sessions, buckets, 90-day audit, 30-day events) |
| B17 | ui | Clearing the per-server timeout in the edit form can't reset it to the default | fixed |
| B18 | gateway/mcp | Upstream tool names are passed through unchecked (characters/length clients reject); results have no size cap | fixed: client-facing names sanitised to `[A-Za-z0-9_-]{1,64}` with collision suffixes (unit tested); 2 MB result cap (`too_large`) |
| B19 | woo-mcp | No `page` parameter (only the first 50 products/orders reachable); buyer-written fields other than the note unlabelled; SIGTERM can hang on open streams | fixed: `page` on list tools (+ `pages`), buyer fields labelled untrusted, bounded SIGTERM |
| B20 | gateway | `/healthz` is used for readiness but never checks Postgres | fixed: readiness `/readyz` checks Postgres; liveness stays `/healthz` |
| B21 | chart | Metrics port 9091 unreachable from any Prometheus (only 8080 allowed in) | fixed: `networkPolicy.metricsFromNamespaces` |
| B22 | ui | Audit outcome filter/badges miss newer outcomes (`quarantined`, …) | fixed |

## C. Missing stand-outs / bonus (being built)

| # | Item | Status |
|---|---|---|
| C1 | OAuth on the gateway (MCP authorization spec 2026-07-28: PRM, AS metadata, CIMD + DCR, PKCE S256, RFC 8707 resource, RFC 9207 iss, rotating refresh tokens) | done: `oauth.ts`, dashboard Connected apps; `oauth-check.mjs` 49/49 (SDK client end to end, CIMD as Claude Code); Claude Code reports the gateway `needs-auth` |
| C2 | Hosted MCP servers (add by container image; own Secret, limits, NetworkPolicy; clean removal) | done: `provisioner` + Servers → Deploy from image; `provision-check.sh` |
| C3 | Bonus: multi-store provisioning (namespace per store, quotas, isolation, auto-registration, recovery, teardown) | done: `packages/provisioner`, Stores page; `provision-check.sh` 67/67 (parallel, idempotent, per-user cap, timeout + retry, provisioner restart mid-way, isolation, chat across two stores, teardown, admission policy) |

## D. Found by adversarial end-to-end testing

| # | Area | Defect | Status |
|---|---|---|---|
| D1 | gateway/seed | Seeded upstream tokens were stored raw; the credential field is the whole header value, so woo-mcp got `Authorization: <token>` and refused (401) | fixed: seeds from env are sent as `Bearer <token>` |
| D2 | gateway | A 413 for an oversized body left the unread body on Traefik's pooled backend connection: the next request on it got a 502 | fixed: `Connection: close` on refused bodies (15/15 follow-up requests 200) |
| D4 | oauth | DCR refused `cursor://…` redirects (rule demanded a dotted scheme): Cursor couldn't sign in | fixed: any non-dangerous app scheme; consent warns it opens an app |
| D5 | oauth | Revoking a grant deleted its tokens, so later calls were anonymous "unknown token" instead of audited `rejected` | fixed: revocation only marks the grant |
| D6 | gateway | `/api/*` body limit (256 KB) also applied to `/api/chat`, overriding its 2 MB limit | fixed: one limiter per path |
| D7 | provisioning | A member-chosen store name flows into every user's tool descriptions ("…in the <name> store"): a prompt-injection channel between users | fixed: names limited to 40 plain characters |
| D8 | provisioning | Stores with TLS but without cert-manager pointed at a per-store Secret that can't exist (Secrets don't cross namespaces) | fixed: host listed without a secret, Traefik's default certificate is used |
| D9 | chart | VAP `resources: ["*", "*/*"]` is invalid (API server rejects mixing) | fixed: `["*/*"]` |
| D10 | ops | `rollout status` returns while old pods still serve: the next test/command can hit the previous version | fixed: `up.sh` waits until no pod is Terminating |
| D11 | gateway | `Cross-Origin-Opener-Policy` sent on plain http: browsers ignore it and log a warning | fixed: only with https |
| D12 | woo-mcp | `per_page` max 50 made the model retry list calls (WooCommerce allows 100) | fixed: 100 |
| D3 | ops | Our own woo-mcp upgrade (new `page` parameter) quarantines its changed tools until an admin approves: correct, but needed a bulk action | fixed: `POST /servers/:id/approve-all` + dashboard button; documented as an upgrade step |

## E. Final pre-submission audit (2026-10-26): every brief item re-checked against the code

| # | Area | Defect | Status |
|---|---|---|---|
| E1 | chart/prod | `values-prod.yaml` had no `images.provisioner`: a VPS install would try to pull `urumi/provisioner:dev` | fixed |
| E2 | chart/prod | With cert-manager, the HTTP-01 solver pod runs in our default-deny namespaces: Let's Encrypt could never reach it, so no certificate would be issued (release namespace and every store) | fixed: `acme-http01-solver` policy (ingress controller → solver :8089) in the chart and in each store namespace, only when a cluster issuer is set; unit-tested |
| E3 | chat | If listing tools or converting the history failed, the chat's MCP client to our own `/mcp` was never closed | fixed: closed on that path |
| E4 | gateway | In many-tools mode `gateway__search_tools` calls were not audited ("every tool call" is) | fixed: audited as server `gateway`, tool `search_tools` |
| E6 | gateway (replicas) | Approving a new/changed tool could 404 "no such tool": the dashboard showed it from one replica, the approve request hit the other, whose health loop hadn't re-listed that server yet (approve-all likewise approved nothing). Found by `attack-check.sh` F on a fresh cluster | fixed: approve, approve-all and access changes re-list the server's tools first when needed |
| E7 | woo-mcp | With the store database down (MariaDB pod hard-killed) the tool error carried WordPress's raw HTML (`<h1>Error establishing a database connection</h1>`) | fixed: tags stripped; unit-tested |
| E8 | gateway chat | On the VPS (2026-10-26) the chat sat on "thinking" forever: Gemini's free tier answered `gemini-3.8-flash` with 503 "high demand" or no bytes for >90 s, and nothing bounded the wait (2.5 models: 404 for new keys) | fixed: `LLM_MODEL` takes a fallback list; per step, a model that errors or sends no output within 20 s hands over to the next; all failing → a visible error. Unit-tested (503, hang, headers-then-silence, error part, user abort); live 3/3 tool loops completed while Gemini was overloaded (18-51 s) |
| E9 | provisioner + cert-manager | Live on the VPS: a provisioned store (`e2e`) was Ready with MCP auto-registered, but its host kept Traefik's default certificate: cert-manager's HTTP-01 solver creates a **NodePort** Service by default and the store namespace quota allows `services.nodeports: 0` | fixed: the ClusterIssuer's solver uses `serviceType: ClusterIP` (`scripts/vps-up.sh`) |
| E10 | ingress | `http://gateway…` and `http://store…` were served (200) instead of redirected: a first login over plain HTTP would send the password in clear text (HSTS only helps after an HTTPS visit) | fixed: the gateway 308-redirects when its public URL is HTTPS and Traefik reports `X-Forwarded-Proto: http`; stores 301 to `WP_HOME` (mu-plugin). Probes, wp-cli and woo-mcp (`X-Forwarded-Proto: https`) unaffected |
| E11 | WordPress | Anonymous user enumeration (`/wp-json/wp/v2/users` listed `admin`; `?author=1` → `/author/admin/`), version disclosure (`readme.html`, `license.txt`) and an exposed `xmlrpc.php` | fixed: mu-plugin `urumi-hardening.php` (users endpoint for logged-in users only, author archives redirect home) + Apache denies those files |
| E12 | gateway MCP | 2025-era (legacy) clients were told `tools.listChanged: true`, but the SDK serves them statelessly (GET → 405), so no notification can reach them; modern clients got it in 0.5 s through Traefik/TLS | fixed: `listChanged` advertised to modern clients only; legacy clients see changes on their next `tools/list` (documented) |
| E13 | scripts | `up.sh` / `vps-up.sh` rebuilt the WordPress image but restarted only the Node deployments; with an unchanged tag a WordPress change never rolled out on a re-run | fixed: `deploy/wordpress` restarted too |
| E14 | dashboard chat | Gemini answers in Markdown (`* **Order #16**`), shown as raw text | fixed: a small renderer (lists, headings, bold, inline code) building React elements, so model text never becomes HTML |
| E15 | chat config (VPS) | With the 20 s first-output deadline every Gemini fallback was cut off (3.5 lite models take ~20 s under load): one question failed after 63 s | fixed: `gateway.llm.firstChunkMs` chart value; prod: 40 s, three lite models, `reasoningEffort: minimal`. Live: 5/5 tool loops (18-80 s, 4 recovered 503s); browser chat with approval card passes on the VPS |
| E5 | docs | README VPS steps said "four images" (five, with the provisioner) and didn't mention DNS for store hosts | fixed |

Test suites (all green on the final build and again on a from-scratch cluster):
`scripts/demo-check.sh` 37 (DoD), `scripts/attack-check.sh` 83 (adversarial), `scripts/oauth-check.mjs` 49 (OAuth),
`scripts/provision-check.sh` 67 (stores + hosted servers), `scripts/ui-check.mjs` (every dashboard page + chat, no
console errors), unit tests 58 (gateway 36, woo-mcp 13, provisioner 9).

Final run (2026-10-26, from-scratch cluster, then the fixes above redeployed): demo 37/37, attack 83/83, OAuth 49/49,
provisioning 67/67, UI + chat clean, unit 55/55. Resilience, by hand: Postgres and MariaDB pods hard-killed mid-use
(clear tool errors, other servers unaffected, recovery in ≤ 5 s, cross-replica events re-established), 12 parallel
calls on one key + a 60-request burst (429s, no 5xx), `helm upgrade` + `helm rollback` (secrets, key and data kept,
values restored), whole-cluster stop/start (keys, members, orders and upstreams all back in ~22 s).
