// The provisioner: turns `provisions` rows (written by the gateway API) into Kubernetes resources and registers
// their MCP servers in the gateway. One active leader at a time (a Postgres advisory lock held on its own
// connection), woken by LISTEN urumi_provision and by a periodic tick. No ingress at all; egress to Postgres and the
// Kubernetes API only (NetworkPolicy). Its Kubernetes access is write-only outside the namespaces it owns, and a
// ValidatingAdmissionPolicy confines those writes to store-*/mcp-* namespaces it labelled (chart: provisioner.yaml).
import http from 'node:http';
import pg from 'pg';
import { Reconciler } from './reconcile.js';
import type { Env } from './manifests.js';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const json = <T>(k: string, d: T): T => (process.env[k] ? JSON.parse(process.env[k]!) : d);
const env: Env = {
  release: need('RELEASE'), releaseNs: need('RELEASE_NAMESPACE'), gatewaySa: need('GATEWAY_SA'), provisionerSa: need('PROVISIONER_SA'),
  readerRole: need('READER_CLUSTERROLE'), endpointReaderRole: need('ENDPOINT_READER_CLUSTERROLE'),
  images: { wordpress: need('WORDPRESS_IMAGE'), mariadb: need('MARIADB_IMAGE'), wooMcp: need('WOO_MCP_IMAGE') },
  pullPolicy: process.env.PULL_POLICY ?? 'IfNotPresent',
  baseDomain: need('BASE_DOMAIN'), publicPort: Number(process.env.PUBLIC_PORT ?? 80), ingressClass: process.env.INGRESS_CLASS ?? 'traefik',
  tls: { enabled: process.env.TLS_ENABLED === '1', clusterIssuer: process.env.TLS_CLUSTER_ISSUER ?? '', secretPrefix: process.env.TLS_SECRET_PREFIX ?? 'urumi-tls' },
  ingress: { ns: process.env.INGRESS_NAMESPACE ?? 'kube-system', podLabels: json('INGRESS_POD_LABELS', { 'app.kubernetes.io/name': 'traefik' }) },
  dns: { ns: process.env.DNS_NAMESPACE ?? 'kube-system', podLabels: json('DNS_POD_LABELS', { 'k8s-app': 'kube-dns' }) },
  store: { timezone: process.env.STORE_TIMEZONE ?? 'UTC', currency: process.env.STORE_CURRENCY ?? 'USD', country: process.env.STORE_COUNTRY ?? 'US',
    dbStorage: process.env.STORE_DB_STORAGE ?? '1Gi', uploadsStorage: process.env.STORE_UPLOADS_STORAGE ?? '1Gi' },
};
const log = (o: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ time: new Date().toISOString(), svc: 'provisioner', ...o, msg }));

const db = new pg.Pool({ connectionString: need('DATABASE_URL'), max: 8 });
db.on('error', (e) => log({ err: e.message }, 'pg pool error'));
const reconciler = new Reconciler(db, env, need('CREDENTIAL_KEY'));
const TICK_MS = Number(process.env.TICK_MS ?? 3000);
const LOCK = 727277;

let leader: pg.Client | undefined;
let lastTick = 0;
let ticking = false;
async function tick() {
  if (!leader || ticking) return;
  ticking = true;
  try {
    await reconciler.tick();
    lastTick = Date.now();
  } catch (e) {
    log({ err: (e as Error).message }, 'tick failed');
  } finally {
    ticking = false;
  }
}

/** Become leader: the advisory lock is held as long as this connection lives; LISTEN on the same connection. */
async function lead() {
  for (;;) {
    const c = new pg.Client({ connectionString: need('DATABASE_URL') });
    try {
      await c.connect();
      // the schema is the gateway's: wait until its provisioning migration ran
      for (;;) {
        const { rows } = await c.query(`select to_regclass('public.provisions') is not null as ok`);
        if (rows[0].ok) break;
        log({}, 'waiting for the gateway to create the schema');
        await new Promise((r) => setTimeout(r, 3000));
      }
      for (;;) {
        const { rows } = await c.query('select pg_try_advisory_lock($1) as got', [LOCK]);
        if (rows[0].got) break;
        await new Promise((r) => setTimeout(r, 3000)); // another replica leads (during a rollout): stand by
      }
      await c.query('listen urumi_provision');
      c.on('notification', () => void tick());
      leader = c;
      log({}, 'leader: reconciling');
      void tick();
      await new Promise<void>((resolve) => { c.on('end', resolve); c.on('error', () => resolve()); });
    } catch (e) {
      log({ err: (e as Error).message }, 'leader connection failed');
    }
    leader = undefined;
    c.end().catch(() => {});
    log({}, 'lost leadership; retrying');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

void lead();
setInterval(() => void tick(), TICK_MS).unref();

// liveness: the process and (when leading) its loop are alive; a stuck loop gets the pod restarted
const port = Number(process.env.PORT ?? 8080);
http.createServer((req, res) => {
  const stuck = leader && lastTick && Date.now() - lastTick > 10 * 60_000;
  res.writeHead(req.url === '/healthz' && !stuck ? 200 : req.url === '/healthz' ? 503 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: !stuck, leader: !!leader, lastTick: lastTick ? new Date(lastTick).toISOString() : null }));
}).listen(port, '0.0.0.0', () => log({ port }, 'provisioner listening'));

process.on('SIGTERM', () => {
  log({}, 'shutting down');
  // in-flight steps are idempotent: the next leader re-applies them
  leader?.end().catch(() => {});
  db.end().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
