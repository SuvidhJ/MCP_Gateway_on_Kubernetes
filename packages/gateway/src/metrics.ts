// Prometheus metrics for this replica (served on a separate port, not through the Ingress):
//   urumi_tool_calls_total{server,outcome}, urumi_tool_call_duration_seconds{server} (histogram),
//   urumi_upstream_up{server,status}
import http from 'node:http';
import type { UpstreamManager } from './upstreams.js';

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const calls = new Map<string, number>(); // `${server}\t${outcome}` -> count
const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();

export function recordCall(server: string | null, outcome: string, ms: number) {
  const s = server ?? 'none';
  const k = `${s}\t${outcome}`;
  calls.set(k, (calls.get(k) ?? 0) + 1);
  const h = hist.get(s) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => { if (ms / 1000 <= b) h.buckets[i]++; });
  h.sum += ms / 1000;
  h.count++;
  hist.set(s, h);
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function render(mgr: UpstreamManager) {
  const out: string[] = [];
  out.push('# HELP urumi_tool_calls_total Tool calls through the gateway by server and outcome.', '# TYPE urumi_tool_calls_total counter');
  for (const [k, v] of calls) {
    const [s, o] = k.split('\t');
    out.push(`urumi_tool_calls_total{server="${esc(s)}",outcome="${esc(o)}"} ${v}`);
  }
  out.push('# HELP urumi_tool_call_duration_seconds Tool call latency by server.', '# TYPE urumi_tool_call_duration_seconds histogram');
  for (const [s, h] of hist) {
    BUCKETS.forEach((b, i) => out.push(`urumi_tool_call_duration_seconds_bucket{server="${esc(s)}",le="${b}"} ${h.buckets[i]}`));
    out.push(`urumi_tool_call_duration_seconds_bucket{server="${esc(s)}",le="+Inf"} ${h.count}`);
    out.push(`urumi_tool_call_duration_seconds_sum{server="${esc(s)}"} ${h.sum}`, `urumi_tool_call_duration_seconds_count{server="${esc(s)}"} ${h.count}`);
  }
  out.push('# HELP urumi_upstream_up 1 if the upstream is connected.', '# TYPE urumi_upstream_up gauge');
  for (const u of mgr.ups.values()) out.push(`urumi_upstream_up{server="${esc(u.slug)}",status="${u.status}"} ${u.status === 'connected' ? 1 : 0}`);
  return out.join('\n') + '\n';
}

export function startMetricsServer(mgr: UpstreamManager, port: number) {
  if (!port) return;
  http.createServer((req, res) => {
    if (req.url !== '/metrics') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(render(mgr));
  }).listen(port, '0.0.0.0');
}
