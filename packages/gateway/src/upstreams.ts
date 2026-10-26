// Upstream manager: one SDK Client per registered MCP server, each with its own non-overlapping health loop.
// Failure classes (measured against real upstreams):
//   hard = connection refused / DNS / reset / 502-504 -> unreachable at once (fast kill-pod detection)
//   soft = timeouts -> a strike; `strikes` consecutive strikes -> unreachable
//   auth = 401/403 -> auth_failed (an admin must fix the credential)
// After a failure the loop re-probes fast (250 ms doubling up to the tick) so a restarted pod is back in ~2 s.
import crypto from 'node:crypto';
import { Client, StreamableHTTPClientTransport, SdkHttpError, SdkError } from '@modelcontextprotocol/client';
import { fetch as undiciFetch } from 'undici';
import { config } from './config.js';
import { one, q } from './db.js';
import { log } from './log.js';
import { createGuardedAgent } from './ssrf.js';
import { unseal } from './sealed.js';

export type Status = 'connecting' | 'connected' | 'unreachable' | 'auth_failed' | 'disabled';
/** Who may see and call a tool: everyone ('member'), admins only, or nobody ('off'). */
export type Access = 'member' | 'admin' | 'off';
type ToolDef = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export interface UpstreamRow { id: number; slug: string; name: string; url: string; auth_header: string | null; credential: string | null; enabled: boolean; timeout_ms: number | null; managed_by?: string | null }
export const UPSTREAM_COLS = 'id::int as id, slug, name, url, auth_header, credential, enabled, timeout_ms, managed_by';

export interface Upstream {
  id: number; slug: string; name: string; url: string; authHeader: string | null; credential: string | null;
  enabled: boolean; timeoutMs: number | null;
  /** 'provision:<id>' when the provisioner registered it (store / hosted server): URL and credential are its own. */
  managedBy: string | null;
  status: Status; era: 'modern' | 'legacy' | null; protocolVersion: string | null; lastError: string | null;
  statusSince: Date; tools: ToolDef[]; access: Map<string, Access>;
  /** Pinned definitions (rug-pull defence) and the tools whose current definition differs from the pin (or that
   *  appeared after the server's tools were first approved). */
  pins: Map<string, { hash: string; description: string | null }>; changed: Set<string>;
  /** Client-facing tool name (`slug__<safe name>`) <-> the upstream's own name. */
  exposed: Map<string, string>; exposedOf: Map<string, string>;
  /** Set when the stored credential can't be decrypted (CREDENTIAL_KEY changed): never connect with a wrong value. */
  credentialError?: string;
  client?: Client; sessionId?: string; strikes: number; retryMs: number; timer?: NodeJS.Timeout;
  busy: boolean; again: boolean; removed: boolean;
  /** Bumped whenever the connection is dropped, so a connect started for an old URL/credential can't install itself. */
  gen: number; connecting?: { gen: number; p: Promise<void> };
}

/** In-cluster hostnames of provisioner-registered servers: allowed to resolve to private addresses (their URLs come
 *  from the provisioner, never from user input). */
const managedHosts = new Set<string>();
const dispatcher = createGuardedAgent({ allowHosts: config.ssrfAllowHosts, timeout: config.connectTimeoutMs, externalTimeout: config.externalConnectTimeoutMs, guard: config.ssrfGuard, allowFn: (h) => managedHosts.has(h) });
// redirect: 'error': MCP over HTTP never needs a redirect, and following one would let a registered server bounce the
// gateway's requests (with their JSON-RPC bodies) to an allow-listed in-cluster host such as woo-mcp.
export const baseFetch = ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher, redirect: 'error' })) as unknown as typeof fetch;

