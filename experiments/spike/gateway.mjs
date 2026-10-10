// Spike gateway for experiments E1/E3/E4/E12/E13/E14/E17. Not product code: no DB, no real auth, in-memory state.
// Downstream: createMcpHandler + low-level Server (dual-era on one URL).
// Upstream:   one SDK Client per upstream, versionNegotiation 'auto', fetch-level deadlines, 404 re-init + retry once.
//
// Env:
//   PORT=7801  UPSTREAMS='[{"slug":"demo","url":"http://127.0.0.1:7802/mcp","headers":{}}]'
//   KEYS='k1:alice:admin,k2:bob:member'   AUTH_STYLE=plain401|bearer401|bearer401meta|403   TOOLS_TTL_MS=0
//   CALL_TIMEOUT_MS=10000  TICK_MS=5000  LOG=out/gateway-requests.jsonl  HOST=127.0.0.1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Client, StreamableHTTPClientTransport, SdkHttpError, SdkError, ProtocolError } from '@modelcontextprotocol/client';
import { fetch as undiciFetch } from 'undici';
import { createGuardedAgent } from './ssrf-guard.mjs';

const PORT = Number(process.env.PORT ?? 7801);
const HOST = process.env.HOST ?? '127.0.0.1';
const UPSTREAMS = JSON.parse(process.env.UPSTREAMS ?? '[{"slug":"demo","url":"http://127.0.0.1:7802/mcp"}]');
const KEYS = new Map((process.env.KEYS ?? 'k1:alice:admin,k2:bob:member').split(',').map(s => {
  const [key, user, role] = s.split(':'); return [key, { user, role }];
}));
const AUTH_STYLE = process.env.AUTH_STYLE ?? 'plain401';
const TTL = Number(process.env.TOOLS_TTL_MS ?? 0);
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? 10_000);
const TICK_MS = Number(process.env.TICK_MS ?? 5_000);
const LOG = process.env.LOG ?? 'out/gateway-requests.jsonl';
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const revoked = new Set();

const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const ev = (o) => { log({ kind: 'event', ...o }); console.error('[gw]', JSON.stringify(o)); };

// ---------- upstream side ----------
// Deadline on every POST attempt (below the SDK, so SDK timeout bugs #2695/#2739 can't hang us). GET streams untouched.
// SSRF guard + short connect timeout (E17: a SYN dropped during kube-proxy rule changes otherwise hangs for undici's 10 s default).
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 2000);
const dispatcher = createGuardedAgent({ allowHosts: (process.env.ALLOW_PRIVATE_HOSTS ?? '127.0.0.1,localhost').split(',').filter(Boolean), timeout: CONNECT_TIMEOUT_MS });
const baseFetch = process.env.SSRF_GUARD === '0' ? fetch : (url, init) => undiciFetch(url, { ...init, dispatcher });
const deadlineFetch = (ms) => (url, init = {}) => {
  if ((init.method ?? 'GET').toUpperCase() !== 'POST') return baseFetch(url, init);
  const signals = [AbortSignal.timeout(ms)]; if (init.signal) signals.push(init.signal);
  return baseFetch(url, { ...init, signal: AbortSignal.any(signals) });
};

const ups = UPSTREAMS.map(u => ({ ...u, enabled: true, status: 'connecting', client: null, era: null, version: null, tools: [], lastError: null, since: Date.now() }));

function setStatus(u, status, err) {
  if (u.status !== status) { ev({ upstream: u.slug, status, from: u.status, err: err ? String(err.message ?? err) : undefined }); u.since = Date.now(); }
  u.status = status; u.lastError = err ? String(err.message ?? err) : null;
}

async function connectUpstream(u) {
  const client = new Client({ name: 'spike-gateway', version: '0.0.1' }, { versionNegotiation: { mode: process.env.NEGOTIATION ?? 'auto', probe: { timeoutMs: 5000 } } });
  const transport = new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: u.headers ?? {} }, fetch: deadlineFetch(CALL_TIMEOUT_MS) });
  const t0 = Date.now();
  await client.connect(transport, { timeout: 8000 });
  const { tools } = await client.listTools(undefined, { timeout: 8000 });
  u.client = client; u.tools = tools; u.era = client.getDiscoverResult() ? 'modern' : 'legacy';
  u.version = client.getNegotiatedProtocolVersion(); u.sessionId = transport.sessionId;
  ev({ upstream: u.slug, connected: true, era: u.era, version: u.version, session: !!transport.sessionId, tools: tools.map(t => t.name), ms: Date.now() - t0 });
  setStatus(u, 'connected');
}

