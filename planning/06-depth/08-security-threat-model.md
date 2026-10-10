# 06·08 — Security in Depth: Threat Model Method, SSRF (verified), Tool Poisoning, Injection Paths, Hardening

Written 2026-10-09/10. Inputs:
- the brief's threat-model questions (project.md, the "short threat model note");
- MCP 2026-07-28 security best practices (06·01 §11);
- incidents and frameworks (doc 05 §2.4);
- Trail of Bits `mcp-context-protector` README;
- the official images' Dockerfiles;
- **a local SSRF prototype run on this machine (§3)**.

---

## 1. Method (how the note should be structured)

1. **Assets:**
   - upstream credentials (WC key, third-party tokens);
   - gateway API keys and sessions;
   - store data (orders = customer PII, products);
   - the catalog and policies;
   - the audit trail;
   - the LLM provider key.
2. **Actors:**
   - admin;
   - member;
   - a member's compromised client;
   - the public storefront customer;
   - a malicious or compromised upstream MCP server;
   - an LLM manipulated by content;
   - a network attacker;
   - a cluster tenant pod.
3. **Trust boundaries and flows** (diagram for the note):
   ```
   Internet ─TLS─► Traefik ─► dashboard API / gateway /mcp            [B1: public edge]
   gateway ─► in-cluster upstreams (woo-mcp, own server)              [B2: east-west, NetworkPolicy]
   gateway ─► third-party upstreams (DeepWiki, …) over the Internet   [B3: egress, SSRF guard]
   woo-mcp ─► WordPress REST ─► MariaDB                               [B4: store, scoped WC user]
   chat backend ─► LLM provider (prompt + tool results leave the cluster)  [B5: data egress]
   storefront customer ─► WordPress (checkout, order notes)           [B6: public data enters the store]
   ```
4. **STRIDE per flow.** Then answer the brief's four questions explicitly (§7). List residual risks honestly (§9).

---

## 2. Controls map (where each class is handled)

| Class | Control in our design | Doc |
|---|---|---|
| Spoofing a user | API keys (HMAC-hashed, revocable), sessions (`__Host-`, rotation), delegated JWT (`aud`, `exp`, pinned alg) | 06·06 |
| Tampering with requests in transit | TLS at the edge; header↔body validation (`-32020`) | 06·01 §2.1 |
| Repudiation | audit row per call + admin action, `via` + `act`, hash chain | 06·06 §7 |
| Information disclosure | credentials write-only and encrypted (AES-GCM + AAD); no token passthrough; PII never logged; per-user lists `private` | 06·06 §5, 06·01 §6 |
| DoS | body cap 4 MiB, per-key rate limit, per-upstream bulkhead + breaker, deadlines below the SDK, `maxSubscriptions` | 06·02, 06·03 §7 |
| Elevation of privilege | call-time authz with the same rules as listing; role checks server-side; scoped WC user; namespace-scoped RBAC (none needed) | 06·03 §5, 06·04 §3 |
| SSRF via upstream URLs | connect-time IP validation (literals + DNS answers), redirect policy, explicit in-cluster allow-list, egress NetworkPolicy | §3 |
| DNS rebinding against our endpoints | `Host` + `Origin` allow-lists in front of `createMcpHandler` | 06·02 §2.1 |
| Tool poisoning, line jumping, rug pull | namespacing; TOFU pinning + quarantine; Unicode hygiene; description caps | §4 |
| Indirect prompt injection | approval for write tools (Rule of Two); results as data; visible tool trace | §5, 06·07 §6 |
| Supply chain | pinned image digests, pinned plugin + checksum, lockfiles, scanner in CI | §6 |

---

## 3. SSRF guard (prototype verified 2026-10-10)

### 3.1 What I tested

`scratchpad/r5/sec/ssrf-probe.mjs` used `undici` 8.11.2 (Node's bundled undici is 6.21.2, so the npm package and its
own `fetch` go together). It compared two guards:
- a **DNS-lookup-only** guard (`new Agent({connect:{lookup}})`, rejecting private answers);
- a **connector** guard that also checks IP-literal hosts before connecting.

