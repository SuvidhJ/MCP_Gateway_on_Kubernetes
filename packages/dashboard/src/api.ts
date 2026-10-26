// Fetch helper and types for the gateway admin API (docs/api.md). Same origin, cookie session.

export type Role = 'admin' | 'member';
export interface User { id: string; email: string; name: string; role: Role; mustChangePassword?: boolean }
export interface Me { user: User; csrf: string }
export interface Info { mcpUrl: string; version: string; chat: { enabled: boolean; model: string | null } }

export type ServerStatus = 'connecting' | 'connected' | 'unreachable' | 'auth_failed' | 'disabled';
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface Tool {
  name: string;
  gatewayName: string;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema?: unknown;
  /** Who may see and call it through the gateway: everyone, admins only, or nobody. */
  access: ToolAccess;
  /** The upstream changed this tool's definition since it was approved: hidden from clients until re-approved. */
  changed?: boolean;
  /** 'changed' = definition differs from the approved one; 'new' = appeared after the server was approved. */
  change?: 'changed' | 'new';
  approvedDescription?: string | null;
}
export type ToolAccess = 'member' | 'admin' | 'off';
export interface Server {
  id: string;
  slug: string;
  name: string;
  url: string;
  enabled: boolean;
  status: ServerStatus;
  era: 'modern' | 'legacy' | null;
  protocolVersion: string | null;
  lastError: string | null;
  statusSince: string;
  timeoutMs: number | null;
  hasCredential: boolean;
  authHeader: string | null;
  /** Registered by the provisioner (a store or hosted server): URL and credential are not editable here. */
  managed?: boolean;
  tools: Tool[];
}
/** Per-server activity in the last hour (from the audit log; members see their own calls only). */
export interface ServerStats { server: string | null; calls: number; failures: number; toolErrors: number; p50: number; p95: number; lastCall: string }

export interface ServerEvent { at: string; status: ServerStatus; error: string | null }

export interface Member { id: string; email: string; name: string; role: Role; disabled: boolean; createdAt: string }

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  userEmail: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type Outcome =
  | 'ok' | 'tool_error' | 'denied' | 'quarantined' | 'unknown_tool' | 'disabled' | 'unreachable' | 'timeout'
  | 'upstream_auth' | 'cancelled' | 'too_large' | 'rejected' | 'error';
export const OUTCOMES: Outcome[] = [
  'ok', 'tool_error', 'denied', 'quarantined', 'unknown_tool', 'disabled', 'unreachable', 'timeout', 'upstream_auth',
  'cancelled', 'too_large', 'rejected', 'error',
];
export interface Provision {
  id: number; kind: 'store' | 'hosted'; slug: string; name: string; ownerId: number | null; ownerEmail: string;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting'; step: string | null; reason: string | null; namespace: string;
  url: string | null; timeoutS: number; attempts: number; createdAt: string; startedAt: string; readyAt: string | null;
  upstreamId: number | null;
  spec?: { image: string; port: number; path: string; egress: 'none' | 'internet'; env: Record<string, string>; secretEnvNames: string[] };
}
export interface OAuthGrant {
  id: string; clientId: string; clientName: string; redirectHost: string; createdAt: string; lastUsedAt: string | null;
  revokedAt: string | null; userEmail: string; verified: boolean;
}
export interface AuditItem {
  id: string | number;
  at: string;
  userEmail: string;
  via: string;
  server: string | null;
  tool: string | null;
  durationMs: number | null;
  outcome: Outcome;
  error: string | null;
  era: string | null;
  client: string | null;
}
export interface AuditPage { items: AuditItem[]; nextBefore: string | number | null }

let csrf = '';
export const setCsrf = (token: string) => { csrf = token; };
export const getCsrf = () => csrf;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new ApiError(res.status, msg || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const qs = (params: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
