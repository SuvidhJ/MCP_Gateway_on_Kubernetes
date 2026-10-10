# Overnight state (live; update after every meaningful step)

## Now
- Window B (04:45-): M2 gateway, M3 dashboard, M4 chat, M5 chart (Postgres, gateway, NetworkPolicies, values-local/prod)
  DONE. **`bash scripts/demo-check.sh` passes 23/23 in k3d `urumi-dev` (05:05)**, incl. chat approval round-trip
  and "orders today" (store-timezone fix in woo-mcp + exact start-of-day bound in the chat prompt).
- Next: `scripts/up.sh`, README (M6), browser check of the dashboard, then S-2/S-6.

## Done
- git repo initialised (`main`), `.gitignore`, `.claude/settings.local.json` (broad allow + deny list).
- `overnight/run-overnight.ps1`, `overnight/kill-all.ps1` (has `-DryRun`), PLAN.md, STATE.md.
- Dry run via Task Scheduler at 02:27 passed: auth, stream-json logging, PID capture. Headless Bash/PowerShell/Write
  tools are allowed with `--permission-mode acceptEdits` + settings.local.json (verified 02:28).
- Tasks registered: `Urumi-Overnight-Start` 04:45, `Urumi-Overnight-Kill` 07:28 (one-time, wake-to-run, Limited).
- `planning/08-decisions.md` written (17 decisions).
- Disk: removed `urumi-spike:dev`, deleted cluster `urumi`, pruned dangling. Pulled `postgres:18.6-alpine`,
  `node:24.21.0-alpine`. Unrelated images (geospatial-*, incident-triage-*) left alone on purpose.
- `images/wordpress/downloads/`: `woocommerce.11.2.0.zip` (unzip -t ok), `wp-cli-2.12.0.phar` (sha512 verified
  against the release .sha512); sha256s in `SHA256SUMS`. Directory is gitignored: the Dockerfile COPYs from it.
- Cluster `urumi-dev` created (k3s v1.36.5, 8080->80, 8443->443). kubectl context `k3d-urumi-dev`.
- Monorepo scaffold: npm workspaces `packages/{shared,woo-mcp,demo-upstream,gateway,dashboard}`, `tsconfig.base.json`,
  `scripts/demo-check.sh` (copied from experiments, still needs adapting), `charts/urumi`, `images/wordpress`, `docs`.
  Pins: TS 6.0.3, @types/node 24.19.2, tsx 4.23.15, vitest 5.0.3, hono 4.13.13 + @hono/node-server 2.1.4, MCP SDK
  server/client 2.3.1 + node 2.1.1, pg 8.23.1, jose 6.2.12, zod 4.6.5, undici 8.11.2, pino 10.4.0, ai 7.0.137,
  @ai-sdk/react 4.0.140, @ai-sdk/mcp 2.0.73, @ai-sdk/openai-compatible 3.0.67, react 19.3.0, vite 8.3.4,
  @vitejs/plugin-react 6.1.2, @tanstack/react-query 5.104.1.
- Node: ALWAYS `fnm exec --using=24.21.0 <cmd>` (default node on PATH is 22.16).

- **M1 DONE and verified (02:4x):** `helm upgrade --install urumi charts/urumi -n urumi --kube-context k3d-urumi-dev`
  deploys MariaDB + WordPress (image `urumi/wordpress:dev`) + bootstrap hook Job (first run 75 s, re-run 12 s,
  idempotent) + woo-mcp (`urumi/woo-mcp:dev`). All 5 tools called via
  `kubectl -n urumi port-forward svc/woo-mcp 7811:80` + `fnm exec --using=24.21.0 node scripts/mcp-call.mjs http://127.0.0.1:7811/mcp <tool|--list> '<json>'`;
  created product is live at http://store.127.0.0.1.nip.io:8080/shop/. woo-mcp has 10 vitest unit tests (pass).
- Secrets: `store-db` and `store-app` generated via `lookup` (kept across upgrades, `resource-policy: keep`).
  Store admin password: `kubectl -n urumi get secret store-app -o jsonpath='{.data.admin-password}' | base64 -d`.
- Image builds: `docker build -f images/node/Dockerfile --build-arg PKG=<pkg> -t urumi/<pkg>:dev .` then
  `~/bin/k3d.exe image import urumi/<pkg>:dev -c urumi-dev` (the gateway build also builds the dashboard into
  `packages/dashboard/dist`; the gateway should serve it from `../dashboard/dist`). WordPress image:
  `bash scripts/fetch-store-assets.sh && docker build -t urumi/wordpress:dev images/wordpress`.

## Next step
1. M2 gateway core in `packages/gateway` (Hono + `@hono/node-server`; TS SDK v2 per 08-decisions; port ideas from
   `experiments/spike/gateway.mjs`, `ssrf-guard.mjs`, `e17-watch.mjs`). Postgres needs a chart template
   (`postgres:18.6-alpine` already pulled) and a `gateway` Deployment + ServiceAccount/Role (EndpointSlice watch,
   see `experiments/k8s/watch-rbac.yaml`) + Ingress host `gateway.127.0.0.1.nip.io`.
2. `packages/demo-upstream` (tiny MCP server, 1-2 tools) + chart template, for the kill-pod demo.
3. Then M3 dashboard, M4 chat, rest of M5 (NetworkPolicies, `scripts/up.sh`, adapt `scripts/demo-check.sh`), M6.

## Blockers / notes
- TypeScript 6: `types` defaults to none, so `tsconfig.base.json` sets `types: [""node""]`; tests are excluded
  from `tsc` builds (vitest runs them).
- On Windows use `npm.cmd`/`npx.cmd` under fnm: `fnm exec --using=24.21.0 npm.cmd ...` (plain `npm` fails).
- npm warned esbuild's postinstall is not in allowScripts; vitest/tsx still work. Approve only if a build breaks.
- Bash heredocs with many nested quotes have failed once; prefer the Write tool for big files.
- k3d has kept data: cluster `urumi-dev` holds release `urumi` in namespace `urumi`.

## Background processes started (kill if stale)
- Docker container `urumi-pg-dev` (postgres, port 55432) for local gateway dev: `docker rm -f urumi-pg-dev`.
- Local node processes on :7801 (gateway via tsx) and :7802 (demo-upstream): kill by port
  (`netstat -ano | grep :7801`, then `taskkill //PID <pid> //F //T`).

## System settings changed (revert in the morning)
| Setting | Before | Now | Revert |
|---|---|---|---|
| Sleep after (AC), Ultimate Performance plan | 0 (never) | 0 | nothing to revert |
| Hibernate after (AC) | 0 (never) | 0 | nothing to revert |
| Lid close action (AC) | not readable before change (Windows default = 1, Sleep) | 0 (Do nothing) | `powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 1; powercfg /setactive SCHEME_CURRENT` |
| Scheduled tasks `Urumi-Overnight-Start` (04:45), `Urumi-Overnight-Kill` (07:28), run level Limited (not admin), wake-to-run | absent | present | kill-all.ps1 deletes them; else `schtasks /Delete /TN Urumi-Overnight-Start /F` (and `-Kill`) |
| `.claude/settings.local.json` | absent | broad allow rules for unattended runs | delete the file (or trim the allow list) |
