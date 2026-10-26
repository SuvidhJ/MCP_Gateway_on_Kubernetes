// A small Kubernetes API client (in-cluster ServiceAccount token): server-side apply, create-if-absent, get, list,
// delete. Server-side apply makes every step idempotent, so a retried or resumed provisioning run converges.
import fs from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const API = process.env.KUBE_API ?? 'https://kubernetes.default.svc';
const FIELD_MANAGER = 'urumi-provisioner';

let agent: Agent | undefined;
const dispatcher = () => (agent ??= new Agent({ connect: { ca: fs.existsSync(`${SA}/ca.crt`) ? fs.readFileSync(`${SA}/ca.crt`) : undefined }, bodyTimeout: 30_000, headersTimeout: 30_000 }));
const token = () => process.env.KUBE_TOKEN ?? fs.readFileSync(`${SA}/token`, 'utf8'); // projected token rotates: re-read

export class KubeError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) { super(message); }
}

// kind -> [api prefix, plural, namespaced]
const KINDS: Record<string, [string, string, boolean]> = {
  Namespace: ['/api/v1', 'namespaces', false],
  Secret: ['/api/v1', 'secrets', true],
  Service: ['/api/v1', 'services', true],
  PersistentVolumeClaim: ['/api/v1', 'persistentvolumeclaims', true],
  Pod: ['/api/v1', 'pods', true],
  ResourceQuota: ['/api/v1', 'resourcequotas', true],
  LimitRange: ['/api/v1', 'limitranges', true],
  Deployment: ['/apis/apps/v1', 'deployments', true],
  Job: ['/apis/batch/v1', 'jobs', true],
  Ingress: ['/apis/networking.k8s.io/v1', 'ingresses', true],
  NetworkPolicy: ['/apis/networking.k8s.io/v1', 'networkpolicies', true],
  RoleBinding: ['/apis/rbac.authorization.k8s.io/v1', 'rolebindings', true],
};
export interface KObj { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; [k: string]: unknown }

export function pathOf(kind: string, ns: string | undefined, name?: string) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unsupported kind ${kind}`);
  const [prefix, plural, namespaced] = k;
  return `${prefix}${namespaced ? `/namespaces/${ns}` : ''}/${plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

async function call(method: string, path: string, body?: unknown, contentType = 'application/json') {
  const res = await undiciFetch(`${API}${path}`, {
    method, dispatcher: dispatcher(),
    headers: { authorization: `Bearer ${token()}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': contentType } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) throw new KubeError(res.status, json?.reason ?? 'Unknown', `${method} ${path}: HTTP ${res.status} ${json?.message ?? text.slice(0, 200)}`);
  return json;
}

export const kube = {
  /** Server-side apply: create or update to exactly these fields (we own them; force takes them over). */
  apply: (o: KObj) => call('PATCH', `${pathOf(o.kind, o.metadata.namespace, o.metadata.name)}?fieldManager=${FIELD_MANAGER}&force=true`, o, 'application/apply-patch+yaml'),
  /** Create; an existing object is left alone (Jobs: immutable once running). */
  async createIfAbsent(o: KObj) {
    try {
      return await call('POST', pathOf(o.kind, o.metadata.namespace), o);
    } catch (e) {
      if (e instanceof KubeError && e.status === 409) return undefined;
      throw e;
    }
  },
  async get(kind: string, ns: string | undefined, name: string) {
    try {
      return await call('GET', pathOf(kind, ns, name));
    } catch (e) {
      if (e instanceof KubeError && e.status === 404) return undefined;
      throw e;
    }
  },
  list: (kind: string, ns: string, labelSelector?: string) =>
    call('GET', `${pathOf(kind, ns)}${labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : ''}`).then((r) => r.items as any[]),
  async del(kind: string, ns: string | undefined, name: string, propagation = 'Background') {
    try {
      await call('DELETE', pathOf(kind, ns, name), { kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: propagation });
      return true;
    } catch (e) {
      if (e instanceof KubeError && e.status === 404) return false;
      throw e;
    }
  },
  log: (ns: string, pod: string, tail = 15) =>
    undiciFetch(`${API}/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?tailLines=${tail}`, { dispatcher: dispatcher(), headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.text() : '')).catch(() => ''),
};
