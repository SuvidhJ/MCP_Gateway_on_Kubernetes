import { describe, expect, it } from 'vitest';
import { MANAGED_LABEL, MANAGED_VALUE } from '@urumi/shared';
import { guardrails, hostedServer, mcpUrl, namespace, newStoreSecrets, storeBootstrapJob, storeDatabase, storeMcp, storeUrl, storeWeb, type Env, type Row } from './manifests.js';

const env: Env = {
  release: 'urumi', releaseNs: 'urumi', gatewaySa: 'gateway', provisionerSa: 'urumi-provisioner',
  readerRole: 'urumi-provisioner-ns-reader', endpointReaderRole: 'urumi-endpointslice-reader',
  images: { wordpress: 'w:1', mariadb: 'm:1', wooMcp: 'o:1' }, pullPolicy: 'IfNotPresent',
  baseDomain: '127.0.0.1.nip.io', publicPort: 8080, ingressClass: 'traefik',
  tls: { enabled: false, clusterIssuer: '', secretPrefix: 'urumi-tls' },
  ingress: { ns: 'kube-system', podLabels: { 'app.kubernetes.io/name': 'traefik' } }, dns: { ns: 'kube-system', podLabels: { 'k8s-app': 'kube-dns' } },
  store: { timezone: 'Asia/Kolkata', currency: 'INR', country: 'IN:KA', dbStorage: '1Gi', uploadsStorage: '1Gi' },
};
const store: Row = { id: 7, kind: 'store', slug: 'shop2', name: 'Shop Two', owner_id: 3, namespace: 'store-shop2', spec: {} };
const hosted: Row = { id: 8, kind: 'hosted', slug: 'echo2', name: 'Echo', owner_id: 1, namespace: 'mcp-echo2', spec: { image: 'x/y:1', port: 8080, path: '/mcp', env: { A: '1' }, egress: 'none' } };
const all = [...storeDatabase(env, store), ...storeWeb(env, store), ...storeMcp(env, store), storeBootstrapJob(env, store, 0), ...hostedServer(env, hosted, {})];
const podSpecs = all.filter((o) => o.kind === 'Deployment' || o.kind === 'Job').map((o: any) => o.spec.template.spec);