async function dropClient(u) { try { await u.client?.close(); } catch {} u.client = null; }

let notify = () => {};
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 10_000);
const STRIKES = Number(process.env.STRIKES ?? 3);
// Failure classes measured in spike/errshapes.mjs:
//   hard  = connection refused / DNS failure / reset -> unreachable immediately (fast kill-pod detection)
//   soft  = timeouts -> strike; STRIKES consecutive strikes -> unreachable
//   auth  = 401/403 -> auth_failed (admin must fix the credential)
const causeCode = (e) => e?.cause?.code ?? e?.cause?.cause?.code ?? e?.cause?.errors?.[0]?.code;
function classify(e) {
  if (e instanceof SdkHttpError && (e.status === 401 || e.status === 403)) return 'auth';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ESSRF/.test(String(causeCode(e)))) return 'hard';
  if (e?.name === 'TypeError' && /fetch failed/.test(e.message)) return 'hard';
  if (e instanceof SdkError && String(e.code).includes('ERA_NEGOTIATION_FAILED') && /fetch failed/.test(e.message)) return 'hard';
  if (e instanceof SdkHttpError && [502, 503, 504].includes(e.status)) return 'hard';
  if (/timed? ?out|TimeoutError|REQUEST_TIMEOUT|AbortError/i.test(String(e?.name) + String(e?.message) + String(e?.code))) return 'soft';
  return 'other';
}
function recordFailure(u, e, where) {
  const cls = classify(e);
  u.strikes = (u.strikes ?? 0) + 1;
  ev({ upstream: u.slug, failure: cls, where, strikes: u.strikes, err: String(e?.message ?? e).slice(0, 120), cause: causeCode(e) });
  if (cls === 'auth') { setStatus(u, 'auth_failed', e); notify(); return; }
  if (cls === 'hard' || u.strikes >= STRIKES) {
    const was = u.status; dropClient(u); setStatus(u, 'unreachable', e); if (was !== 'unreachable') notify();
    if (where === 'call') scheduleFastRetry(u);
  }
}
function recordSuccess(u) { u.strikes = 0; u.retryMs = 0; if (u.status !== 'connected') { setStatus(u, 'connected'); notify(); } }
const FAST_RETRY = process.env.FAST_RETRY !== '0';
function scheduleFastRetry(u) {
  if (!FAST_RETRY || !u.enabled) return;
  u.retryMs = Math.min(Math.max((u.retryMs || 125) * 2, 250), TICK_MS);
  clearTimeout(u.timer); u.timer = setTimeout(() => u.loop?.(), u.retryMs); u.timer.unref?.();
}

// One independent, non-overlapping loop per upstream (a slow upstream never delays the others).
async function probeOnce(u) {
  if (!u.enabled) return;
  try {
    if (!u.client) await connectUpstream(u);
    else await u.client.listTools(undefined, { timeout: PROBE_TIMEOUT_MS, cacheMode: 'bypass' });
    recordSuccess(u);
  } catch (e) { recordFailure(u, e, 'probe'); return false; }
  return true;
}
function startLoop(u) {
  const loop = async () => {
    clearTimeout(u.timer);
    const ok = await probeOnce(u);
    if (ok === false && u.status === 'unreachable' && FAST_RETRY) return scheduleFastRetry(u);
    u.timer = setTimeout(loop, TICK_MS); u.timer.unref?.();
  };
  u.loop = loop; loop();
}
async function tick() { await Promise.all(ups.map(probeOnce)); }

async function callUpstream(u, name, args, signal, attempt = 0) {
  try {
    return await u.client.callTool({ name, arguments: args ?? {} }, { timeout: CALL_TIMEOUT_MS, signal });
  } catch (e) {
    if (attempt === 0 && e instanceof SdkHttpError && e.status === 404 && u.sessionId) {
      ev({ upstream: u.slug, reinit: 'session 404 -> reconnect + retry once' });
      await dropClient(u); await connectUpstream(u);
      return callUpstream(u, name, args, signal, 1);
    }
    throw e;
  }
}

