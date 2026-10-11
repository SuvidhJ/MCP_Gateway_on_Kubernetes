# Morning report — overnight build, 2026-10-11

## TL;DR
The whole Definition of Done works in the local k3d cluster and is checked by a script:
**`bash scripts/demo-check.sh` → all checks pass** (two users, chat with approval, external client in both protocol
eras, revoke, disable, kill pod, audit), on **2 gateway replicas**, and also after a **from-scratch install**.
Claude Code 2.1.296 connected with only the gateway URL + a key and ran a cross-server prompt. Dashboard verified in
headless Edge (screenshots in `out/ui/`, gitignored). Mandatory docs written. Several stand-outs done (below).
Nothing pushed anywhere.

## Run it
```bash
k3d cluster start urumi-dev           # if stopped (the cluster holds everything; data kept)
bash scripts/up.sh                    # (re)build images, helm upgrade --install, print logins  (--no-build to skip builds)
bash scripts/demo-check.sh            # DoD + stand-out checks (~45 s; --no-chat skips the LLM steps)
UI_CHAT=1 fnm exec --using=24.21.0 node scripts/ui-check.mjs   # headless-browser check of every dashboard page
```
- Dashboard + MCP: http://gateway.127.0.0.1.nip.io:8080 (MCP at `/mcp`), login `admin@urumi.local`, password:
  `kubectl -n urumi get secret gateway-app -o jsonpath='{.data.admin-password}' | base64 -d`
- Store: http://store.127.0.0.1.nip.io:8080/shop/ (wp-admin user `admin`, password in secret `store-app`)
- Chat needs Ollama running on the host with model `qwen3.5-agent` (it is installed; `ollama serve` if not running).
- Claude Code: create a key in the dashboard (API keys page shows the exact `claude mcp add ...` line).
- Video walkthrough with verified commands: `docs/demo-script.md`.

## What was built (all committed on `main`)
| Area | Where |
|---|---|
| Gateway (MCP dual-era endpoint, upstream manager, auth, admin API, audit, chat backend, metrics) | `packages/gateway` |
| Dashboard (servers, members, keys, audit, chat with approvals) | `packages/dashboard` |
| WooCommerce MCP server (5 tools) + demo upstream | `packages/woo-mcp`, `packages/demo-upstream` |
| Helm chart: store, MariaDB, Postgres, gateway, woo-mcp, demo-upstream, NetworkPolicies, RBAC, Secrets | `charts/urumi` (+ `values-local.yaml`, `values-prod.yaml`) |
| Scripts | `scripts/up.sh`, `scripts/demo-check.sh`, `scripts/ui-check.mjs`, `scripts/mcp-call.mjs` |
| Docs | `README.md`, `docs/design.md`, `docs/threat-model.md`, `docs/api.md`, `docs/demo-script.md` |

Stand-outs: per-tool permissions (S-2), rug-pull defence (tool-definition pinning + quarantine + approve),
security hardening (SSRF guard, credentials sealed at rest, default-deny NetworkPolicies, least-privilege RBAC,
non-root Node services, Host/Origin checks, signed chat approvals), scaling (2 replicas via Postgres
LISTEN/NOTIFY, per-key rate limit), observability (`/metrics`, per-server last-hour stats), many-tools search
mode (`/mcp?tools=search`), helm rollback verified.

## Known gaps / not done
- **No VPS deployment** (needs an external account; not allowed overnight). `values-prod.yaml` + README steps are
  written but untested; the image names there (`ghcr.io/suvidhj/...`) are placeholders until you push images.
- WordPress runs Apache as root inside its container (binds :80); MariaDB/Postgres entrypoints start as root
  then drop privileges. Our Node services are non-root with read-only root FS.
- Bonus (multi-store provisioning) and OAuth not attempted.
- The manual storefront checkout was verified in round 6 experiments, not re-clicked tonight (the check script
  places the order with wp-cli instead); do it once by hand before recording.
- Chat quality depends on the local 9B model; it passed every scripted run tonight, but it is an LLM.
- DeepWiki is an internet server: on this slow link its first connect after a gateway pod starts can fail once
  and recover ~2 s later (visible in its status history).

## Next steps (suggested)
1. Watch the flow once by hand in a browser (store checkout → chat → Claude Code), then record using `docs/demo-script.md`.
2. Decide on the VPS: push images to GHCR, k3s on a free VM, `helm upgrade --install -f values-prod.yaml`.
3. Push the repo to GitHub when you're happy (nothing was pushed).

## System settings to revert (from STATE.md)
| Setting | Revert |
|---|---|
| Lid close action (AC) set to "Do nothing" | `powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 1; powercfg /setactive SCHEME_CURRENT` |
| Scheduled tasks `Urumi-Overnight-Start`, `Urumi-Overnight-Kill` | `overnight/kill-all.ps1` deletes them; else `schtasks /Delete /TN Urumi-Overnight-Start /F` (and `-Kill`) |
| `.claude/settings.local.json` (broad allow rules for the unattended run) | delete the file or trim the allow list |
| Local dev leftovers | `docker rm -f urumi-pg-dev`; kill node processes on ports 7801/7802 if still running |
| k3d cluster `urumi-dev` (running) | `k3d cluster stop urumi-dev` to free RAM |
