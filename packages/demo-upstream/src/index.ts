// A small MCP server we own, deployed in-cluster: the upstream we kill for the dead-upstream demo, and a `slow_task`
// tool for the timeout demo. Streamable HTTP at /mcp, health at /healthz. Env: PORT (8080), NAME (demo).
import http from 'node:http';
import * as z from 'zod/v4';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const port = Number(process.env.PORT ?? 8080);
const name = process.env.NAME ?? 'demo';
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

export function buildServer(): McpServer {
  const s = new McpServer({ name: `demo-upstream-${name}`, version: '0.1.0' });
  s.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Return the message unchanged (connectivity check).',
      inputSchema: z.object({ message: z.string().max(1000) }),
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => text({ message, served_by: process.env.HOSTNAME ?? 'local' }),
  );
  s.registerTool(
    'current_time',
    {
      title: 'Current time',
      description: 'Current date and time in an IANA timezone (default UTC).',
      inputSchema: z.object({ timezone: z.string().max(64).default('UTC') }),
      annotations: { readOnlyHint: true },
    },
    async ({ timezone }) => {
      try {
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date());
        return text({ timezone, local, utc: new Date().toISOString() });
      } catch {
        return { isError: true, content: [{ type: 'text' as const, text: `unknown timezone "${timezone}"` }] };
      }
    },
  );
  s.registerTool(
    'slow_task',
    {
      title: 'Slow task',
      description: 'Wait for the given number of seconds, then return. Used to demonstrate gateway timeouts.',
      inputSchema: z.object({ seconds: z.number().min(0).max(120) }),
      annotations: { readOnlyHint: true },
    },
    async ({ seconds }) => {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return text({ waited_seconds: seconds });
    },
  );
  return s;
}

const handler = toNodeHandler(createMcpHandler(() => buildServer(), { keepAliveMs: 15_000 }));
const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/mcp') return void handler(req, res);
  res.writeHead(404).end();
});
server.listen(port, () => console.error(`[demo-upstream ${name}] :${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