| Target URL | WHATWG-normalised host | lookup hook called? | lookup-only guard | connector guard |
|---|---|---|---|---|
| `http://127.0.0.1:8099/` | `127.0.0.1` | **no** | ECONNREFUSED (**connected**) | blocked |
| `http://2130706433:8099/` | `127.0.0.1` | **no** | ECONNREFUSED | blocked |
| `http://0x7f.1:8099/` | `127.0.0.1` | **no** | ECONNREFUSED | blocked |
| `http://127.1:8099/` | `127.0.0.1` | **no** | ECONNREFUSED | blocked |
| `http://[::1]:8099/` | `[::1]` | **no** | ECONNREFUSED | blocked |
| `http://[::ffff:127.0.0.1]:8099/` | `[::ffff:7f00:1]` | **no** | ECONNREFUSED | blocked |
| `http://169.254.169.254/latest/meta-data/` | same | **no** | connect timeout (would reach metadata on a cloud VM) | blocked |
| `http://localhost:8099/` | `localhost` | yes | blocked | blocked |
| `http://localtest.me:8099/` (public DNS → 127.0.0.1) | same | yes | blocked | blocked |
| `https://example.com/` | same | yes | 200 | 200 |

Findings:
1. **Node never calls the DNS lookup hook for IP literals.** A lookup-only guard is bypassed by every literal form,
   including the cloud metadata IP.
2. The WHATWG URL parser **normalises** decimal, hex and short IPv4 to dotted quad, and IPv4-mapped IPv6 to the **hex**
   form (`::ffff:7f00:1`). The checker must unwrap both mapped forms, plus NAT64 `64:ff9b::/96` and 6to4 `2002::/16`.
3. Validating **at connect time**, on the address actually dialled, defeats DNS rebinding (no check/use gap). That's
   the spec's "pin DNS resolution results between check and use" (06·01 §11).
4. Also: Fetch's "bad ports" list (e.g. port 9) makes fetch fail before connecting, which is irrelevant here.

### 3.2 Design
- Pass a custom `fetch` to the SDK transport: `(url, init) => undiciFetch(url, {...init, dispatcher: guardedAgent})`.
  The SDK's default `redirectPolicy: 'same-origin'` (06·02 §3.2) plus per-connection validation covers redirect hops.
- **Block list** (`net.BlockList`):
  - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15,
    198.51.100/24, 203.0.113/24, 224/4, 240/4.
  - IPv6: ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, 100::/64, 2001:db8::/32, plus unwrap ::ffff:0:0/96,
    64:ff9b::/96 and 2002::/16 to their IPv4.
- **In-cluster exception** (needed: our own upstreams are on 10.42/10.43 in k3s; Unla #299 is the failure mode when
  this is forgotten):
  - an allow-list of exact `host:port` pairs from **Helm values** (not editable in the UI), e.g.
    `woo-mcp.urumi.svc.cluster.local:8080`;
  - the resolved IP must also fall inside the service CIDR (k3s default `10.43.0.0/16`);
  - `10.43.0.1:443` (the Kubernetes API) is never allowed.
- Schemes `http`/`https` only. Response size cap; per-attempt timeout.
- Backstop: the gateway's **egress NetworkPolicy** only allows DNS, the listed in-cluster services, and `0.0.0.0/0`
  except private ranges on 443 (06·05 §4.3).

---

## 4. Tool poisoning, line jumping, rug pulls

Reference design: Trail of Bits `mcp-context-protector`.
- "Trust-on-first-use pinning of server configurations" and "Automatic blocking of unapproved configuration changes".
- Comparison covers "server instructions, tool descriptions, and tool input schemas", and is "semantic and ignore[s]
  irrelevant factors like tool order and parameter order".
- Checked at connect and "whenever the wrapper receives … `notifications/tools/list_changed`".
- It also does "ANSI control character sanitization" and quarantines suspicious tool responses.

