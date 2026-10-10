# Overnight plan (2026-10-11)

Authority: the user's overnight brief (all decisions pre-authorized; no questions; no push; no Claude attribution in
commits). DoD first; stand-outs only after `scripts/demo-check.sh` passes. Defaults: see `planning/08-decisions.md`.

## M0 setup (Window A)
- [x] git init, .gitignore, `.claude/settings.local.json`, overnight scripts, scheduled tasks, dry-run
- [x] `planning/08-decisions.md` (17 decisions from 00-index §3, citing 07)
- [x] disk cleanup, delete `urumi` cluster, pre-pull images, WooCommerce 11.2.0 zip + wp-cli 2.12.0 phar (checksums)
- [ ] monorepo scaffold (npm workspaces) + `npm install`
- [x] dev cluster `urumi-dev` (07 §1 command; ports 8080/8443)

## M1 store + woo-mcp
- [ ] `images/wordpress`: immutable WordPress 7.1.3-php8.4 image + WooCommerce 11.2.0 + wp-cli 2.12.0, uid 33
- [ ] bootstrap Job (idempotent, retries until DB ready): permalinks, coming-soon `no`, COD, free-shipping zone, HPOS,
      timezone, `mcp_store_agent` role, 43-char WC keys from a Secret with checked insert
- [ ] `packages/woo-mcp`: 5 tools (list/create products, list/get orders, update order status), currency in output,
      permalink rewrite, `customer_note` marked untrusted, status-transition policy, `X-Forwarded-Proto: https`,
      `*_gmt`+`Z` dates; unit tests

## M2 gateway core
- [ ] Postgres schema + migrations at start under `pg_advisory_lock`: users, roles, sessions, API keys (HMAC-SHA256 +
      pepper, revocable), upstreams, audit log (user, server, tool, time, duration, outcome)
- [ ] upstream manager: per-upstream loop, failure classifier, fast re-probe, 2 s connect timeout, SSRF guard, 404
      re-init, per-upstream call timeouts, `bodyTimeout:0` listens, EndpointSlice watch
- [ ] one dual-era MCP endpoint (`createMcpHandler` + low-level `Server`), Host/Origin guards, key check, `slug__tool`
      names, call-time authorization, `notify.toolsChanged()`, revocation closes the key's listen streams
- [ ] admin REST API (session cookie + CSRF header; roles admin/member)

## M3 dashboard (Vite + React 19 + TanStack Query)
- [ ] login; servers with status (Connected/Unreachable/Disabled) + tools; add/edit/disable/remove by URL + credential
- [ ] members (invite), keys (issue/revoke), audit log view

## M4 chat
- [ ] chat page (AI SDK 7, `useChat`, `toolApproval`), shows tool calls, approval before writes, acts as the user via
      delegated short-lived JWT (`sub`=user, `act`=chat-agent); LLM via OpenAI-compatible base URL (Ollama
      `qwen3.5-agent` at `http://host.k3d.internal:11434/v1`, reasoning off)

## M5 Helm
- [ ] `charts/urumi`: Postgres, MariaDB, WordPress, bootstrap Job, woo-mcp, demo-upstream, gateway+dashboard,
      Ingress, NetworkPolicies, secrets via `lookup`, probes/resources; Jobs retry
- [ ] `scripts/up.sh` (cluster + images + `helm upgrade --install`)
- [ ] `scripts/demo-check.sh` passes all DoD steps

## M6 docs + stand-outs
- [ ] README: architecture, setup, how a tool call travels, collisions/timeouts/dead upstream, agent acting as the
      user, security answers to the brief's questions
- [ ] S-2 tool permissions, then S-6 hardening

## Final (07:00–07:20)
- [ ] `overnight/MORNING-REPORT.md`, final commit
