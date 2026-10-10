// Spike upstream MCP server used by E1/E3/E13/E14/E17. Not product code.
// Modes:
//   default            createMcpHandler (dual-era: modern 2026-07-28 + stateless legacy)
//   MODE=stateful      legacy-only, sessionful NodeStreamableHTTPServerTransport (Mcp-Session-Id) for E14
// Env: PORT (7802), NAME ("demo"), MODE, TOKEN (if set, require "Authorization: Bearer <TOKEN>")
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer, createMcpHandler, isInitializeRequest } from '@modelcontextprotocol/server';
import { toNodeHandler, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

const PORT = Number(process.env.PORT ?? 7802);
const NAME = process.env.NAME ?? 'demo';
const MODE = process.env.MODE ?? 'dual';
const TOKEN = process.env.TOKEN;
const BOOT = new Date().toISOString();

function buildServer() {
  const s = new McpServer({ name: `${NAME}-upstream`, version: '0.0.1' });
  s.registerTool('echo', {
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
  }, async ({ text }) => ({ content: [{ type: 'text', text: `${NAME}:${text}` }] }));
  s.registerTool('slow', {
    description: 'Wait N seconds, then answer (tests long responses and timeouts).',
    inputSchema: z.object({ seconds: z.number().min(0).max(900) }),
  }, async ({ seconds }, ctx) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, seconds * 1000);
      ctx?.mcpReq?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
    return { content: [{ type: 'text', text: `${NAME}: waited ${seconds}s` }] };
  });
  s.registerTool('search', {
    description: 'A tool whose bare name collides across upstreams.',
    inputSchema: z.object({ query: z.string() }),
  }, async ({ query }) => ({ content: [{ type: 'text', text: `${NAME} results for ${query}` }] }));
  s.registerTool('fail', {
    description: 'Always returns an isError result.',
    inputSchema: z.object({}),
  }, async () => ({ isError: true, content: [{ type: 'text', text: `${NAME}: deliberate failure` }] }));
  s.registerTool('whoami', {
    description: 'Report pod identity and boot time.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ name: NAME, host: process.env.HOSTNAME, boot: BOOT, pid: process.pid }) }] }));
  return s;
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let handlerFn;
if (MODE === 'stateful') {
  const sessions = new Map();
  handlerFn = async (req, res) => {
    let body;
    if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    }
    const sid = req.headers['mcp-session-id'];
    const sess = sid ? sessions.get(sid) : undefined;
    if (sess) return sess.handleRequest(req, res, body);
    if (!sid && body && isInitializeRequest(body)) {
      const t = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => sessions.set(id, t),
      });
      t.onclose = () => t.sessionId && sessions.delete(t.sessionId);
      await buildServer().connect(t);
      return t.handleRequest(req, res, body);
    }
    if (sid) return send(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    return send(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
  };
} else {
  const handler = createMcpHandler(() => buildServer(), { keepAliveMs: 15_000 });
  handlerFn = toNodeHandler(handler);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') return send(res, 200, { ok: true, name: NAME, boot: BOOT });
  if (!req.url.startsWith('/mcp')) return send(res, 404, { error: 'not found' });
  if (!authorized(req)) return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
  try { await handlerFn(req, res); } catch (e) { console.error('upstream error', e); if (!res.headersSent) send(res, 500, { error: String(e) }); }
});
server.listen(PORT, () => console.error(`[upstream ${NAME}] mode=${MODE} listening :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.error(`[upstream ${NAME}] ${sig}`); server.close(); process.exit(0); });
