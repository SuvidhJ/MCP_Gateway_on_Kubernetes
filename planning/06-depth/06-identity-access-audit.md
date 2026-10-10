# 06·06 — Identity, Keys, Sessions, Delegation, Credential Storage, RBAC and Audit (implementation-level)

Written 2026-10-09. Sources:
- OWASP cheat sheets (Password Storage, Session Management, CSRF, raw from `OWASP/CheatSheetSeries`);
- GitHub's token-format post; RFC 8693 (`act`); NIST SP 800-38D (GCM);
- Better Auth 1.7.7 source (`packages/api-key/src`);
- Node.js API docs, plus a local run on Node 22.16 for timings.

Runtime facts:
- Node **24 "Krypton" is the active LTS** (v24.21.0). Node 26 is current and becomes LTS later this month.
- `crypto.argon2()` exists from **v24.7.0**; this dev machine's Node 22 lacks it. `zlib.crc32` exists in 22.
- `scrypt` N=2^17 took **~320 ms** here.

The brief requires: team roles, hashed and revocable API keys, audit, credentials kept server-side, and a chat agent
acting as the logged-in user.

---

## 1. Principals and how each authenticates

| Principal | Used by | Credential | Where verified |
|---|---|---|---|
| Human in the dashboard | browser | password → **session cookie** | dashboard API |
| MCP client (Claude Code, Cursor, Inspector) | user B's tools | **API key** (`Authorization: Bearer urumi_…`) | gateway |
| Chat agent acting for user A | our backend | **delegated short-lived token** (or in-process principal) | gateway |
| Gateway → upstream | gateway | admin-configured static header/bearer (encrypted at rest) | upstream |
| WooCommerce MCP → WordPress | woo-mcp | WC key `ck/cs` (06·04) | WordPress |

---

## 2. API keys (for MCP clients)

### 2.1 Format (GitHub's design, adapted)

GitHub: prefix + `_` + **30 base62 random chars (≈178 bits)** + **6-char base62 CRC32 checksum**. The underscore
"is not a Base64 character", so tokens don't collide with SHAs, and a double-click selects the whole token. The
checksum lets secret scanners reject random look-alikes offline.

