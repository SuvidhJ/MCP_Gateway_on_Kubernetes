// EndpointSlice watches for in-cluster upstreams (decision 13): a killed pod was flagged in ~0.2 s in experiment E17,
// while a 5 s health tick never saw it (the pod is back in ~2 s). Uses the pod's ServiceAccount token. One watch per
// namespace that holds an upstream: the release namespace (Role from the chart) and every store / hosted-server
// namespace (the provisioner binds the read-only `endpointslice-reader` ClusterRole there for this ServiceAccount).
import fs from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { log } from './log.js';
import type { UpstreamManager } from './upstreams.js';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** The Service (and its namespace) an upstream URL points at: "svc" (in `home`) or "svc.ns.svc[.cluster.local]".
 *  ("svc.ns" is left out: it is indistinguishable from an internet name like example.com.) */
export function serviceOf(url: string, home: string): { ns: string; svc: string } | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  const parts = host.split('.');
  if (parts.length === 1) return { ns: home, svc: parts[0] };
  if (parts[2] === 'svc' && (parts.length === 3 || parts.slice(3).join('.') === 'cluster.local')) return { ns: parts[1], svc: parts[0] };
  return undefined;
}

export function startEndpointWatch(mgr: UpstreamManager, home: string) {
  if (!home || !fs.existsSync(`${SA}/token`)) return;
  const agent = new Agent({ connect: { ca: fs.readFileSync(`${SA}/ca.crt`) }, bodyTimeout: 0 });
  const watches = new Map<string, { stop: boolean; slices: Map<string, any> }>();

  const readyFor = (slices: Map<string, any>, svc: string) => [...slices.values()]
    .filter((s) => s.metadata?.labels?.['kubernetes.io/service-name'] === svc)
    .reduce((n, s) => n + (s.endpoints ?? []).filter((e: any) => e.conditions?.ready).length, 0);
  const apply = (ns: string, slices: Map<string, any>, svc: string) => {
    for (const u of mgr.ups.values()) {
      const t = serviceOf(u.url, home);
      if (t && t.ns === ns && t.svc === svc) mgr.endpointsChanged(u, readyFor(slices, svc), ns, svc);
    }
  };

  const watch = (ns: string) => {
    const w = { stop: false, slices: new Map<string, any>() };
    watches.set(ns, w);
    (async () => {
      let backoff = 1000;
      while (!w.stop) {
        try {
          const token = fs.readFileSync(`${SA}/token`, 'utf8'); // projected token rotates: re-read per watch
          const res = await undiciFetch(`https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices?watch=true`,
            { dispatcher: agent, headers: { authorization: `Bearer ${token}` } });
          if (!res.ok || !res.body) {
            // 403 right after a store is created: the provisioner hasn't bound read access yet
            log[res.status === 403 && ns !== home ? 'debug' : 'warn']({ ns, status: res.status, body: (await res.text()).slice(0, 160) }, 'endpointslice watch refused');
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(backoff * 2, 30_000);
            continue;
          }
          backoff = 1000;
          log.info({ ns }, 'endpointslice watch open');
          w.slices.clear();
          let buf = '';
          for await (const chunk of res.body) {
            if (w.stop) break;
            buf += Buffer.from(chunk).toString();
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (!line.trim()) continue;
              const { type, object } = JSON.parse(line);
              if (type === 'ERROR') continue;
              if (type === 'DELETED') w.slices.delete(object.metadata.name);
              else w.slices.set(object.metadata.name, object);
              const svc = object.metadata?.labels?.['kubernetes.io/service-name'];
              if (svc) apply(ns, w.slices, svc);
            }
          }
        } catch (e) {
          log.warn({ ns, err: (e as Error).message }, 'endpointslice watch error');
        }
        if (!w.stop) await new Promise((r) => setTimeout(r, 1000));
      }
    })();
  };

  // keep one watch per namespace that currently holds an in-cluster upstream
  const sync = () => {
    const want = new Set<string>([home]);
    for (const u of mgr.ups.values()) { const t = serviceOf(u.url, home); if (t) want.add(t.ns); }
    for (const ns of want) if (!watches.has(ns)) watch(ns);
    for (const [ns, w] of watches) if (!want.has(ns)) { w.stop = true; watches.delete(ns); }
  };
  sync();
  setInterval(sync, 3000).unref();
}
