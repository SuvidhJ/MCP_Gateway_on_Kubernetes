// Everything one provisioned namespace contains, as plain objects (pure: unit-tested). Mirrors the chart's own
// store and servers: non-root, read-only root filesystems, probes and limits everywhere, default-deny
// NetworkPolicies in both directions, Pod Security "restricted", a ResourceQuota and a LimitRange.
import crypto from 'node:crypto';
import { MANAGED_LABEL, MANAGED_VALUE } from '@urumi/shared';
import type { KObj } from './kube.js';

export interface Env {
  release: string; releaseNs: string; gatewaySa: string; provisionerSa: string;
  readerRole: string; endpointReaderRole: string;            // ClusterRoles bound inside each managed namespace
  images: { wordpress: string; mariadb: string; wooMcp: string }; pullPolicy: string;
  baseDomain: string; publicPort: number; ingressClass: string;
  tls: { enabled: boolean; clusterIssuer: string; secretPrefix: string };
  ingress: { ns: string; podLabels: Record<string, string> }; dns: { ns: string; podLabels: Record<string, string> };
  store: { timezone: string; currency: string; country: string; dbStorage: string; uploadsStorage: string };
}
export interface Row { id: number; kind: 'store' | 'hosted'; slug: string; name: string; owner_id: number | null; namespace: string; spec: any }

const SALTS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
const rand = (n: number) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);
export interface StoreSecrets { dbPassword: string; dbRoot: string; adminPassword: string; wcCk: string; wcCs: string; mcpToken: string; salts: Record<string, string> }
/** Generated once per store and kept sealed in Postgres, so a retry or a provisioner restart reuses them. */
export function newStoreSecrets(): StoreSecrets {
  const hex = () => crypto.randomBytes(20).toString('hex'); // WooCommerce keys: ck_/cs_ + 40 hex = 43 chars
  return { dbPassword: rand(32), dbRoot: rand(32), adminPassword: rand(24), wcCk: `ck_${hex()}`, wcCs: `cs_${hex()}`, mcpToken: rand(40),
    salts: Object.fromEntries(SALTS.map((k) => [k, rand(64)])) };
}

export const storeHost = (e: Env, slug: string) => `${slug}.${e.baseDomain}`;
export const storeUrl = (e: Env, slug: string) =>
  `${e.tls.enabled ? 'https' : 'http'}://${storeHost(e, slug)}${[80, 443].includes(e.publicPort) ? '' : `:${e.publicPort}`}`;
/** The URL the gateway uses for a provisioned MCP server (in-cluster). */
export const mcpUrl = (r: Row) => (r.kind === 'store'
  ? `http://woo-mcp.${r.namespace}.svc.cluster.local/mcp`
  : `http://mcp.${r.namespace}.svc.cluster.local${r.spec.path ?? '/mcp'}`);