"Line jumping" means a description that injects instructions before any tool is called (tool lists go straight into
the model context).

Our gateway version (stand-out candidate S-2/S-6):
- `defHash = SHA-256(canonicalJSON({description, inputSchema, outputSchema?, annotations?}))`, with sorted keys so
  ordering doesn't matter. Store it per catalog tool (06·06 §9).
- First sight: `active` (default-allow) **or** `quarantined` (default-deny until an admin approves). This is the open
  choice in 06·03 §10.
- Hash change on refresh → `quarantined`: hidden from lists **and** refused at call time ("definition changed since
  approval; an admin must re-approve"). The dashboard shows a diff (old vs new description/schema).
- Server `instructions` (legacy initialize result or `server/discover`) get the same treatment if we re-export them.

**Text hygiene on everything an upstream sends that reaches a model** (descriptions, titles, results):

| Remove / flag | Code points | Why |
|---|---|---|
| C0/C1 controls (keep `\t`, `\n`) and **ANSI escape sequences** | U+0000–0008, 000B–000C, 000E–001F, 007F–009F | terminal deception (mcp-context-protector) |
| Zero-width / invisible | U+200B–200D, U+2060, U+FEFF, U+00AD, U+180E | hidden text |
| Bidi controls | U+202A–202E, U+2066–2069, U+200E–200F, U+061C | Trojan-Source-style reordering |
| **Unicode tags** | U+E0000–E007F | "ASCII smuggling" of invisible instructions (ThinkWatch rule, doc 04) |
| Variation selectors | U+FE00–FE0F, U+E0100–E01EF | data hidden in emoji [reported] |

Plus:
- cap description length (e.g. 1,024 chars);
- cap result size (e.g. 64 KB passed through, truncated with a note);
- optional simple heuristics that **flag** (not block) phrases like "ignore previous", "do not tell the user", or
  references to other tools' names.

Namespacing (`slug__tool`) prevents **shadowing**: an upstream can't publish a tool that replaces another server's tool.

---

## 5. Indirect prompt-injection paths specific to this system

| Path | Who controls the text | Reaches the agent via | Worst plausible effect | Control |
|---|---|---|---|---|
| Product name/description | any member with `create_product` | `list_products` | another member's agent follows instructions | approval for writes; results as data; quarantine heuristics |
| **Customer checkout note / address fields** | **anyone on the Internet** (storefront) | `get_order`, `list_orders` | public text steering staff agents ("mark all orders refunded") | same; order-status rules (06·06 §6.2) limit what a write can do |
| Third-party upstream results (DeepWiki pages) | the upstream or its content | any call | exfil attempt via later tool args | approval card shows args; no secrets in context |
| Tool descriptions | upstream operator | `tools/list` | line jumping | §4 |

The checkout-note path is the most realistic threat in a store and makes a strong concrete example for the note:
public input → private data → state change is exactly Meta's Rule-of-Two violation, broken by **human approval on
writes**.

---

## 6. Hardening recipes (S-6)

| Component | Pod Security target | Recipe |
|---|---|---|
| gateway, dashboard API, woo-mcp, chat | **restricted** | `node:24-alpine` (or distroless) as uid 1000; `readOnlyRootFilesystem: true` + `/tmp` emptyDir; `allowPrivilegeEscalation: false`; `capabilities.drop: [ALL]`; `seccompProfile: RuntimeDefault`; `automountServiceAccountToken: false` |
| WordPress | restricted (custom image) | Apache `Listen 8080` (no root bind); `runAsUser: 33`. Entrypoint supports non-root (`--no-overwrite-dir` path). `readOnlyRootFilesystem: true` with emptyDirs at `/var/www/html` (entrypoint copies code there at start), `/var/run/apache2`, `/var/lock/apache2`, `/tmp`; PVC at `wp-content/uploads`. Logs already go to stdout/stderr via symlinks |
| MariaDB | baseline/restricted | uid 999; PVC `/var/lib/mysql`; emptyDir `/run/mysqld`, `/tmp` |
| bootstrap Job | restricted | same WordPress image, uid 33, `wp` commands only; ServiceAccount without token |

Supply chain:
- pin images by digest in `values-prod.yaml`;
- pin WooCommerce zip + record its sha256; WP-CLI phar sha512;
- `npm ci` with lockfiles; `trivy image` / `syft` SBOM in CI;
- k3s `--secrets-encryption` on the VPS.

---

## 7. The brief's four questions: precise answers our design supports

1. **A credential a member never sees.** The member can do whatever *that credential* allows, but only through the
   tools the gateway exposes to their role, at the rate we allow, with every call attributed.
   - They can't read the secret: it's write-only and encrypted, never in the model context, never logged.
   - They *can* cause its effects (spend quota, read and change upstream data within the tool surface).
   - So least privilege lives in the credential (read-only GitHub token; scoped WC user with no delete or settings
     capabilities, 06·04 §3) **and** in our role and argument rules.
   - Revoking the member's key cuts them off without rotating the shared credential.
2. **No passthrough of client tokens.**
   - The spec forbids it (audience binding).
   - Our API key is a credential *for the gateway*. An upstream receiving it could replay it against the gateway
     (confused deputy).
   - Passthrough would bypass our policy, rate limits and audit, and would couple every upstream to our auth scheme.
   - Upstreams instead get their own admin-configured credential, injected on egress (CB4A Model A).
3. **Untrusted upstreams writing manipulative descriptions.** Namespacing (no shadowing); TOFU hash pinning +
   quarantine on change + admin diff approval; Unicode/ANSI hygiene and length caps; descriptions never carry secrets
   because the model never has any; approval for writes limits the blast radius.
4. **What one member can do to another.**
   - Via shared upstream state: modify or cancel orders others created; create products that carry injections.
   - Via the public storefront: checkout notes (§5).
   - Exhaust shared quotas.
   - What they **can't** do (server-side role checks, with denial tests): see other members' keys or chats, revoke
     others' keys, change servers, credentials or policies, read others' audit beyond policy.

---

## 8. Spec-mandated items to show in the demo or README (cheap credibility)

- `Origin` validation (403) and Host allow-list; no token passthrough; per-request auth; `-32020`/`-32022` handling;
  rate limiting; input validation; output sanitisation; timeouts; tool-usage logging (06·01 §§2, 5.3, 11).

## 9. Residual risks to state honestly

- NetworkPolicy startup race (k3s#13432) and the k3d restart caveat (06·05 §4.2).
- In-cluster callers can set `X-Forwarded-Proto` toward WordPress (06·04 §1.2). Mitigated by NetworkPolicy.
- Shared upstream credential power (Q1).
- The LLM provider sees prompts and tool results (B5). Choose the provider deliberately; avoid sending full PII
  (compact tool outputs).
- A DB admin could recompute the audit hash chain unless the head hash is anchored externally (06·06 §7.2).
- WooCommerce REST has no status-transition rules, so our rules are the only guard on order state (06·04 §2.5).

## Sources
- [MCP security best practices (2026-07-28)](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [trailofbits/mcp-context-protector](https://github.com/trailofbits/mcp-context-protector) · [snyk/agent-scan (formerly invariantlabs mcp-scan)](https://github.com/snyk/agent-scan)
- [undici](https://github.com/nodejs/undici) (Agent `connect`, `buildConnector`) · [Node net.BlockList](https://nodejs.org/api/net.html#class-netblocklist)
- [docker-library/php apache Dockerfile](https://github.com/docker-library/php/blob/master/8.4/trixie/apache/Dockerfile) · [docker-library/wordpress](https://github.com/docker-library/wordpress)
- IANA special-purpose address registries: [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) · [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)
- [Trojan Source (CVE-2021-42574)](https://trojansource.codes/) · Rule of Two, OWASP Agentic Top 10, incident ledger: doc 05 §2.4
