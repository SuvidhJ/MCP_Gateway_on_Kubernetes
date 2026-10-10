# MCP Gateway on Kubernetes (Urumi.AI FDE Round 1)

**Status (2026-10-10): research, depth and experiments are complete. Final design decisions come next, then the
build.** No product code has been written yet.

The deliverable: a WooCommerce store, our own WooCommerce MCP
server, an MCP gateway with a React dashboard (servers, members, API keys, audit) and a chat agent, all deployed on
Kubernetes with Helm.

## Verified so far (highlights)

- A dual-era gateway spike (TS SDK v2) served Claude Code 2.1.296 (modern) and Inspector 2.10.1 (legacy) against
  modern and legacy upstreams. Tool-change push reached Claude Code within 5 ms.
- End to end in k3s: a storefront guest checkout, then Claude Code → Traefik → gateway → WooCommerce MCP →
  WordPress: list processing orders, complete one, plus a cross-server prompt (DeepWiki + store).
- A scripted Definition-of-Done check passes 11/11: revoke, disable, kill-pod.
- Measured:
  - kill-pod detection timing;
  - Traefik/stream behaviour;
  - NetworkPolicy enforcement;
  - Helm 4 hook ordering;
  - SSRF guard against 24 bypass vectors;
  - a 40k-request soak with flat heap.