describe('namespaces', () => {
  it('are labelled as ours and enforce Pod Security "restricted"', () => {
    const ns = namespace(env, store);
    expect(ns.metadata.labels![MANAGED_LABEL]).toBe(MANAGED_VALUE);
    expect(ns.metadata.labels!['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(ns.metadata.labels!['urumi.ai/provision']).toBe('7');
  });
  it('get a quota, limit defaults, default-deny and read access only for the provisioner and the gateway', () => {
    const g = guardrails(env, store);
    expect(g.map((o) => o.kind)).toEqual(['ResourceQuota', 'LimitRange', 'NetworkPolicy', 'NetworkPolicy', 'RoleBinding', 'RoleBinding']);
    const deny: any = g.find((o) => o.metadata.name === 'default-deny');
    expect(deny.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    const rbs: any[] = g.filter((o) => o.kind === 'RoleBinding');
    expect(rbs.map((r) => r.roleRef.name).sort()).toEqual(['urumi-endpointslice-reader', 'urumi-provisioner-ns-reader']);
  });
});

describe('workloads', () => {
  it('every pod is non-root, read-only, no privilege escalation, no service account token, with probes and limits', () => {
    for (const p of podSpecs) {
      expect(p.securityContext.runAsNonRoot).toBe(true);
      expect(p.securityContext.seccompProfile.type).toBe('RuntimeDefault');
      expect(p.automountServiceAccountToken).toBe(false);
      for (const c of p.containers) {
        expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
        expect(c.resources.limits.cpu && c.resources.limits.memory && c.resources.requests.cpu).toBeTruthy();
      }
    }
    for (const d of all.filter((o) => o.kind === 'Deployment') as any[]) for (const c of d.spec.template.spec.containers) expect(c.readinessProbe && c.livenessProbe).toBeTruthy();
  });
  it("a store's MCP server is reachable only from the gateway and reaches only its own WordPress", () => {
    const np: any = storeMcp(env, store).find((o) => o.kind === 'NetworkPolicy' && o.metadata.name === 'woo-mcp');
    expect(np.spec.ingress[0].from).toEqual([{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'urumi' } }, podSelector: { matchLabels: { app: 'gateway' } } }]);
    expect(np.spec.egress).toEqual([{ to: [{ podSelector: { matchLabels: { app: 'wordpress' } } }], ports: [{ port: 8080, protocol: 'TCP' }] }]);
  });
  it('a hosted server with egress "none" can open no connection (DNS comes from the shared policy)', () => {
    const np: any = hostedServer(env, hosted, {}).find((o) => o.kind === 'NetworkPolicy');
    expect(np.spec.egress).toEqual([]);
    const pub: any = hostedServer(env, { ...hosted, spec: { ...hosted.spec, egress: 'internet' } }, {}).find((o) => o.kind === 'NetworkPolicy');
    expect(pub.spec.egress[0].to[0].ipBlock.except).toContain('169.254.0.0/16');
  });
  it('hosted secret env goes into a Secret, plain env into the pod spec', () => {
    const [secret, dep]: any[] = hostedServer(env, hosted, { API_KEY: 's3cret' });
    expect(secret.stringData).toEqual({ API_KEY: 's3cret' });
    const c = dep.spec.template.spec.containers[0];
    expect(JSON.stringify(c.env)).not.toContain('s3cret');
    expect(c.envFrom).toEqual([{ secretRef: { name: 'mcp-env' } }]);
  });
});

describe('names and URLs', () => {
  it('derive from the slug', () => {
    expect(storeUrl(env, 'shop2')).toBe('http://shop2.127.0.0.1.nip.io:8080');
    expect(storeUrl({ ...env, publicPort: 443, tls: { ...env.tls, enabled: true } }, 'shop2')).toBe('https://shop2.127.0.0.1.nip.io');
    expect(mcpUrl(store)).toBe('http://woo-mcp.store-shop2.svc.cluster.local/mcp');
    expect(mcpUrl(hosted)).toBe('http://mcp.mcp-echo2.svc.cluster.local/mcp');
  });
  it('TLS: a cert-manager certificate per store, or the ingress default certificate', () => {
    const ing = (tls: Env['tls']) => storeWeb({ ...env, tls }, store).find((o) => o.kind === 'Ingress') as any;
    expect(ing({ enabled: false, clusterIssuer: '', secretPrefix: 'x' }).spec.tls).toBeUndefined();
    expect(ing({ enabled: true, clusterIssuer: 'le', secretPrefix: 'urumi-tls' }).spec.tls).toEqual([{ hosts: ['shop2.127.0.0.1.nip.io'], secretName: 'urumi-tls-shop2' }]);
    expect(ing({ enabled: true, clusterIssuer: 'le', secretPrefix: 'urumi-tls' }).metadata.annotations['cert-manager.io/cluster-issuer']).toBe('le');
    expect(ing({ enabled: true, clusterIssuer: '', secretPrefix: 'urumi-tls' }).spec.tls).toEqual([{ hosts: ['shop2.127.0.0.1.nip.io'] }]);
    // default deny must still let the ingress reach cert-manager's HTTP-01 solver, only when cert-manager issues
    const solver = (tls: Env['tls']) => storeWeb({ ...env, tls }, store).find((o) => o.metadata.name === 'acme-http01-solver') as any;
    expect(solver({ enabled: true, clusterIssuer: '', secretPrefix: 'x' })).toBeUndefined();
    expect(solver({ enabled: true, clusterIssuer: 'le', secretPrefix: 'x' }).spec.ingress).toEqual([{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } } }], ports: [{ port: 8089, protocol: 'TCP' }] }]);
  });
  it('store secrets: 43-char WooCommerce keys, distinct random values', () => {
    const a = newStoreSecrets(), b = newStoreSecrets();
    expect(a.wcCk).toMatch(/^ck_[0-9a-f]{40}$/);
    expect(a.wcCs).toMatch(/^cs_[0-9a-f]{40}$/);
    expect(a.mcpToken).not.toBe(b.mcpToken);
    expect(Object.keys(a.salts)).toHaveLength(8);
  });
});