const meta = (r: Row, name: string, extra: Record<string, string> = {}) => ({
  name, namespace: r.namespace, labels: { 'app.kubernetes.io/managed-by': MANAGED_VALUE, 'urumi.ai/provision': String(r.id), ...extra },
});
const restrictedPod = (uid: number) => ({ runAsNonRoot: true, runAsUser: uid, runAsGroup: uid, fsGroup: uid, seccompProfile: { type: 'RuntimeDefault' } });
const restrictedCtr = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
const env = (name: string, value: string) => ({ name, value });
const fromSecret = (name: string, secret: string, key: string) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } });
const svc = (r: Row, name: string, app: string, port: number, target: string): KObj => ({
  apiVersion: 'v1', kind: 'Service', metadata: meta(r, name), spec: { selector: { app }, ports: [{ name: 'http', port, targetPort: target }] },
});
const pvc = (r: Row, name: string, size: string): KObj => ({
  apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(r, name), spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } } },
});
const netpol = (r: Row, name: string, spec: Record<string, unknown>): KObj => ({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(r, name), spec });
const fromGateway = (e: Env) => ({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': e.releaseNs } }, podSelector: { matchLabels: { app: 'gateway' } } });
const fromIngress = (e: Env) => ({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': e.ingress.ns } }, podSelector: { matchLabels: e.ingress.podLabels } });

export function namespace(e: Env, r: Row): KObj {
  return {
    apiVersion: 'v1', kind: 'Namespace',
    metadata: {
      name: r.namespace,
      labels: {
        [MANAGED_LABEL]: MANAGED_VALUE, 'urumi.ai/release-namespace': e.releaseNs, 'urumi.ai/kind': r.kind,
        'urumi.ai/slug': r.slug, 'urumi.ai/provision': String(r.id), ...(r.owner_id ? { 'urumi.ai/owner': String(r.owner_id) } : {}),
        // the API server itself refuses privileged pods here, whatever an image asks for
        'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest',
      },
    },
  };
}

/** Quota, defaults, default-deny + DNS, and read access for the provisioner (status) and the gateway (EndpointSlices). */
export function guardrails(e: Env, r: Row): KObj[] {
  const store = r.kind === 'store';
  return [
    { apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta(r, 'quota'), spec: { hard: store
      // sums of the containers' limits plus room for a rolling update's surge pod
      ? { 'requests.cpu': '1', 'requests.memory': '1536Mi', 'limits.cpu': '4', 'limits.memory': '3Gi', pods: '8', persistentvolumeclaims: '3', 'requests.storage': '8Gi', services: '5', 'services.loadbalancers': '0', 'services.nodeports': '0', secrets: '8', configmaps: '8' }
      : { 'requests.cpu': '500m', 'requests.memory': '512Mi', 'limits.cpu': '1', 'limits.memory': '1Gi', pods: '4', persistentvolumeclaims: '0', services: '2', 'services.loadbalancers': '0', 'services.nodeports': '0', secrets: '4', configmaps: '4' } } },
    { apiVersion: 'v1', kind: 'LimitRange', metadata: meta(r, 'limits'), spec: { limits: [
      { type: 'Container', default: { cpu: '500m', memory: '512Mi' }, defaultRequest: { cpu: '50m', memory: '64Mi' }, max: { cpu: '1', memory: '1Gi' } },
      ...(store ? [{ type: 'PersistentVolumeClaim', max: { storage: '4Gi' } }] : []),
    ] } },
    netpol(r, 'default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
    netpol(r, 'dns-egress', { podSelector: {}, policyTypes: ['Egress'], egress: [{
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': e.dns.ns } }, podSelector: { matchLabels: e.dns.podLabels } }],
      ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] }] }),
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta(r, 'urumi-provisioner-read'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: e.readerRole },
      subjects: [{ kind: 'ServiceAccount', name: e.provisionerSa, namespace: e.releaseNs }] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta(r, 'urumi-gateway-endpointslices'),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: e.endpointReaderRole },
      subjects: [{ kind: 'ServiceAccount', name: e.gatewaySa, namespace: e.releaseNs }] },
  ];
}

// ---------------------------------------------------------------- stores
export function storeSecrets(r: Row, s: StoreSecrets): KObj[] {
  return [
    { apiVersion: 'v1', kind: 'Secret', metadata: meta(r, 'store-db'), type: 'Opaque', stringData: { database: 'wordpress', user: 'wp', password: s.dbPassword, root: s.dbRoot } },
    { apiVersion: 'v1', kind: 'Secret', metadata: meta(r, 'store-app'), type: 'Opaque',
      stringData: { 'admin-password': s.adminPassword, 'wc-ck': s.wcCk, 'wc-cs': s.wcCs, 'mcp-token': s.mcpToken, ...s.salts } },
  ];
}

function wpEnv(e: Env, r: Row) {
  const url = storeUrl(e, r.slug);
  return [
    env('WORDPRESS_DB_HOST', 'mariadb:3306'),
    fromSecret('WORDPRESS_DB_NAME', 'store-db', 'database'), fromSecret('WORDPRESS_DB_USER', 'store-db', 'user'), fromSecret('WORDPRESS_DB_PASSWORD', 'store-db', 'password'),
    ...SALTS.map((k) => fromSecret(`WORDPRESS_${k}`, 'store-app', k)),
    env('WORDPRESS_CONFIG_EXTRA', `define('WP_HOME', '${url}');\ndefine('WP_SITEURL', '${url}');\ndefine('DISALLOW_FILE_MODS', true);\ndefine('WP_MEMORY_LIMIT', '256M');\ndefine('WP_ENVIRONMENT_TYPE', 'production');\n`),
  ];
}

export function storeDatabase(e: Env, r: Row): KObj[] {
  return [
    pvc(r, 'mariadb', e.store.dbStorage),
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(r, 'mariadb'), spec: {
      strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'mariadb' } },
      template: { metadata: { labels: { app: 'mariadb' } }, spec: {
        securityContext: restrictedPod(999), automountServiceAccountToken: false,
        containers: [{ name: 'mariadb', image: e.images.mariadb, imagePullPolicy: e.pullPolicy,
          env: [fromSecret('MARIADB_ROOT_PASSWORD', 'store-db', 'root'), fromSecret('MARIADB_DATABASE', 'store-db', 'database'),
            fromSecret('MARIADB_USER', 'store-db', 'user'), fromSecret('MARIADB_PASSWORD', 'store-db', 'password')],
          ports: [{ containerPort: 3306, name: 'mysql' }],
          readinessProbe: { exec: { command: ['healthcheck.sh', '--connect', '--innodb_initialized'] }, periodSeconds: 5 },
          livenessProbe: { exec: { command: ['healthcheck.sh', '--connect'] }, periodSeconds: 20, initialDelaySeconds: 30 },
          resources: { requests: { cpu: '50m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
          securityContext: restrictedCtr,
          volumeMounts: [{ name: 'data', mountPath: '/var/lib/mysql' }, { name: 'run', mountPath: '/run/mysqld' }, { name: 'tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'mariadb' } }, { name: 'run', emptyDir: { sizeLimit: '16Mi' } }, { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }],
      } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: meta(r, 'mariadb'), spec: { selector: { app: 'mariadb' }, ports: [{ name: 'mysql', port: 3306, targetPort: 'mysql' }] } },
    netpol(r, 'mariadb', { podSelector: { matchLabels: { app: 'mariadb' } }, policyTypes: ['Ingress'],
      ingress: [{ from: [{ podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['wordpress', 'store-bootstrap'] }] } }], ports: [{ port: 3306, protocol: 'TCP' }] }] }),
  ];
}

export function storeWeb(e: Env, r: Row): KObj[] {
  const host = storeHost(e, r.slug);
  return [
    pvc(r, 'wordpress-uploads', e.store.uploadsStorage),
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(r, 'wordpress'), spec: {
      strategy: { type: 'Recreate' }, selector: { matchLabels: { app: 'wordpress' } },
      template: { metadata: { labels: { app: 'wordpress' } }, spec: {
        securityContext: restrictedPod(33), automountServiceAccountToken: false,
        containers: [{ name: 'wordpress', image: e.images.wordpress, imagePullPolicy: e.pullPolicy, env: wpEnv(e, r),
          ports: [{ containerPort: 8080, name: 'http' }],
          readinessProbe: { httpGet: { path: '/wp-login.php', port: 'http' }, periodSeconds: 10, timeoutSeconds: 5 },
          livenessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 20, initialDelaySeconds: 30 },
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '768Mi' } },
          securityContext: restrictedCtr,
          volumeMounts: [{ name: 'uploads', mountPath: '/usr/src/wordpress/wp-content/uploads' }, { name: 'run', mountPath: '/var/run/apache2' },
            { name: 'lock', mountPath: '/var/lock/apache2' }, { name: 'tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'uploads', persistentVolumeClaim: { claimName: 'wordpress-uploads' } }, { name: 'run', emptyDir: { sizeLimit: '16Mi' } },
          { name: 'lock', emptyDir: { sizeLimit: '16Mi' } }, { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } }],
      } } } },
    svc(r, 'wordpress', 'wordpress', 80, 'http'),
    { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
      metadata: { ...meta(r, 'wordpress'), ...(e.tls.enabled && e.tls.clusterIssuer ? { annotations: { 'cert-manager.io/cluster-issuer': e.tls.clusterIssuer } } : {}) },
      spec: { ingressClassName: e.ingressClass,
        // cert-manager issues one certificate per store; without it the host is listed without a secret, so Traefik
        // serves its default certificate (set a wildcard as Traefik's default TLSStore): a Secret in the release
        // namespace can't be used from the store's namespace
        ...(e.tls.enabled ? { tls: [e.tls.clusterIssuer ? { hosts: [host], secretName: `${e.tls.secretPrefix}-${r.slug}` } : { hosts: [host] }] } : {}),
        rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'wordpress', port: { number: 80 } } } }] } }] } },
    netpol(r, 'wordpress', { podSelector: { matchLabels: { app: 'wordpress' } }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [fromIngress(e), { podSelector: { matchLabels: { app: 'woo-mcp' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'mariadb' } } }], ports: [{ port: 3306, protocol: 'TCP' }] }] }),
    // cert-manager's HTTP-01 solver pod for this store's certificate runs here; Let's Encrypt reaches it via the ingress
    ...(e.tls.enabled && e.tls.clusterIssuer ? [netpol(r, 'acme-http01-solver', { podSelector: { matchLabels: { 'acme.cert-manager.io/http01-solver': 'true' } },
      policyTypes: ['Ingress'], ingress: [{ from: [fromIngress(e)], ports: [{ port: 8089, protocol: 'TCP' }] }] })] : []),
  ];
}

