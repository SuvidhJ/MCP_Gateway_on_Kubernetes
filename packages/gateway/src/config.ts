// All gateway settings come from the environment (the Helm chart sets them).
import crypto from 'node:crypto';

const production = process.env.NODE_ENV === 'production';
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
/** A secret: required in production (the image sets NODE_ENV=production). In local dev a missing one gets a random
 *  per-process value, so nothing secret is ever hard-coded and a forgotten env var can't fall back to a known value. */
const secret = (k: string) => {
  const v = process.env[k];
  if (v) return v;
  if (production) throw new Error(`missing secret env ${k} (set it from a Kubernetes Secret)`);
  const v2 = crypto.randomBytes(18).toString('base64url');
  console.error(`[gateway] ${k} not set: using a random value for this process (dev only)${k === 'ADMIN_PASSWORD' ? `: ${v2}` : ''}`);
  return v2;
};
const num = (k: string, d: number) => {
  const v = Number(process.env[k] ?? d);
  if (!Number.isFinite(v)) throw new Error(`env ${k} must be a number`);
  return v;
};
const list = (k: string, d: string) => env(k, d).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const publicUrl = env('PUBLIC_URL', 'http://gateway.127.0.0.1.nip.io:8080').replace(/\/+$/, '');

export const config = {
  production,
  port: num('PORT', 8080),
  metricsPort: num('METRICS_PORT', 9091), // Prometheus /metrics, not routed by the Ingress (0 = off)
  databaseUrl: production ? secret('DATABASE_URL') : env('DATABASE_URL', 'postgres://urumi@127.0.0.1:5432/urumi'),
  // Public origin of the gateway (Host/Origin guard, OAuth issuer, mcpUrl shown in the dashboard).
  publicUrl,
  // More origins the same gateway answers on (e.g. http://localhost:8080 locally, so OAuth clients that only allow
  // plain HTTP on loopback can log in). Each gets its own issuer/resource in the OAuth metadata.
  extraOrigins: list('EXTRA_ORIGINS', '').map((o) => new URL(o).origin),
  // Extra Host header values accepted on /mcp (in-cluster callers use the Service name).
  allowedHosts: list('ALLOWED_HOSTS', 'gateway,gateway.urumi,gateway.urumi.svc,gateway.urumi.svc.cluster.local,127.0.0.1,localhost'),
  keyPepper: secret('KEY_PEPPER'),
  credentialKey: secret('CREDENTIAL_KEY'),
  jwtSecret: secret('JWT_SECRET'),
  adminEmail: env('ADMIN_EMAIL', 'admin@urumi.local'),
  adminPassword: secret('ADMIN_PASSWORD'),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  sessionHours: num('SESSION_HOURS', 12),
  // Upstream behaviour.
  connectTimeoutMs: num('CONNECT_TIMEOUT_MS', 2000),          // in-cluster upstreams (TCP)
  externalConnectTimeoutMs: num('EXTERNAL_CONNECT_TIMEOUT_MS', 5000), // internet upstreams (TCP + TLS)
  callTimeoutMs: num('CALL_TIMEOUT_MS', 30_000),
  probeTimeoutMs: num('PROBE_TIMEOUT_MS', 8000),
  tickMs: num('TICK_MS', 5000),
  strikes: num('STRIKES', 3),
  toolsTtlMs: num('TOOLS_TTL_MS', 5000),
  // Largest upstream tool result passed through (serialized bytes); bigger ones become a clear isError result.
  maxResultBytes: num('MAX_RESULT_BYTES', 2_000_000),
  // Per-key (per-user for the chat) MCP request rate limit: token bucket, `rateBurst` requests, refilled at `ratePerMin`.
  // Kept in Postgres, so the limit holds across every gateway replica.
  ratePerMin: num('RATE_PER_MIN', 120),
  rateBurst: num('RATE_BURST', 40),
  chatPerMin: num('CHAT_PER_MIN', 20),        // chat turns per user (each costs LLM tokens)
  loginPerMin: num('LOGIN_PER_MIN', 10),      // failed-login budget per email and per client address
  maxKeysPerUser: num('MAX_KEYS_PER_USER', 25),
  // Retention (days) for the audit log and upstream status history; 0 = keep forever.
  auditRetentionDays: num('AUDIT_RETENTION_DAYS', 90),
  eventRetentionDays: num('EVENT_RETENTION_DAYS', 30),
  // Hostnames the SSRF guard lets resolve to private addresses (in-cluster upstreams the admin registers).
  ssrfAllowHosts: list('SSRF_ALLOW_HOSTS', 'woo-mcp,woo-mcp.urumi.svc.cluster.local,demo-upstream,demo-upstream.urumi.svc.cluster.local,127.0.0.1,localhost'),
  ssrfGuard: process.env.SSRF_GUARD !== '0',
  // Kubernetes EndpointSlice watch for in-cluster upstreams (namespace of the release; empty = off). Managed
  // namespaces (stores, hosted servers) are watched too, once the provisioner has granted read access there.
  k8sNamespace: process.env.K8S_WATCH_NAMESPACE ?? '',
  // Provisioning (empty PROVISIONING = off): stores and hosted MCP servers.
  provisioning: process.env.PROVISIONING === '1',
  storeUrlPattern: process.env.STORE_URL_PATTERN ?? 'http://{slug}.127.0.0.1.nip.io:8080', // {slug} -> store slug
  maxStoresPerUser: num('MAX_STORES_PER_USER', 3),
  maxStores: num('MAX_STORES', 10),
  maxHosted: num('MAX_HOSTED', 10),
  storeTimeoutS: num('STORE_TIMEOUT_S', 600),
  hostedTimeoutS: num('HOSTED_TIMEOUT_S', 300),
  // Images an admin may deploy as hosted MCP servers: comma-separated prefixes ('' = any image)
  hostedImagePrefixes: list('HOSTED_IMAGE_PREFIXES', ''),
  // Seed upstreams on first start: JSON [{slug,name,url,authHeader?,credential?,timeoutMs?}].
  seedServers: process.env.SEED_SERVERS ?? '',
  // Chat agent (OpenAI-compatible endpoint).
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
  llmApiKey: process.env.LLM_API_KEY || 'none',
  // Comma-separated, tried in order: free tiers answer 503 "high demand" or hang, so later models are fallbacks.
  llmModels: (process.env.LLM_MODEL ?? 'qwen3.5-agent').split(',').map((m) => m.trim()).filter(Boolean),
  // A model that sends no output within this long hands the step to the next model (or the chat shows an error).
  llmFirstChunkMs: num('LLM_FIRST_CHUNK_MS', 20_000),
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? 'none', // '' = don't send the parameter
  storeTimezone: process.env.STORE_TIMEZONE ?? 'UTC',
  dashboardDir: process.env.DASHBOARD_DIR ?? '../dashboard/dist',
  version: '0.1.0',
};