/** Tool names clients accept: [A-Za-z0-9_-], at most 64 characters (upstream names may use '.', '/', spaces…). */
export function safeToolName(name: string, taken: Set<string>) {
  let base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  if (base.length > 64) base = `${base.slice(0, 55)}_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  let out = base;
  for (let i = 2; taken.has(out); i++) out = `${base.slice(0, 60)}_${i}`;
  return out;
}

/** An upstream URL without userinfo or query values, for people who must not see embedded secrets. */
export function redactUrl(url: string) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}
// Deadline on every POST below the SDK (so an SDK timeout bug can't hang us). GET listen streams are untouched.
const deadlineFetch = (ms: number): typeof fetch => (url, init = {}) => {
  if ((init.method ?? 'GET').toUpperCase() !== 'POST') return baseFetch(url, init);
  const signals = [AbortSignal.timeout(ms)];
  if (init.signal) signals.push(init.signal);
  return baseFetch(url, { ...init, signal: AbortSignal.any(signals) });
};

const causeCode = (e: any): string => String(e?.cause?.code ?? e?.cause?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? '');
export function classify(e: any): 'auth' | 'hard' | 'soft' | 'other' {
  if (e instanceof SdkHttpError && (e.status === 401 || e.status === 403)) return 'auth';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ESSRF/.test(causeCode(e))) return 'hard';
  if (e?.name === 'TypeError' && /fetch failed/.test(e.message)) return 'hard';
  if (e instanceof SdkError && String(e.code).includes('ERA_NEGOTIATION_FAILED') && /fetch failed/.test(e.message)) return 'hard';
  if (e instanceof SdkHttpError && [502, 503, 504].includes(e.status)) return 'hard';
  if (/timed? ?out|TimeoutError|REQUEST_TIMEOUT|AbortError/i.test(String(e?.name) + String(e?.message) + String(e?.code))) return 'soft';
  return 'other';
}
/** Fingerprint of everything a model reads about a tool. */
export const toolHash = (t: ToolDef) => crypto.createHash('sha256')
  .update(JSON.stringify([t.title ?? null, t.description ?? '', t.inputSchema ?? null, t.annotations ?? null])).digest('hex');

export const errText = (e: any) => {
  const c = causeCode(e);
  const causes = [e?.cause, e?.cause?.cause, e?.cause?.errors?.[0]];
  if (c === 'ESSRF') { // say what was blocked, not just "fetch failed"
    const m = causes.find((x) => x?.code === 'ESSRF')?.message;
    if (m) return `${m} (blocked: private, loopback or metadata address; ask an admin to allow-list in-cluster hosts)`;
  }
  const msg = String(e?.message ?? e);
  // "fetch failed" alone says nothing: add the underlying reason (refused, redirect refused, TLS, DNS…)
  const why = /fetch failed/.test(msg) ? causes.find((x) => x?.message)?.message : undefined;
  return `${msg.slice(0, 200)}${why ? `: ${String(why).slice(0, 160)}` : ''}${c && !msg.includes(c) && !String(why).includes(c) ? ` (${c})` : ''}`;
};

export class UpstreamManager {
  readonly ups = new Map<number, Upstream>();
  /** Called when the aggregated tool list may have changed (status flip, tools changed, add/remove). */
  onToolsChanged: () => void = () => {};

  /** Load (or re-sync after a missed event) all servers, access rules and pins from the database. */
  async load() {
    const rows = await q<UpstreamRow>(`select ${UPSTREAM_COLS} from upstreams order by id`);
    const policies = await q<{ upstream_id: number; tool: string; access: Access }>('select upstream_id::int as upstream_id, tool, access from tool_policies');
    const pins = await q<{ upstream_id: number; tool: string; hash: string; description: string | null }>('select upstream_id::int as upstream_id, tool, hash, description from tool_pins');
    // all synchronous from here, so pins are in place before any probe can deliver a tool list
    for (const id of [...this.ups.keys()]) if (!rows.some((r) => r.id === id)) this.remove(id);
    for (const r of rows) {
      const u = this.upsert(r);
      u.access.clear();
      u.pins.clear();
    }
    for (const p of policies) this.ups.get(p.upstream_id)?.access.set(p.tool, p.access);
    for (const p of pins) this.ups.get(p.upstream_id)?.pins.set(p.tool, { hash: p.hash, description: p.description });
    for (const u of this.ups.values()) this.recheckPins(u);
    this.onToolsChanged();
  }

  // ---- applying another replica's change (events.ts) ----
  async reloadUpstream(id: number) {
    const r = await one<UpstreamRow>(`select ${UPSTREAM_COLS} from upstreams where id = $1`, [id]);
    if (!r) return this.remove(id);
    // pins and rules may have been reset with the edit (URL change): take the database's view
    const pins = await q<{ tool: string; hash: string; description: string | null }>('select tool, hash, description from tool_pins where upstream_id = $1', [id]);
    const rules = await q<{ tool: string; access: Access }>('select tool, access from tool_policies where upstream_id = $1', [id]);
    const u = this.upsert(r);
    u.pins = new Map(pins.map((p) => [p.tool, { hash: p.hash, description: p.description }]));
    u.access = new Map(rules.map((p) => [p.tool, p.access]));
    this.recheckPins(u);
    this.onToolsChanged();
  }

  /** The admin pointed the server somewhere else: forget the old server's pinned definitions (trust on first use
   *  applies to the new one). */
  async resetPins(u: Upstream) {
    await q('delete from tool_pins where upstream_id = $1', [u.id]);
    u.pins.clear();
    u.changed.clear();
    u.tools = [];
    this.rebuildNames(u);
  }
  async reloadAccess(id: number, tool: string) {
    const u = this.ups.get(id);
    if (!u) return;
    const r = await one<{ access: Access }>('select access from tool_policies where upstream_id = $1 and tool = $2', [id, tool]);
    if (r) u.access.set(tool, r.access);
    else u.access.delete(tool);
    this.onToolsChanged();
  }
  async reloadPin(id: number, tool: string) {
    const u = this.ups.get(id);
    if (!u) return;
    const r = await one<{ hash: string; description: string | null }>('select hash, description from tool_pins where upstream_id = $1 and tool = $2', [id, tool]);
    if (r) u.pins.set(tool, r);
    this.recheckPins(u);
    this.onToolsChanged();
  }
  private recheckPins(u: Upstream) {
    for (const t of u.tools) {
      const pin = u.pins.get(t.name);
      if (pin ? pin.hash !== toolHash(t) : u.pins.size > 0) u.changed.add(t.name);
      else u.changed.delete(t.name);
    }
  }

  private rebuildNames(u: Upstream) {
    u.exposed = new Map();
    u.exposedOf = new Map();
    const taken = new Set<string>();
    for (const t of u.tools) {
      const n = safeToolName(t.name, taken);
      taken.add(n);
      u.exposed.set(n, t.name);
      u.exposedOf.set(t.name, n);
    }
  }

  /** Resolve a client-facing tool name (without the slug) to the upstream's own tool name. */
  realName(u: Upstream, exposed: string) {
    return u.exposed.get(exposed) ?? (u.tools.length === 0 ? exposed : undefined);
  }

  /** Re-list a server's tools now. With several replicas the admin may act on a definition another replica already
   *  saw while this one's health loop hasn't re-listed yet. */
  async refreshTools(u: Upstream) {
    if (!u.client) return;
    try {
      this.setTools(u, (await u.client.listTools(undefined, { timeout: config.probeTimeoutMs, cacheMode: 'bypass' } as any)).tools);
    } catch { /* the health loop reports the failure */ }
  }

  /** An admin accepts a changed tool definition: re-pin it and make the tool available again. */
  async approveTool(u: Upstream, tool: string) {
    const t = u.tools.find((x) => x.name === tool);
    if (!t) return false;
    const pin = { hash: toolHash(t), description: t.description ?? null };
    await q(`insert into tool_pins(upstream_id, tool, hash, description) values ($1,$2,$3,$4)
             on conflict (upstream_id, tool) do update set hash = excluded.hash, description = excluded.description, approved_at = now()`,
      [u.id, tool, pin.hash, pin.description]);
    u.pins.set(tool, pin);
    u.changed.delete(tool);
    this.onToolsChanged();
    return true;
  }

  accessOf(u: Upstream, tool: string): Access {
    return u.access.get(tool) ?? 'member';
  }

  async setAccess(u: Upstream, tool: string, access: Access) {
    if (access === 'member') await q('delete from tool_policies where upstream_id = $1 and tool = $2', [u.id, tool]);
    else await q(`insert into tool_policies(upstream_id, tool, access) values ($1,$2,$3)
                  on conflict (upstream_id, tool) do update set access = excluded.access`, [u.id, tool, access]);
    if (access === 'member') u.access.delete(tool);
    else u.access.set(tool, access);
    this.onToolsChanged();
  }

  upsert(r: UpstreamRow) {
    const old = this.ups.get(r.id);
    const u: Upstream = old ?? {
      id: r.id, slug: r.slug, name: r.name, url: r.url, authHeader: null, credential: null, enabled: r.enabled, timeoutMs: null, managedBy: null,
      status: 'connecting', era: null, protocolVersion: null, lastError: null, statusSince: new Date(), tools: [], access: new Map(),
      pins: new Map(), changed: new Set(), exposed: new Map(), exposedOf: new Map(),
      strikes: 0, retryMs: 0, busy: false, again: false, removed: false, gen: 0,
    };
    // stored sealed; plaintext only in this process's memory. A value we can't decrypt must not crash the gateway or
    // be sent as garbage: the server shows auth_failed until an admin re-enters the credential.
    let credential: string | null = null;
    let credentialError: string | undefined;
    try {
      credential = unseal(r.credential);
    } catch {
      credentialError = 'stored credential cannot be decrypted (CREDENTIAL_KEY changed?): re-enter it in the dashboard';
    }
    const reconnect = !old || old.url !== r.url || old.authHeader !== r.auth_header || old.credential !== credential || old.credentialError !== credentialError;
    Object.assign(u, { slug: r.slug, name: r.name, url: r.url, authHeader: r.auth_header, credential, credentialError, enabled: r.enabled, timeoutMs: r.timeout_ms, managedBy: r.managed_by ?? null });
    this.ups.set(r.id, u);
    this.syncManagedHosts();
    if (!u.enabled) {
      clearTimeout(u.timer);
      this.drop(u);
      this.setStatus(u, 'disabled');
      this.onToolsChanged();
      return u;
    }
    if (reconnect) this.drop(u);
    if (u.credentialError) {
      clearTimeout(u.timer);
      this.setStatus(u, 'auth_failed', new Error(u.credentialError));
      this.onToolsChanged();
      return u;
    }
    if (u.status === 'disabled' || (reconnect && old)) this.setStatus(u, 'connecting');
    this.kick(u);
    return u;
  }

  remove(id: number) {
    const u = this.ups.get(id);
    if (!u) return;
    u.removed = true;
    clearTimeout(u.timer);
    this.drop(u);
    this.ups.delete(id);
    this.syncManagedHosts();
    this.onToolsChanged();
  }

  private syncManagedHosts() {
    managedHosts.clear();
    for (const u of this.ups.values()) if (u.managedBy) try { managedHosts.add(new URL(u.url).hostname.toLowerCase()); } catch { /* invalid URL: never allowed */ }
  }

  bySlug(slug: string) {
    for (const u of this.ups.values()) if (u.slug === slug) return u;
  }

  /** Tools visible to MCP clients. A server that just went unreachable keeps its tools for a short grace period
   *  (a blip shouldn't churn client tool lists); calls then get a clear error. */
  catalog() {
    const out: { u: Upstream; t: ToolDef; name: string }[] = [];
    const now = Date.now();
    for (const u of this.ups.values()) {
      const visible = u.status === 'connected' || (u.status === 'unreachable' && now - u.statusSince.getTime() < 15_000);
      if (!u.enabled || !visible) continue;
      for (const t of u.tools) if (!u.changed.has(t.name)) out.push({ u, t, name: `${u.slug}__${u.exposedOf.get(t.name) ?? t.name}` });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private setStatus(u: Upstream, status: Status, err?: unknown) {
    const lastError = err ? errText(err) : null;
    if (u.status !== status) {
      log.info({ upstream: u.slug, from: u.status, status, err: lastError ?? undefined }, 'upstream status');
      u.statusSince = new Date();
      // the grace period in catalog() ends later: tell clients then too
      if (status === 'unreachable') setTimeout(() => u.status === 'unreachable' && this.onToolsChanged(), 15_100).unref();
      q('insert into upstream_events(upstream_id, status, error) values ($1, $2, $3)', [u.id, status, lastError]).catch(() => {});
    }
    u.status = status;
    u.lastError = lastError;
  }

  private drop(u: Upstream) {
    const c = u.client;
    u.gen++;
    u.client = undefined;
    u.sessionId = undefined;
    c?.close().catch(() => {});
  }

  /** Connect (or join the connect already running for the current settings). */
  private connect(u: Upstream): Promise<void> {
    if (u.connecting && u.connecting.gen === u.gen) return u.connecting.p;
    const gen = u.gen;
    const p = this.doConnect(u, gen).finally(() => {
      if (u.connecting?.p === p) u.connecting = undefined;
    });
    u.connecting = { gen, p };
    return p;
  }

  private async doConnect(u: Upstream, gen: number) {
    if (u.credentialError) throw Object.assign(new Error(u.credentialError), { code: 'ECREDENTIAL' });
    const client = new Client({ name: 'urumi-gateway', version: config.version }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } } as any);
    const headers: Record<string, string> = {};
    if (u.authHeader && u.credential) headers[u.authHeader] = u.credential;
    const transport = new StreamableHTTPClientTransport(new URL(u.url), {
      requestInit: { headers },
      fetch: deadlineFetch(u.timeoutMs ?? config.callTimeoutMs),
    });
    try {
      await client.connect(transport, { timeout: config.probeTimeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: config.probeTimeoutMs });
      // removed, disabled, or re-pointed (URL/credential edit) while we were connecting: this client is stale
      if (u.removed || !u.enabled || u.gen !== gen) {
        client.close().catch(() => {});
        return;
      }
      u.client = client;
      u.sessionId = transport.sessionId;
      u.era = client.getDiscoverResult() ? 'modern' : 'legacy';
      u.protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
      this.setTools(u, tools);
      log.info({ upstream: u.slug, era: u.era, version: u.protocolVersion, tools: tools.length }, 'upstream connected');
    } catch (e) {
      client.close().catch(() => {});
      throw e;
    }
  }

  private setTools(u: Upstream, tools: ToolDef[]) {
    const before = JSON.stringify(u.tools);
    u.tools = tools;
    if (JSON.stringify(tools) === before) return;
    this.rebuildNames(u);
    // Trust on first use: the admin who added the server approved what it offered then. A tool whose definition
    // later changes (description, schema, hints), or a tool that appears later, is quarantined until an admin
    // approves it: a server can't slip a new "delete everything" tool in after review.
    const firstSight = u.pins.size === 0;
    for (const t of tools) {
      const hash = toolHash(t);
      const pin = u.pins.get(t.name);
      if (!pin && firstSight) {
        u.pins.set(t.name, { hash, description: t.description ?? null });
        q(`insert into tool_pins(upstream_id, tool, hash, description) values ($1,$2,$3,$4) on conflict do nothing`,
          [u.id, t.name, hash, t.description ?? null]).catch(() => {});
      } else if (!pin || pin.hash !== hash) {
        if (!u.changed.has(t.name)) {
          u.changed.add(t.name);
          const what = pin ? 'changed its definition' : 'appeared after the server was approved';
          log.warn({ upstream: u.slug, tool: t.name }, `tool ${what}: quarantined until an admin approves`);
          q('insert into upstream_events(upstream_id, status, error) values ($1, $2, $3)',
            [u.id, pin ? 'tool_changed' : 'tool_added', `tool "${t.name}" ${what}; hidden until an admin approves it`]).catch(() => {});
        }
      } else u.changed.delete(t.name);
    }
    for (const name of [...u.changed]) if (!tools.some((t) => t.name === name)) u.changed.delete(name);
    this.onToolsChanged();
  }

  private async probe(u: Upstream) {
    try {
      if (!u.client) await this.connect(u);
      else this.setTools(u, (await u.client.listTools(undefined, { timeout: config.probeTimeoutMs, cacheMode: 'bypass' } as any)).tools);
      this.success(u);
      return true;
    } catch (e) {
      this.failure(u, e, 'probe');
      return false;
    }
  }

  success(u: Upstream) {
    u.strikes = 0;
    u.retryMs = 0;
    if (u.status !== 'connected' && u.enabled && u.client) {
      this.setStatus(u, 'connected');
      this.onToolsChanged();
    }
  }

  failure(u: Upstream, e: unknown, where: 'probe' | 'call') {
    const cls = classify(e);
    u.strikes++;
    log.warn({ upstream: u.slug, cls, where, strikes: u.strikes, err: errText(e) }, 'upstream failure');
    if (cls === 'auth') {
      this.drop(u);
      if (u.status !== 'auth_failed') this.onToolsChanged();
      this.setStatus(u, 'auth_failed', e);
      return;
    }
    if (cls === 'hard' || u.strikes >= config.strikes || (where === 'probe' && !u.client)) {
      const was = u.status;
      this.drop(u);
      this.setStatus(u, 'unreachable', e);
      if (was !== 'unreachable') this.onToolsChanged();
      if (where === 'call') this.kick(u, true);
    }
  }

  /** Run the probe loop now (coalesced: never two probes of one upstream at a time). */
  kick(u: Upstream, backoff = false) {
    if (u.removed || !u.enabled) return;
    clearTimeout(u.timer);
    if (backoff) {
      u.retryMs = Math.min(Math.max((u.retryMs || 125) * 2, 250), config.tickMs);
      u.timer = setTimeout(() => this.kick(u), u.retryMs);
      return;
    }
    if (u.busy) {
      u.again = true;
      return;
    }
    u.busy = true;
    this.probe(u).then((ok) => {
      u.busy = false;
      if (u.removed || !u.enabled) return;
      if (u.again) {
        u.again = false;
        return this.kick(u);
      }
      if (!ok && u.status !== 'auth_failed') return this.kick(u, true);
      clearTimeout(u.timer);
      u.timer = setTimeout(() => this.kick(u), u.status === 'auth_failed' ? config.tickMs * 6 : config.tickMs);
    });
  }

  /** Forward one tool call. On a 404 for a known session (upstream restarted and lost it) reconnect and retry once. */
  async call(u: Upstream, name: string, args: Record<string, unknown> | undefined, signal: AbortSignal | undefined, attempt = 0): Promise<any> {
    if (!u.client) await this.connect(u);
    const client = u.client;
    if (!client) throw Object.assign(new Error(`server "${u.name}" is not connected`), { code: 'ECONNREFUSED' });
    try {
      return await client.callTool({ name, arguments: args ?? {} }, { timeout: u.timeoutMs ?? config.callTimeoutMs, signal } as any);
    } catch (e) {
      if (attempt === 0 && e instanceof SdkHttpError && e.status === 404 && u.sessionId) {
        log.info({ upstream: u.slug }, 'session 404: reconnect and retry once');
        this.drop(u);
        return this.call(u, name, args, signal, 1);
      }
      throw e;
    }
  }

  /** Called by the EndpointSlice watch: no ready endpoints -> unreachable now; endpoints back -> probe now. */
  endpointsChanged(u: Upstream, ready: number, ns: string, svc: string) {
    if (!u.enabled || u.removed) return;
    if (ready === 0 && u.status !== 'unreachable') {
      this.drop(u);
      this.setStatus(u, 'unreachable', new Error(`no ready endpoints for ${ns}/${svc} (EndpointSlice watch)`));
      this.onToolsChanged();
    } else if (ready > 0 && u.status === 'unreachable') {
      u.retryMs = 0;
      this.kick(u);
    }
  }

  stop() {
    for (const u of this.ups.values()) {
      clearTimeout(u.timer);
      this.drop(u);
    }
  }
}
