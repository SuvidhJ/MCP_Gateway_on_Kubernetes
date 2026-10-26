// The aggregated MCP endpoint: one URL serving both protocol eras (2026-07-28 modern + 2025 legacy) through
// createMcpHandler + a low-level Server built per request for the calling principal.
// createMcpHandler validates no Host/Origin/token, so guards and the key check happen here before it runs, and a
// handler throw would become -32603, so every failure is returned as an `isError` tool result instead.
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { ProtocolError } from '@modelcontextprotocol/client';
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';
import { principalFromJwt, principalFromKey, type Principal, type Rejected } from './auth.js';
import { classify, errText, type Upstream, type UpstreamManager } from './upstreams.js';
import { recordCall } from './metrics.js';
import { rateTake } from './db.js';

const errResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
const publicHost = new URL(config.publicUrl).hostname.toLowerCase();
const origins = new Set([new URL(config.publicUrl).origin, ...config.extraOrigins]);
const extraHosts = new Set(config.extraOrigins.map((o) => new URL(o).hostname.toLowerCase()));

/** Pluggable pieces owned by other modules (OAuth). Defaults: API keys only. */
export interface McpHooks {
  /** Builds the WWW-Authenticate value for a 401 on this request (resource_metadata when OAuth is on). */
  challenge: (req: Request) => (error?: string, description?: string) => string;
  principalFromOAuth: (token: string, req: Request) => Promise<Principal | Rejected | undefined>;
}
const bearer = (error?: string, description?: string) =>
  `Bearer realm="urumi"${error ? `, error="${error}"` : ''}${description ? `, error_description="${description.replace(/"/g, "'")}"` : ''}`;
export const defaultHooks: McpHooks = { challenge: () => bearer, principalFromOAuth: async () => undefined };