Ours: `urumi_` + 30 base62 + 6 base62 CRC32, e.g. `urumi_8fKq…Zp1x3Tq9`. Generate with
`crypto.randomInt(62)` per character (rejection sampling). **Not** `randomBytes(n)[i] % 62`, which biases
characters 0–7 (256 isn't a multiple of 62).

### 2.2 Storage and lookup

| Option | How | Notes |
|---|---|---|
| SHA-256(key) | index on hash, lookup by equality | Better Auth's default (`defaultKeyHasher` = SHA-256 → base64url). Fine for ≥128-bit random keys. A DB leak still gives an offline-verifiable list, but with 178 bits you can't invert. |
| **HMAC-SHA-256(pepper, key)** | pepper from a K8s Secret (not in DB) | a DB-only leak can't even verify guesses. Same cost; recommended. |
| bcrypt/argon2 | — | pointless for high-entropy keys and slow on every request; that's why API keys use fast hashes. |

Table `api_keys(id, user_id, name, hash UNIQUE, display_prefix, created_at, last_used_at, expires_at NULL, revoked_at
NULL, revoked_by)`:
- Show the plaintext **once** at creation.
- `display_prefix` (first 4–6 random chars) identifies a key in the UI without revealing it. Better Auth stores
  6 "starting characters" by default.

### 2.3 Verification per request (hot path)

1. Parse `Bearer`. Shape-check (prefix, length, base62, CRC32) → cheap reject of garbage, which also tells us whether
   to look up at all.
2. `h = HMAC(pepper, key)` → `SELECT … WHERE hash = $1`. The equality lookup on a uniformly random hash isn't a useful
   timing oracle. If comparing in app code, use `crypto.timingSafeEqual`.
3. Reject if `revoked_at` or `expires_at < now()`.
4. `last_used_at`: update at most once per minute per key (`UPDATE … WHERE last_used_at < now() - '1 min'`). That
   avoids a write per request.
5. Produce the principal `{userId, role, keyId, via:'api_key'}` for `authInfo`.

**Revocation semantics:** no auth cache (an indexed Postgres lookup is ~1 ms at our scale), or a cache invalidated by
`LISTEN/NOTIFY`, so **revoke takes effect on the next request** (DoD). The client then gets 401 (06·01 §11 for the
exact response).

### 2.4 Better Auth's API-key plugin (if we used a library)

From source (`@better-auth/api-key` 1.7.7, `src/index.ts`):
- `defaultKeyLength: 64`; SHA-256 hashing unless `disableKeyHashing`; stores 6 starting characters.
- **`rateLimit` enabled by default: `maxRequests: 10` per `timeWindow: 24h`**. That would break MCP usage unless
  reconfigured.
- Expiry optional (`maxExpiresIn` 365 days); `deferUpdates` option; metadata and permissions support.

It's usable, but its defaults must be overridden and its schema becomes ours.

---

## 3. Dashboard users: passwords and sessions

### 3.1 Password hashing (OWASP numbers)
- **Argon2id ≥ 19 MiB memory, t=2, p=1** (first choice). On Node 24: `crypto.argon2('argon2id', {message, nonce,
  parallelism:1, tagLength:32, memory:19456, passes:2})`.
- Else **scrypt N=2^17, r=8, p=1** (Node built-in; needs `maxmem` ≥ 128 MiB, e.g. 256 MiB; ~320 ms here).
- bcrypt only for legacy (cost ≥ 10, **72-byte input limit**). Optional pepper.
- "Calculating a hash should take less than one second". Rate-limit login attempts (per IP + per account) so the hash
  cost can't be turned into a DoS.

### 3.2 Session cookies (OWASP Session Management)
- Session token ≥ 64 bits of entropy; OWASP's storage section prefers ≥128 bits (160+) for verifiers. **Store only a
  hash of the token** ("RFC 6819 recommends token hashes").
- Regenerate on login and on any privilege change (session fixation).
- Idle timeout 15–30 min (low-risk app), absolute 4–8 h.
- Cookie: `__Host-session=…; Secure; HttpOnly; SameSite=Lax|Strict; Path=/`. `__Host-` requires `Secure` (HTTPS).
  - **Local trap:** over plain HTTP on `store.localtest.me:8080` a `Secure` cookie isn't stored. Browsers only treat
    `http://localhost` as a secure context.
  - So values-local uses `session` without `Secure`/`__Host-` (or serve the dashboard on `localhost`); values-prod uses
    `__Host-session` + `Secure`.

### 3.3 CSRF for the dashboard's JSON API (OWASP CSRF)
- JSON API with a custom header: "A user-friendly defense that is particularly well suited for AJAX or API endpoints is
  the use of a **custom request header**. No token is needed". Require `Content-Type: application/json` plus e.g.
  `X-Requested-With`, so cross-site forms can't send them without a CORS preflight we won't grant.
- Plus **Fetch Metadata**: reject state-changing requests with `Sec-Fetch-Site: cross-site` (with an `Origin`-header
  fallback, which OWASP calls mandatory). Add `Vary: Sec-Fetch-Site, Origin` if responses differ.
- `SameSite=Lax` cookies as defence in depth.

### 3.4 Library vs hand-rolled
- Better Auth (sessions, scrypt hashing, organization plugin with roles, API keys, even an MCP OAuth package) saves
  code but brings its own schema and defaults.
- Hand-rolled minimal auth (users, sessions, keys) is ~300–400 lines we fully understand, and the interview probes
  internals.
- Decide in the next chat.

---

## 4. The chat agent acting as the logged-in user (M-CA-2)

The gateway must see **user A**, with **"via chat agent"**, and apply A's permissions. Three designs:

| Design | How | Pros | Cons |
|---|---|---|---|
| A. In-process | chat runs in the gateway process; calls the router with A's principal | no token at all; simplest | couples processes; the chat doesn't speak MCP (so it doesn't "use the gateway like a client") |
| B. **Delegated JWT** | dashboard backend (has A's session) mints `{iss:"urumi-dashboard", aud:"urumi-gateway", sub:"user:42", act:{sub:"chat-agent"}, exp:now+300, jti}` and the agent connects to `/mcp` with it | the agent is a real MCP client of our gateway; audit shows `act`; standard shape (RFC 8693 §4.1: "The act (actor) claim provides a means within a JWT to express that delegation has occurred and identify the acting party") | signing key management; token TTL vs long chats (mint per turn) |
| C. Use A's API key | agent uses a stored key | — | keys are hashed (we don't have plaintext); violates "credentials server-side" spirit |

For B:
- **EdDSA** (Ed25519): the dashboard holds the private key, the gateway holds only the public key, so the gateway
  can't mint tokens. Or HS256 with a shared Secret (simpler, symmetric).
- `jose` (npm 6.2.12) does both.
- The gateway accepts *either* an API key *or* a delegated JWT on `/mcp`, and must check `aud`, `exp`, `iss`, `alg`
  (pin algorithms).
- Tokens are **not** forwarded upstream (06·01 §11).

---

## 5. Upstream credentials (admin-configured static header/bearer)

- **Write-only API:** the dashboard sets or replaces a credential; reads return `{set: true, last4, updated_at,
  updated_by}` only. Never return or log the value (G4, doc 05).
- **Encryption at rest:** AES-256-GCM, 96-bit random IV per encryption, 16-byte tag. Use **AAD = `server:<id>|field:<name>`**
  so a ciphertext can't be moved to another row. Stored as `v1:<iv>:<tag>:<ct>` (base64url). Verified round-trip in
  Node above.
  - NIST SP 800-38D: with random IVs, keep invocations per key ≤ 2^32 (irrelevant at our scale, but it's why we
    version keys).
- **Key:** 32 random bytes in a K8s Secret mounted as a file (`/run/secrets/gateway/cred-key`). Rotation: add `v2`
  key, re-encrypt lazily on read or by a one-off job. This is CB4A "Model A": the agent never holds upstream
  credentials (doc 03).
- **Injection:** build upstream request headers from scratch: `{[headerName]: decrypt(value)}`. Validate `headerName`
  against RFC 9110 token syntax and a deny-list (`host`, `content-length`, `mcp-*`, `cookie`, …).

---

## 6. Roles and tool permissions (team access + S-2)

### 6.1 Minimal model
- Team roles:
  - `admin`: servers, credentials, members, policies, all audit.
  - `member`: use permitted tools; manage own keys; see own audit.
  - Optional `viewer`: read-only tools.
- Per-role tool rules, evaluated **in one function used by both `tools/list` filtering and `tools/call` enforcement**
  (doc 05 G3/G6):

```ts
type Rule = { role: Role; server: string | '*'; tool: string | '*'; effect: 'allow' | 'deny';
              when?: { arg: string; in?: unknown[]; notIn?: unknown[] }[] };   // S-2 argument conditions
// evaluation: explicit deny > allow; no matching rule → default (deny for writes, allow for read-only?) — decide
```

### 6.2 Defaults worth deciding
- Read-only first: `readOnlyHint` comes from an *untrusted* upstream annotation (06·01 §5.1), so "read-only" must come
  from **our** catalog metadata (admin can override).
- Example argument rule: members may call `woo__update_order_status` only with `status ∈ {processing, completed}`;
  `refunded`/`cancelled` are admin-only. That's exactly where REST has no transition rules (06·04 §2.5).
- Every rule needs a **denial test** (doc 05 Never-do #3, "accepted but not enforced" is a recognised fault class).

---

## 7. Audit log

### 7.1 Event shape (one row per MCP request that reached auth, plus admin actions)

| Field | Example | Note |
|---|---|---|
| `id`, `ts` | uuid v7, timestamptz | time-ordered ids |
| `actor_user_id`, `actor_role` | 42, member | |
| `credential` | `api_key:17` / `delegated:jti` / `session` | revoked-key attempts recorded with the key id when the hash matches a revoked row |
| `via` | `claude-code 2.x` (clientInfo, display only) / `chat-agent` (from `act`) | clientInfo is self-reported (06·01 §2) |
| `action` | `tools/call`, `tools/list`, `admin.server.disable`, `admin.key.revoke` | |
| `server_id`, `server_slug`, `tool`, `exposed_tool` | 3, store, update_order_status, store__update_order_status | ids survive renames |
| `args_digest` | redacted shape `{order_id: <int>, status: "completed"}` | allow-list of fields safe to keep (ids, enums); everything else becomes a type placeholder; never PII |
| `outcome` | ok / tool_error / denied / timeout / unreachable / unauthenticated | three-tier mapping (06·03 §6) |
| `error_code`, `latency_ms`, `upstream_status` | | |
| `trace_id` | W3C traceparent | links chat → gateway → upstream |
| `prev_hash`, `hash` | hex | tamper evidence (§7.2) |

OWASP logging guidance: never log session ids, tokens, passwords, keys, full PII. The billing addresses that
WooCommerce returns must not enter audit (06·04).

### 7.2 Tamper evidence (stand-out, cheap)

`hash_n = SHA-256(hash_{n-1} || canonical_json(row_n without hash))`, chained in insert order (single writer, or a
`SERIALIZABLE` insert with `SELECT … FOR UPDATE` on a head row).
- A verification endpoint walks the chain.
- Limitation: someone with DB write access can recompute the whole chain. Periodically anchoring the head hash outside
  the DB (stdout log or OTel span, or signing with a key the DB never sees) closes that gap. Precedents: Wirken, KYDE (doc 03).

### 7.3 Retention and volume
At demo scale, a single `audit_events` table with indexes on `(ts)`, `(actor_user_id, ts)`, `(server_id, ts)`. In
prod, partition by month; retention per policy.

---

## 8. Rate limiting (spec MUST: "Rate limit tool invocations", 06·01 §5.3)

- Per key/principal token bucket (e.g. 60 calls/min, burst 20). Per upstream bulkhead (06·03 §7).
- Single replica: in memory. Multiple replicas: Postgres (`UPDATE … RETURNING` on a bucket row) or accept per-replica
  limits and document it.

---

## 9. Schema sketch (Postgres; names indicative)

```
users(id, email UNIQUE, name, role, password_hash, created_at, disabled_at)
sessions(id, user_id, token_hash UNIQUE, created_at, last_seen_at, expires_at, revoked_at)
api_keys(id, user_id, name, hash UNIQUE, display_prefix, created_at, last_used_at, expires_at, revoked_at)
servers(id, slug UNIQUE, name, url, enabled, era_verdict, era_checked_at, status, status_reason, created_by, ...)
server_credentials(server_id, header_name, ciphertext, key_version, last4, updated_at, updated_by)
catalog_tools(server_id, name, exposed_name UNIQUE, def_hash, definition JSONB, state(active|quarantined|invalid), first_seen, last_seen)
tool_rules(id, role, server_id NULL, tool NULL, effect, conditions JSONB, created_by)
audit_events(id, ts, ..., prev_hash, hash)
```

## Sources
- OWASP: [Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) ·
  [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) ·
  [CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) ·
  [Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [GitHub: Behind GitHub's new authentication token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)
- [RFC 8693 §4.1 (act claim)](https://www.rfc-editor.org/rfc/rfc8693#section-4.1) · [RFC 6819 §4.3.2](https://www.rfc-editor.org/rfc/rfc6819.html#section-4.3.2) ·
  [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- Better Auth: [packages/api-key/src/index.ts](https://github.com/better-auth/better-auth/blob/main/packages/api-key/src/index.ts)
- Node: [crypto.argon2 (added v24.7.0)](https://nodejs.org/api/crypto.html#cryptoargon2algorithm-parameters-callback) · [release index](https://nodejs.org/dist/index.json)
