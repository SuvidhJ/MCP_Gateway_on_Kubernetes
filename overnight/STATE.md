# Overnight state (live; update after every meaningful step)

## Now
- Window A (interactive chat, 02:23-~04:40 IST) did M0 setup; Window B (scheduled, 04:45) continues from here.

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

## Next step
- (see PLAN.md: first unchecked item)

## Blockers / notes
- (none yet)

## Background processes started (kill if stale)
- (none)

## System settings changed (revert in the morning)
| Setting | Before | Now | Revert |
|---|---|---|---|
| Sleep after (AC), Ultimate Performance plan | 0 (never) | 0 | nothing to revert |
| Hibernate after (AC) | 0 (never) | 0 | nothing to revert |
| Lid close action (AC) | not readable before change (Windows default = 1, Sleep) | 0 (Do nothing) | `powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 1; powercfg /setactive SCHEME_CURRENT` |
| Scheduled tasks `Urumi-Overnight-Start` (04:45), `Urumi-Overnight-Kill` (07:28), run level Limited (not admin), wake-to-run | absent | present | kill-all.ps1 deletes them; else `schtasks /Delete /TN Urumi-Overnight-Start /F` (and `-Kill`) |
| `.claude/settings.local.json` | absent | broad allow rules for unattended runs | delete the file (or trim the allow list) |
