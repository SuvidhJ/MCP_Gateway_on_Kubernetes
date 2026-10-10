// All gateway settings come from the environment (the Helm chart sets them).
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const num = (k: string, d: number) => Number(process.env[k] ?? d);

export const config = {
  port: num('PORT', 8080),
  databaseUrl: env('DATABASE_URL', 'postgres://urumi:urumi@127.0.0.1:5432/urumi'),
  // Public origin of the gateway (Host/Origin guard, mcpUrl shown in the dashboard).
  publicUrl: env('PUBLIC_URL', 'http://gateway.127.0.0.1.nip.io:8080'),
  // Extra Host header values accepted on /mcp (in-cluster callers use the Service name).
  allowedHosts: env('ALLOWED_HOSTS', 'gateway,gateway.urumi,gateway.urumi.svc,gateway.urumi.svc.cluster.local,127.0.0.1,localhost')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  keyPepper: env('KEY_PEPPER', 'dev-pepper-change-me'),
  credentialKey: env('CREDENTIAL_KEY', 'dev-credential-key-change-me'),
  jwtSecret: env('JWT_SECRET', 'dev-jwt-secret-change-me-dev-jwt-secret'),
  adminEmail: env('ADMIN_EMAIL', 'admin@urumi.local'),
  adminPassword: env('ADMIN_PASSWORD', 'admin-dev-password'),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  sessionHours: num('SESSION_HOURS', 12),
  // Upstream behaviour.
  connectTimeoutMs: num('CONNECT_TIMEOUT_MS', 2000),
  callTimeoutMs: num('CALL_TIMEOUT_MS', 30_000),
  probeTimeoutMs: num('PROBE_TIMEOUT_MS', 8000),
  tickMs: num('TICK_MS', 5000),
  strikes: num('STRIKES', 3),
  toolsTtlMs: num('TOOLS_TTL_MS', 5000),
  // Hostnames the SSRF guard lets resolve to private addresses (in-cluster upstreams the admin registers).
  ssrfAllowHosts: env('SSRF_ALLOW_HOSTS', 'woo-mcp,woo-mcp.urumi.svc.cluster.local,demo-upstream,demo-upstream.urumi.svc.cluster.local,127.0.0.1,localhost')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  ssrfGuard: process.env.SSRF_GUARD !== '0',
  // Kubernetes EndpointSlice watch for in-cluster upstreams (namespace of the release; empty = off).
  k8sNamespace: process.env.K8S_WATCH_NAMESPACE ?? '',
  // Seed upstreams on first start: JSON [{slug,name,url,authHeader?,credential?,timeoutMs?}].
  seedServers: process.env.SEED_SERVERS ?? '',
  // Chat agent (OpenAI-compatible endpoint).
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
  llmApiKey: process.env.LLM_API_KEY ?? 'none',
  llmModel: process.env.LLM_MODEL ?? 'qwen3.5-agent',
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? 'none', // '' = don't send the parameter
  storeTimezone: process.env.STORE_TIMEZONE ?? 'UTC',
  dashboardDir: process.env.DASHBOARD_DIR ?? '../dashboard/dist',
  version: '0.1.0',
};