export function storeBootstrapJob(e: Env, r: Row, attempt: number): KObj {
  return {
    apiVersion: 'batch/v1', kind: 'Job', metadata: meta(r, `store-bootstrap-${attempt}`), spec: {
      backoffLimit: 6, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600,
      template: { metadata: { labels: { app: 'store-bootstrap' } }, spec: {
        restartPolicy: 'OnFailure', securityContext: restrictedPod(33), automountServiceAccountToken: false,
        containers: [{ name: 'bootstrap', image: e.images.wordpress, imagePullPolicy: e.pullPolicy, command: ['/usr/local/bin/urumi-bootstrap'],
          env: [...wpEnv(e, r), env('STORE_URL', storeUrl(e, r.slug)), env('STORE_TITLE', r.name), env('STORE_ADMIN_USER', 'admin'),
            env('STORE_ADMIN_EMAIL', 'admin@store.invalid'), fromSecret('STORE_ADMIN_PASSWORD', 'store-app', 'admin-password'),
            env('STORE_TIMEZONE', e.store.timezone), env('STORE_CURRENCY', e.store.currency), env('STORE_COUNTRY', e.store.country),
            env('MCP_WC_USER', 'mcp-agent'), fromSecret('MCP_WC_CK', 'store-app', 'wc-ck'), fromSecret('MCP_WC_CS', 'store-app', 'wc-cs'),
            env('WP_CLI_CACHE_DIR', '/tmp/wp-cli-cache'), env('HOME', '/tmp')],
          resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
          securityContext: restrictedCtr, volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
      } } },
  };
}

export function storeMcp(e: Env, r: Row): KObj[] {
  return [
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(r, 'woo-mcp'), spec: {
      selector: { matchLabels: { app: 'woo-mcp' } },
      template: { metadata: { labels: { app: 'woo-mcp', 'urumi.ai/role': 'mcp' } }, spec: {
        securityContext: restrictedPod(1000), automountServiceAccountToken: false,
        containers: [{ name: 'woo-mcp', image: e.images.wooMcp, imagePullPolicy: e.pullPolicy,
          env: [env('PORT', '8080'), env('WC_URL', 'http://wordpress'), env('STORE', r.name), env('STORE_CURRENCY', e.store.currency),
            env('STORE_TIMEZONE', e.store.timezone), env('PUBLIC_STORE_URL', storeUrl(e, r.slug)),
            fromSecret('WC_CK', 'store-app', 'wc-ck'), fromSecret('WC_CS', 'store-app', 'wc-cs'), fromSecret('MCP_TOKEN', 'store-app', 'mcp-token')],
          ports: [{ containerPort: 8080, name: 'http' }],
          readinessProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 5 },
          livenessProbe: { httpGet: { path: '/healthz', port: 'http' }, periodSeconds: 20 },
          resources: { requests: { cpu: '20m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
          securityContext: restrictedCtr }],
      } } } },
    svc(r, 'woo-mcp', 'woo-mcp', 80, 'http'),
    // only the gateway may call this store's MCP server; it may only reach this store's WordPress
    netpol(r, 'woo-mcp', { podSelector: { matchLabels: { app: 'woo-mcp' } }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [fromGateway(e)], ports: [{ port: 8080, protocol: 'TCP' }] }],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'wordpress' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }] }),
    netpol(r, 'store-bootstrap', { podSelector: { matchLabels: { app: 'store-bootstrap' } }, policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'mariadb' } } }], ports: [{ port: 3306, protocol: 'TCP' }] }] }),
  ];
}

