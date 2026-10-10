// The aggregated MCP endpoint: one URL serving both protocol eras (2026-07-28 modern + 2025 legacy) through
// createMcpHandler + a low-level Server built per request for the calling principal.
// createMcpHandler validates no Host/Origin/token, so guards and the key check happen here before it runs, and a
// handler throw would become -32603, so every failure is returned as an `isError` tool result instead.
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { ProtocolError } from '@modelcontextprotocol/client';
import { config } from './config.js';
import { q } from './db.js';
import { log } from './log.js';
import { principalFromJwt, principalFromKey, type Principal } from './auth.js';
import { classify, errText, type Upstream, type UpstreamManager } from './upstreams.js';
import { recordCall } from './metrics.js';

const errResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
const publicOrigin = new URL(config.publicUrl).origin;
const publicHost = new URL(config.publicUrl).hostname.toLowerCase();

async function audit(p: Principal, server: string | null, tool: string, ms: number, outcome: string, error: string | null, era: string, client: string | null) {
  await q(`insert into audit_log(user_id, user_email, via, server, tool, duration_ms, outcome, error, era, client)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [p.userId, p.email, p.via, server, tool, ms, outcome, error, era, client])
    .catch((e) => log.error({ err: e.message }, 'audit insert failed'));
}

export function createGatewayMcp(mgr: UpstreamManager) {
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
    const tool = i > 0 ? full.slice(i + 2) : full;
    const u = slug ? mgr.bySlug(slug) : undefined;
    let outcome = 'ok';
    let error: string | null = null;
    let result: any;
    if (!u || (u.client && !u.tools.some((t) => t.name === tool))) {
      outcome = 'unknown_tool';
      result = errResult(`Tool ${full} does not exist on this gateway.`);
    } else if (u.changed.has(tool)) {
      outcome = 'quarantined';
      result = errResult(`${full} changed its definition since an admin approved it, so it is disabled until an admin reviews the change.`);
    } else if (!allowed(p, u, tool)) {
      outcome = 'denied';
      result = errResult(mgr.accessOf(u, tool) === 'off' ? `${full} is turned off by an administrator.` : `${full} is restricted to admins; your role is "${p.role}".`);
    } else if (!u.enabled) {
      outcome = 'disabled';
      result = errResult(`Server "${u.name}" is disabled by an administrator; ${full} is unavailable.`);
    } else if (u.status !== 'connected') {
      outcome = u.status === 'auth_failed' ? 'upstream_auth' : 'unreachable';
      result = errResult(`Server "${u.name}" is ${u.status === 'auth_failed' ? 'rejecting the gateway credential' : 'unreachable'}${u.lastError ? ` (${u.lastError})` : ''}. Other servers are unaffected.`);
    } else {
      try {
        const r = await mgr.call(u, tool, args, signal);
        mgr.success(u);
        result = { content: r.content ?? [], ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
        if (r.isError) {
          outcome = 'tool_error';
          error = String(r.content?.[0]?.text ?? '').slice(0, 300);
        }
      } catch (e: any) {
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
      capabilities: { tools: { listChanged: true } },
      // tool lists are filtered per user, so never shared between callers
      cacheHints: { 'tools/list': { ttlMs: config.toolsTtlMs, cacheScope: 'private' } },
    } as any);
    s.setRequestHandler('tools/list', async () => ({ tools: searchMode ? META_TOOLS : visible(p).map(toolDef) }));
    s.setRequestHandler('tools/call', async (req: any, ctx: any) => {
      const client = ctx?.mcpReq?.envelope?.['io.modelcontextprotocol/clientInfo']?.name ?? requestInfo?.headers.get('user-agent')?.slice(0, 80) ?? null;
      const name: string = req.params.name;
      const args = req.params.arguments ?? {};
      if (searchMode && name === 'gateway__search_tools') return search(p, String(args.query ?? ''), Number(args.limit ?? 5));
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

  // Token buckets per caller (API key, or user for delegated chat tokens). In memory: per replica.
  const buckets = new Map<string, { tokens: number; at: number }>();
  const take = (id: string) => {
    const now = Date.now();
    const b = buckets.get(id) ?? { tokens: config.rateBurst, at: now };
    b.tokens = Math.min(config.rateBurst, b.tokens + ((now - b.at) / 60_000) * config.ratePerMin);
    b.at = now;
    buckets.set(id, b);
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / config.ratePerMin) * 60);
    b.tokens -= 1;
    return 0;
  };

  const json = (status: number, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
      status, headers: { 'content-type': 'application/json', ...headers },
    });

  async function fetch(req: Request): Promise<Response> {
    // DNS-rebinding guards: Host must be ours; a browser Origin must be our own origin.
    const host = (req.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host !== publicHost && !config.allowedHosts.includes(host)) return json(403, `Forbidden: unexpected Host "${host}"`);
    const origin = req.headers.get('origin');
    if (origin && origin !== publicOrigin) return json(403, `Forbidden: cross-origin request from ${origin}`);

    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!m) return json(401, 'Unauthorized: send "Authorization: Bearer <gateway API key>". Create a key in the dashboard.', { 'www-authenticate': 'Bearer realm="urumi"' });
    const principal = m[1].startsWith('urumi_') ? await principalFromKey(m[1]) : await principalFromJwt(m[1]);
    if (!principal) return json(401, 'Unauthorized: this API key is unknown, revoked, or its user is disabled.', { 'www-authenticate': 'Bearer realm="urumi", error="invalid_token"' });

    if (req.method === 'POST') {
      const wait = take(principal.keyId ? `key:${principal.keyId}` : `user:${principal.userId}`);
      if (wait) return json(429, `Rate limit: ${config.ratePerMin} requests/minute per key (burst ${config.rateBurst}). Retry in ${wait}s.`, { 'retry-after': String(wait) });
    }

    const res = await handler.fetch(req, { authInfo: { token: 'redacted', clientId: principal.email, scopes: [], extra: { principal } } });
    if (!principal.keyId || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res;
    // Wrap SSE bodies so a key revocation can end them.
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