// ---------- optional: EndpointSlice watch (decision 13 stand-out) ----------
// K8S_WATCH="exp/demo-upstream=demo,exp/woo-mcp=store"  (namespace/service=slug). Uses the pod's ServiceAccount token;
// needs a Role with get/list/watch on discovery.k8s.io endpointslices in that namespace.
if (process.env.K8S_WATCH) {
  const { Agent: UAgent } = await import('undici');
  const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
  const token = fs.readFileSync(`${SA}/token`, 'utf8');
  const k8s = new UAgent({ connect: { ca: fs.readFileSync(`${SA}/ca.crt`) }, bodyTimeout: 0 });
  for (const pair of process.env.K8S_WATCH.split(',')) {
    const [nsSvc, slug] = pair.split('='); const [ns, svc] = nsSvc.split('/');
    const u = ups.find(x => x.slug === slug); if (!u) continue;
    const watchLoop = async () => {
      for (;;) {
        try {
          const url = `https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3D${svc}&watch=true`;
          const res = await undiciFetch(url, { dispatcher: k8s, headers: { authorization: `Bearer ${token}` } });
          if (!res.ok) { ev({ k8sWatch: svc, httpStatus: res.status, body: (await res.text()).slice(0, 160) }); await new Promise(r => setTimeout(r, 5000)); continue; }
          ev({ k8sWatch: svc, watching: true });
          let buf = ''; const slices = new Map();
          for await (const chunk of res.body) {
            buf += Buffer.from(chunk).toString();
            let i; while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
              const { type, object } = JSON.parse(line);
              if (type === 'DELETED') slices.delete(object.metadata.name); else slices.set(object.metadata.name, object);
              const ready = [...slices.values()].reduce((n, sl) => n + (sl.endpoints ?? []).filter(e => e.conditions?.ready).length, 0);
              if (!u.enabled) continue;
              if (ready === 0 && u.status === 'connected') { dropClient(u); setStatus(u, 'unreachable', new Error(`no ready endpoints for ${ns}/${svc} (EndpointSlice watch)`)); notify(); }
              else if (ready > 0 && u.status === 'unreachable') { ev({ k8sWatch: svc, readyEndpoints: ready, action: 'probe now' }); u.loop?.(); }
            }
          }
        } catch (e) { ev({ k8sWatch: svc, error: String(e.message ?? e) }); }
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    watchLoop();
  }
}

// ---------- downstream side ----------
const catalog = () => {
  const out = [];
  for (const u of ups) {
    if (!u.enabled || u.status !== 'connected') continue;
    for (const t of u.tools) out.push({ u, t, name: `${u.slug}__${t.name}` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};
const allowed = (principal, entry) => principal.role === 'admin' || !/^(slow|fail)$/.test(entry.t.name) || true; // spike: all allowed

const toolDef = ({ u, t, name }) => ({
  name,
  ...(t.title ? { title: t.title } : {}),
  description: `[${u.slug}] ${t.description ?? ''}`.trim(),
  inputSchema: t.inputSchema,
  ...(t.annotations ? { annotations: t.annotations } : {}),
});

const errResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const handler = createMcpHandler(({ authInfo, era }) => {
  const principal = authInfo?.extra ?? { user: 'anon', role: 'none' };
  const s = new Server({ name: 'spike-gateway', version: '0.0.1' }, {
    capabilities: { tools: { listChanged: true } },
    cacheHints: { 'tools/list': { ttlMs: TTL, cacheScope: 'private' } },
  });
  s.setRequestHandler('tools/list', async () => ({ tools: catalog().filter(e => allowed(principal, e)).map(toolDef) }));
  s.setRequestHandler('tools/call', async (req, ctx) => {
    const t0 = Date.now();
    const entry = ups.flatMap(u => u.tools.map(t => ({ u, t, name: `${u.slug}__${t.name}` }))).find(e => e.name === req.params.name);
    let outcome = 'ok', result;
    if (!entry) { outcome = 'unknown_tool'; result = errResult(`Tool ${req.params.name} does not exist on this gateway.`); }
    else if (!entry.u.enabled) { outcome = 'disabled'; result = errResult(`Server "${entry.u.slug}" is disabled by an administrator; tool ${req.params.name} is unavailable.`); }
    else if (!entry.u.client) { outcome = 'unreachable'; result = errResult(`Server "${entry.u.slug}" is unreachable (${entry.u.lastError ?? 'not connected'}). Other servers are unaffected.`); }
    else {
      try {
        const r = await callUpstream(entry.u, entry.t.name, req.params.arguments, ctx.mcpReq.signal);
        entry.u.strikes = 0;
        result = { content: r.content ?? [], ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
        if (r.isError) outcome = 'tool_error';
      } catch (e) {
        const cls = classify(e);
        outcome = cls === 'hard' ? 'unreachable' : cls === 'soft' ? 'timeout' : cls === 'auth' ? 'upstream_auth' : (e instanceof ProtocolError ? 'protocol_error' : 'error');
        if (cls !== 'other') recordFailure(entry.u, e, 'call');
        const timedOut = /timed? ?out|TimeoutError|REQUEST_TIMEOUT/i.test(String(e?.name) + String(e?.message) + String(e?.code));
        result = errResult(timedOut ? `Server "${entry.u.slug}" timed out after ${CALL_TIMEOUT_MS / 1000}s.` : `Server "${entry.u.slug}" failed: ${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    log({ kind: 'audit', user: principal.user, era, tool: req.params.name, outcome, ms: Date.now() - t0, via: ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo']?.name });
    return result;
  });
  return s;
}, { keepAliveMs: Number(process.env.KEEPALIVE_MS ?? 15_000) });
notify = () => { try { handler.notify.toolsChanged(); ev({ notify: 'toolsChanged' }); } catch (e) { ev({ notifyError: String(e) }); } };
const nodeHandler = toNodeHandler(handler);

function unauthorized(res, why) {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `Unauthorized: ${why}` }, id: null });
  if (AUTH_STYLE === '403') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(body); }
  const h = { 'content-type': 'application/json' };
  if (AUTH_STYLE === 'bearer401') h['www-authenticate'] = 'Bearer realm="urumi", error="invalid_token"';
  if (AUTH_STYLE === 'bearer401meta') h['www-authenticate'] = `Bearer realm="urumi", resource_metadata="http://${HOST}:${PORT}/.well-known/oauth-protected-resource"`;
  res.writeHead(401, h); res.end(body);
}

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); };

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  let body;
  if (req.method === 'POST') { const ch = []; for await (const c of req) ch.push(c); const raw = Buffer.concat(ch).toString(); try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; } }
  const origWriteHead = res.writeHead.bind(res); let status;
  res.writeHead = (s, ...rest) => { status = s; return origWriteHead(s, ...rest); };
  res.on('close', () => {
    if (url.pathname.startsWith('/admin')) return;
    const h = req.headers;
    log({ kind: 'req', http: req.method, path: url.pathname, status: status ?? res.statusCode, ms: Date.now() - t0,
      ua: h['user-agent'], accept: h.accept, ctype: h['content-type'], auth: h.authorization ? h.authorization.slice(0, 12) + '…' : null,
      hdr: Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('mcp-') || k === 'last-event-id' || k === 'origin')),
      method: body?.method, id: body?.id, metaVersion: body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'],
      clientInfo: body?.params?._meta?.['io.modelcontextprotocol/clientInfo'] ?? body?.params?.clientInfo,
      caps: body?.params?._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? body?.params?.capabilities,
      params: body?.method === 'subscriptions/listen' || body?.method === 'initialize' || body?.method === 'tools/call' ? body.params : undefined });
  });

  // admin (spike only: unauthenticated, localhost)
  if (url.pathname.startsWith('/admin')) {
    const q = url.searchParams; const u = ups.find(x => x.slug === q.get('slug'));
    switch (url.pathname) {
      case '/admin/state': return json(res, 200, ups.map(({ client, timer, loop, ...x }) => ({ ...x, tools: x.tools.map(t => t.name) })));
      case '/admin/revoke': revoked.add(q.get('key')); ev({ revoked: q.get('key') }); return json(res, 200, { ok: true });
      case '/admin/unrevoke': revoked.delete(q.get('key')); return json(res, 200, { ok: true });
      case '/admin/disable': if (u) { u.enabled = false; await dropClient(u); setStatus(u, 'disabled'); notify(); } return json(res, 200, { ok: !!u });
      case '/admin/enable': if (u) { u.enabled = true; setStatus(u, 'connecting'); await probeOnce(u); } return json(res, 200, { ok: !!u });
      case '/admin/mem': { global.gc?.(); global.gc?.(); const m = process.memoryUsage(); return json(res, 200, { rssMB: +(m.rss / 1048576).toFixed(1), heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), externalMB: +(m.external / 1048576).toFixed(1), gc: !!global.gc }); }
      case '/admin/notify': notify(); return json(res, 200, { ok: true });
      default: return json(res, 404, {});
    }
  }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname !== '/mcp') return json(res, 404, { error: 'not found' });

  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return unauthorized(res, 'missing bearer key');
  const k = KEYS.get(m[1]);
  if (!k) return unauthorized(res, 'unknown key');
  if (revoked.has(m[1])) return unauthorized(res, 'key revoked');
  req.auth = { token: 'redacted', clientId: k.user, scopes: [], extra: k };
  try { await nodeHandler(req, res, body); } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: String(e) }); }
});

server.listen(PORT, HOST, async () => {
  ev({ listening: `${HOST}:${PORT}`, upstreams: ups.map(u => u.slug), authStyle: AUTH_STYLE, ttl: TTL });
  ups.forEach(startLoop);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { ev({ shutdown: sig }); await handler.close?.(); server.close(); process.exit(0); });
