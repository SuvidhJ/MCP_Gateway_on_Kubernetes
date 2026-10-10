// EndpointSlice watch for in-cluster upstreams (decision 13): a killed pod was flagged in ~0.2 s in experiment E17,
// while a 5 s health tick never saw it (the pod is back in ~2 s). Uses the pod's ServiceAccount token and needs a
// Role with get/list/watch on discovery.k8s.io endpointslices in the namespace.
import fs from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { log } from './log.js';
import type { UpstreamManager } from './upstreams.js';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Map an upstream URL host to a Service in `ns`: "svc", "svc.ns", "svc.ns.svc", "svc.ns.svc.cluster.local". */
function serviceOf(url: string, ns: string) {
  const host = new URL(url).hostname.toLowerCase();
  const parts = host.split('.');
  if (parts.length === 1) return parts[0];
  if (parts[1] === ns && (parts.length === 2 || parts[2] === 'svc')) return parts[0];
  return undefined;
}

export function startEndpointWatch(mgr: UpstreamManager, ns: string) {
  if (!ns || !fs.existsSync(`${SA}/token`)) return;
  const agent = new Agent({ connect: { ca: fs.readFileSync(`${SA}/ca.crt`) }, bodyTimeout: 0 });
  const slices = new Map<string, any>(); // slice name -> object
  const readyFor = (svc: string) => [...slices.values()]
    .filter((s) => s.metadata?.labels?.['kubernetes.io/service-name'] === svc)
    .reduce((n, s) => n + (s.endpoints ?? []).filter((e: any) => e.conditions?.ready).length, 0);
  const apply = (svc: string) => {
    for (const u of mgr.ups.values()) if (serviceOf(u.url, ns) === svc) mgr.endpointsChanged(u, readyFor(svc), ns, svc);
  };
  (async () => {
    for (;;) {
      try {
        const token = fs.readFileSync(`${SA}/token`, 'utf8'); // projected token rotates: re-read per watch
        const res = await undiciFetch(`https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices?watch=true`,
          { dispatcher: agent, headers: { authorization: `Bearer ${token}` } });
        if (!res.ok || !res.body) {
          log.warn({ status: res.status, body: (await res.text()).slice(0, 160) }, 'endpointslice watch refused');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        log.info({ ns }, 'endpointslice watch open');
        slices.clear();
        let buf = '';
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const { type, object } = JSON.parse(line);
            if (type === 'ERROR') continue;
            if (type === 'DELETED') slices.delete(object.metadata.name);
            else slices.set(object.metadata.name, object);
            const svc = object.metadata?.labels?.['kubernetes.io/service-name'];
            if (svc) apply(svc);
          }
        }
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'endpointslice watch error');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
}