async function audit(p: { userId: number; email: string; via: string }, server: string | null, tool: string, ms: number, outcome: string, error: string | null, era: string, client: string | null) {
  await q(`insert into audit_log(user_id, user_email, via, server, tool, duration_ms, outcome, error, era, client)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.userId, p.email, p.via, server, tool, ms, outcome, error, era, client])
    .catch((e) => log.error({ err: e.message }, 'audit insert failed'));
}

export function createGatewayMcp(mgr: UpstreamManager, hooks: McpHooks = defaultHooks) {
  /** Call-time authorization (stand-out S-2), checked on every list and every call: a restricted tool is hidden from
   *  tools/list and rejected if called by name. Identity is re-checked per HTTP request, so a revoked key fails on
   *  its very next call. */
  const allowed = (p: Principal, u: Upstream, tool: string) => {
    const a = mgr.accessOf(u, tool);
    return a === 'member' || (a === 'admin' && p.role === 'admin');
  };

  /** Route one tool call to its upstream with every check, audit it, and return an MCP result (never throws). */
  async function invoke(p: Principal, full: string, args: Record<string, unknown> | undefined, signal: AbortSignal | undefined, era: string, client: string | null) {
    const t0 = Date.now();
    const i = full.indexOf('__');
    const slug = i > 0 ? full.slice(0, i) : null;
    const exposedTool = i > 0 ? full.slice(i + 2) : full;
    const u = slug ? mgr.bySlug(slug) : undefined;
    // the upstream's own name (client-facing names are sanitised); unknown while the server has never listed tools
    const real = u ? mgr.realName(u, exposedTool) : undefined;
    const tool = real ?? exposedTool;
    let outcome = 'ok';
    let error: string | null = null;
    let result: any;
    if (!u || !real) {
      outcome = 'unknown_tool';
      result = errResult(`Tool ${full} does not exist on this gateway.`);
    } else if (u.changed.has(tool)) {
      outcome = 'quarantined';
      result = errResult(`${full} ${u.pins.has(tool) ? 'changed its definition since an admin approved it' : 'is new and not yet approved'}, so it is disabled until an admin reviews it.`);
    } else if (!allowed(p, u, tool)) {
      outcome = 'denied';
      result = errResult(mgr.accessOf(u, tool) === 'off' ? `${full} is turned off by an administrator.` : `${full} is restricted to admins; your role is "${p.role}".`);
    } else if (!u.enabled) {
      outcome = 'disabled';
      result = errResult(`Server "${u.name}" is disabled by an administrator; ${full} is unavailable.`);
    } else if (u.status !== 'connected' && u.status !== 'connecting') {
      outcome = u.status === 'auth_failed' ? 'upstream_auth' : 'unreachable';
      result = errResult(`Server "${u.name}" is ${u.status === 'auth_failed' ? 'rejecting the gateway credential' : 'unreachable'}${u.lastError ? ` (${u.lastError})` : ''}. Other servers are unaffected.`);
    } else {
      try {
        const r = await mgr.call(u, tool, args, signal);
        mgr.success(u);
        result = { content: r.content ?? [], ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
        const size = Buffer.byteLength(JSON.stringify(result));
        if (size > config.maxResultBytes) {
          outcome = 'too_large';
          result = errResult(`${full} returned ${Math.round(size / 1024)} KB, more than the gateway passes through (${Math.round(config.maxResultBytes / 1024)} KB). Ask for less (filters, smaller pages).`);
        } else if (r.isError) {
          outcome = 'tool_error';
          error = String(r.content?.[0]?.text ?? '').slice(0, 300);
        }
      } catch (e: any) {
        if (signal?.aborted) {
          // the client gave up (closed the request / sent notifications/cancelled): not the upstream's fault
          outcome = 'cancelled';
          error = 'cancelled by the client';
          result = errResult(`The call to ${full} was cancelled.`);
        } else {
          const cls = classify(e);
          outcome = cls === 'hard' ? 'unreachable' : cls === 'soft' ? 'timeout' : cls === 'auth' ? 'upstream_auth' : 'error';
          if (cls !== 'other') mgr.failure(u, e, 'call');
          error = errText(e);
          const secs = (u.timeoutMs ?? config.callTimeoutMs) / 1000;
          result = errResult(cls === 'soft' ? `Server "${u.name}" did not answer within ${secs}s; the call was cancelled. Other servers are unaffected.`
            : cls === 'hard' ? `Server "${u.name}" is unreachable (${error}). Other servers are unaffected.`
            : `Server "${u.name}" failed: ${e instanceof ProtocolError ? 'protocol error: ' : ''}${error}`);
        }
      }
    }
    recordCall(slug, outcome, Date.now() - t0);
    await audit(p, slug, tool, Date.now() - t0, outcome, error ?? (outcome === 'ok' ? null : result.content[0].text), era, client);
    return result;
  }

  const visible = (p: Principal) => mgr.catalog().filter((e) => allowed(p, e.u, e.t.name));
  const toolDef = ({ u, t, name }: ReturnType<UpstreamManager['catalog']>[number]) => ({
    name,
    ...(t.title ? { title: t.title } : {}),
    description: `[${u.name}] ${t.description ?? ''}`.trim(),
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  });

  // "Many tools" mode (/mcp?tools=search): instead of every tool, clients get two meta-tools, so a model facing
  // hundreds of upstream tools only pays for the few it searches for. Same authorization, routing and audit.
  const META_TOOLS: any[] = [
    {
      name: 'gateway__search_tools',
      description: 'Search the tools available through this gateway (every connected server). Returns the best matches with their input schemas; then run one with gateway__call_tool.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do, e.g. "list orders"' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } }, required: ['query'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'gateway__call_tool',
      description: 'Run a tool found with gateway__search_tools. `name` is the exact tool name, `arguments` matches its input schema.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
    },
  ];
  const search = (p: Principal, query: string, limit = 5) => {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const scored = visible(p).map((e) => {
      const name = e.name.toLowerCase();
      const desc = `${e.u.name} ${e.t.title ?? ''} ${e.t.description ?? ''}`.toLowerCase();
      return { e, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (desc.includes(w) ? 1 : 0), 0) };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 20));
    const tools = scored.map(({ e }) => toolDef(e));
    const hint = `No match. Servers: ${[...new Set(visible(p).map((e) => e.u.name))].join(', ')}`;
    return { content: [{ type: 'text' as const, text: JSON.stringify(tools.length ? { tools } : { tools: [], hint }) }] };
  };

  const handler = createMcpHandler(({ authInfo, era, requestInfo }) => {
    const p = authInfo!.extra!.principal as Principal;
    const searchMode = requestInfo ? new URL(requestInfo.url).searchParams.get('tools') === 'search' : false;
    const s = new Server({ name: 'urumi-gateway', version: config.version }, {
      // 2025-era clients are served statelessly (no session, GET -> 405: any replica can answer), so they can't be
      // pushed to; they see changes on their next tools/list. Modern clients get list_changed on their listen stream.
      capabilities: { tools: { listChanged: era === 'modern' } },
      // tool lists are filtered per user, so never shared between callers
      cacheHints: { 'tools/list': { ttlMs: config.toolsTtlMs, cacheScope: 'private' } },
    } as any);
    s.setRequestHandler('tools/list', async () => ({ tools: searchMode ? META_TOOLS : visible(p).map(toolDef) }));
    s.setRequestHandler('tools/call', async (req: any, ctx: any) => {
      const client = ctx?.mcpReq?.envelope?.['io.modelcontextprotocol/clientInfo']?.name ?? requestInfo?.headers.get('user-agent')?.slice(0, 80) ?? null;
      const name: string = req.params.name;
      const args = req.params.arguments ?? {};
      if (searchMode && name === 'gateway__search_tools') {
        // answered by the gateway itself, but still a tool call: audited like every other one
        const t0 = Date.now();
        const r = search(p, String(args.query ?? ''), Number(args.limit ?? 5));
        await audit(p, 'gateway', 'search_tools', Date.now() - t0, 'ok', null, era, client);
        return r;
      }
      if (searchMode && name === 'gateway__call_tool') return invoke(p, String(args.name ?? ''), args.arguments, ctx?.mcpReq?.signal, era, client);
      return invoke(p, name, args, ctx?.mcpReq?.signal, era, client);
    });
    return s;
  }, { keepAliveMs: 15_000, onerror: (e) => log.debug({ err: e.message }, 'mcp handler') });

  // Open response streams per API key, so revoking a key also ends its listen streams.
  const streams = new Map<number, Set<() => void>>();
  const closeKeyStreams = (keyId: number) => {
    for (const close of streams.get(keyId) ?? []) close();
    streams.delete(keyId);
  };

  const json = (status: number, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
      status, headers: { 'content-type': 'application/json', ...headers },
    });

  /** The JSON-RPC method (and tool name for tools/call) of a request we are about to reject, for the audit log. */
  async function describe(req: Request) {
    if (req.method !== 'POST') return { server: null as string | null, tool: `(${req.method})`, era: 'unknown' };
    try {
      const body = await req.clone().json() as any;
      const msg = Array.isArray(body) ? body[0] : body;
      const era = req.headers.get('mcp-protocol-version') ?? 'unknown';
      if (msg?.method !== 'tools/call') return { server: null, tool: `(${String(msg?.method ?? 'unknown').slice(0, 60)})`, era };
      const name = String(msg?.params?.name ?? '').slice(0, 200);
      const i = name.indexOf('__');
      return i > 0 ? { server: name.slice(0, i), tool: name.slice(i + 2), era } : { server: null, tool: name, era };
    } catch {
      return { server: null, tool: '(unparseable request)', era: 'unknown' };
    }
  }

  async function fetch(req: Request): Promise<Response> {
    // DNS-rebinding guards: Host must be ours; a browser Origin must be our own origin.
    const host = (req.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host !== publicHost && !extraHosts.has(host) && !config.allowedHosts.includes(host)) return json(403, `Forbidden: unexpected Host "${host}"`);
    const origin = req.headers.get('origin');
    if (origin && !origins.has(origin)) return json(403, `Forbidden: cross-origin request from ${origin}`);

    const challenge = hooks.challenge(req);
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!m) return json(401, 'Unauthorized: send "Authorization: Bearer <gateway API key>" (create one in the dashboard), or sign in with OAuth.', { 'www-authenticate': challenge() });
    const token = m[1];
    // uat_ = OAuth access token, urumi_ = API key, anything else = the chat's delegated JWT
    const found = token.startsWith('uat_') ? await hooks.principalFromOAuth(token, req)
      : token.startsWith('urumi_') ? await principalFromKey(token) : await principalFromJwt(token);
    if (!found) return json(401, 'Unauthorized: this token is unknown or expired.', { 'www-authenticate': challenge('invalid_token', 'unknown or expired token') });
    if ('rejected' in found) {
      // a credential we know but refuse: the attempt still belongs in the audit log, under its owner
      const d = await describe(req);
      await audit(found, d.server, d.tool, 0, 'rejected', found.reason, d.era, req.headers.get('user-agent')?.slice(0, 80) ?? null);
      return json(401, `Unauthorized: ${found.reason}.`, { 'www-authenticate': challenge('invalid_token', found.reason) });
    }
    const principal = found;

    if (req.method === 'POST') {
      const wait = await rateTake(`mcp:${principal.bucket}`, config.rateBurst, config.ratePerMin);
      if (wait) return json(429, `Rate limit: ${config.ratePerMin} requests/minute per key (burst ${config.rateBurst}). Retry in ${wait}s.`, { 'retry-after': String(wait) });
    }

    const res = await handler.fetch(req, { authInfo: { token: 'redacted', clientId: principal.email, scopes: [], extra: { principal } } });
    if (!principal.keyId || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res;
    // Wrap SSE bodies so a key revocation can end them (OAuth grants use negative ids in the same map).
    const keyId = principal.keyId;
    const reader = res.body.getReader();
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        close = () => {
          reader.cancel().catch(() => {});
          try { ctrl.close(); } catch {}
        };
        const set = streams.get(keyId) ?? new Set();
        set.add(close);
        streams.set(keyId, set);
      },
      async pull(ctrl) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) {
          streams.get(keyId)?.delete(close);
          try { ctrl.close(); } catch {}
        } else ctrl.enqueue(value!);
      },
      cancel() {
        streams.get(keyId)?.delete(close);
        return reader.cancel();
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  }

  return { fetch, notify: () => handler.notify.toolsChanged(), closeKeyStreams, close: () => handler.close() };
}
