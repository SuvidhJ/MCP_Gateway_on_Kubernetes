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
import { q } from './db.js';
import { log } from './log.js';
import { createGuardedAgent } from './ssrf.js';
import { unseal } from './sealed.js';

export type Status = 'connecting' | 'connected' | 'unreachable' | 'auth_failed' | 'disabled';
/** Who may see and call a tool: everyone ('member'), admins only, or nobody ('off'). */
export type Access = 'member' | 'admin' | 'off';
type ToolDef = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export interface UpstreamRow { id: number; slug: string; name: string; url: string; auth_header: string | null; credential: string | null; enabled: boolean; timeout_ms: number | null }

export interface Upstream {
  id: number; slug: string; name: string; url: string; authHeader: string | null; credential: string | null;
  enabled: boolean; timeoutMs: number | null;
  status: Status; era: 'modern' | 'legacy' | null; protocolVersion: string | null; lastError: string | null;
  statusSince: Date; tools: ToolDef[]; access: Map<string, Access>;
  /** Pinned definitions (rug-pull defence) and the tools whose current definition differs from the pin. */
  pins: Map<string, { hash: string; description: string | null }>; changed: Set<string>;
  client?: Client; sessionId?: string; strikes: number; retryMs: number; timer?: NodeJS.Timeout;
  busy: boolean; again: boolean; removed: boolean;
}

const dispatcher = createGuardedAgent({ allowHosts: config.ssrfAllowHosts, timeout: config.connectTimeoutMs, guard: config.ssrfGuard });
const baseFetch = ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
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
  if (c === 'ESSRF') { // say what was blocked, not just "fetch failed"
    const m = [e?.cause, e?.cause?.cause, e?.cause?.errors?.[0]].find((x) => x?.code === 'ESSRF')?.message;
    if (m) return `${m} (blocked: private, loopback or metadata address; ask an admin to allow-list in-cluster hosts)`;
  }
  return `${String(e?.message ?? e).slice(0, 200)}${c && !String(e?.message).includes(c) ? ` (${c})` : ''}`;
};

export class UpstreamManager {
  readonly ups = new Map<number, Upstream>();
  /** Called when the aggregated tool list may have changed (status flip, tools changed, add/remove). */
  onToolsChanged: () => void = () => {};

  async load() {
    const rows = await q<UpstreamRow>('select id::int as id, slug, name, url, auth_header, credential, enabled, timeout_ms from upstreams order by id');
    const policies = await q<{ upstream_id: number; tool: string; access: Access }>('select upstream_id::int as upstream_id, tool, access from tool_policies');
    const pins = await q<{ upstream_id: number; tool: string; hash: string; description: string | null }>('select upstream_id::int as upstream_id, tool, hash, description from tool_pins');
    // all synchronous from here, so pins are in place before any probe can deliver a tool list
    for (const r of rows) this.upsert(r);
    for (const p of policies) this.ups.get(p.upstream_id)?.access.set(p.tool, p.access);
    for (const p of pins) this.ups.get(p.upstream_id)?.pins.set(p.tool, { hash: p.hash, description: p.description });
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
      id: r.id, slug: r.slug, name: r.name, url: r.url, authHeader: null, credential: null, enabled: r.enabled, timeoutMs: null,
      status: 'connecting', era: null, protocolVersion: null, lastError: null, statusSince: new Date(), tools: [], access: new Map(),
      pins: new Map(), changed: new Set(),
      strikes: 0, retryMs: 0, busy: false, again: false, removed: false,
    };
    const credential = unseal(r.credential); // stored sealed; plaintext only in this process's memory
    const reconnect = !old || old.url !== r.url || old.authHeader !== r.auth_header || old.credential !== credential;
    Object.assign(u, { slug: r.slug, name: r.name, url: r.url, authHeader: r.auth_header, credential, enabled: r.enabled, timeoutMs: r.timeout_ms });
    this.ups.set(r.id, u);
    if (!u.enabled) {
      clearTimeout(u.timer);
      this.drop(u);
      this.setStatus(u, 'disabled');
      this.onToolsChanged();
      return u;
    }
    if (reconnect) this.drop(u);
    if (u.status === 'disabled') this.setStatus(u, 'connecting');
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
    this.onToolsChanged();
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
      for (const t of u.tools) if (!u.changed.has(t.name)) out.push({ u, t, name: `${u.slug}__${t.name}` });
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
    u.client = undefined;
    u.sessionId = undefined;
    c?.close().catch(() => {});
  }

  private async connect(u: Upstream) {
    const client = new Client({ name: 'urumi-gateway', version: config.version }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000 } } } as any);
    const headers: Record<string, string> = {};
    if (u.authHeader && u.credential) headers[u.authHeader] = u.credential;
    const transport = new StreamableHTTPClientTransport(new URL(u.url), {
      requestInit: { headers },
      fetch: deadlineFetch(u.timeoutMs ?? config.callTimeoutMs),
    });
    await client.connect(transport, { timeout: config.probeTimeoutMs });
    const { tools } = await client.listTools(undefined, { timeout: config.probeTimeoutMs });
    if (u.removed || !u.enabled) {
      client.close().catch(() => {});
      return;
    }
    u.client = client;
    u.sessionId = transport.sessionId;
    u.era = client.getDiscoverResult() ? 'modern' : 'legacy';
    u.protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
    this.setTools(u, tools);
    log.info({ upstream: u.slug, era: u.era, version: u.protocolVersion, tools: tools.length }, 'upstream connected');
  }

  private setTools(u: Upstream, tools: ToolDef[]) {
    const before = JSON.stringify(u.tools);
    u.tools = tools;
    if (JSON.stringify(tools) === before) return;
    // Trust on first use: the admin who added the server approved what it offered then. A tool whose definition
    // later changes (description, schema, hints) is quarantined until an admin re-approves it.
    for (const t of tools) {
      const hash = toolHash(t);
      const pin = u.pins.get(t.name);
      if (!pin) {
        u.pins.set(t.name, { hash, description: t.description ?? null });
        q(`insert into tool_pins(upstream_id, tool, hash, description) values ($1,$2,$3,$4) on conflict do nothing`,
          [u.id, t.name, hash, t.description ?? null]).catch(() => {});
      } else if (pin.hash !== hash) {
        if (!u.changed.has(t.name)) {
          u.changed.add(t.name);
          log.warn({ upstream: u.slug, tool: t.name }, 'tool definition changed: quarantined until an admin approves');
          q('insert into upstream_events(upstream_id, status, error) values ($1, $2, $3)',
            [u.id, 'tool_changed', `tool "${t.name}" changed its definition; hidden until an admin approves it`]).catch(() => {});
        }
      } else u.changed.delete(t.name);
    }
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
    try {
      return await u.client!.callTool({ name, arguments: args ?? {} }, { timeout: u.timeoutMs ?? config.callTimeoutMs, signal } as any);
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