// ---------------------------------------------------------------- hosted MCP servers
export function hostedServer(e: Env, r: Row, secretEnv: Record<string, string>): KObj[] {
  const s = r.spec as { image: string; port: number; path: string; env: Record<string, string>; egress: 'none' | 'internet' };
  const out: KObj[] = [
    { apiVersion: 'v1', kind: 'Secret', metadata: meta(r, 'mcp-env'), type: 'Opaque', stringData: secretEnv },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(r, 'mcp'), spec: {
      selector: { matchLabels: { app: 'mcp' } },
      template: { metadata: { labels: { app: 'mcp', 'urumi.ai/role': 'mcp' } }, spec: {
        // an arbitrary image runs as an unprivileged user with nothing writable but /tmp; no API token
        securityContext: restrictedPod(10001), automountServiceAccountToken: false, enableServiceLinks: false,
        containers: [{ name: 'mcp', image: s.image, imagePullPolicy: e.pullPolicy,
          env: [...Object.entries(s.env ?? {}).map(([k, v]) => env(k, v)), ...(s.env?.PORT ? [] : [env('PORT', String(s.port))])],
          envFrom: [{ secretRef: { name: 'mcp-env' } }],
          ports: [{ containerPort: s.port, name: 'http' }],
          readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 5 },
          livenessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 20, initialDelaySeconds: 20 },
          resources: { requests: { cpu: '20m', memory: '64Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
          securityContext: restrictedCtr, volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }] }],
        volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }],
      } } } },
    svc(r, 'mcp', 'mcp', 80, 'http'),
    netpol(r, 'mcp', { podSelector: { matchLabels: { app: 'mcp' } }, policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [fromGateway(e)], ports: [{ port: s.port, protocol: 'TCP' }] }],
      // `none`: DNS only. `internet`: public addresses (it may call its own SaaS API), never the cluster or metadata
      egress: s.egress === 'internet'
        ? [{ to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'] } }] }]
        : [] }),
  ];
  return out;
}
