// Small shared UI pieces: badges, time formatting, copy button, errors, current-user context.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Me } from './api';

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside MeContext');
  return me;
}
export const useIsAdmin = () => useMe().user.role === 'admin';

export type Tone = 'green' | 'red' | 'amber' | 'grey' | 'blue';

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

const STATUS: Record<string, [Tone, string]> = {
  connected: ['green', 'Connected'],
  unreachable: ['red', 'Unreachable'],
  auth_failed: ['amber', 'Auth failed'],
  connecting: ['amber', 'Connecting'],
  disabled: ['grey', 'Disabled'],
};
export function StatusBadge({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ['grey', status];
  return <Badge tone={tone}>{label}</Badge>;
}

const OUTCOME_TONE: Record<string, Tone> = {
  ok: 'green',
  tool_error: 'amber',
  denied: 'red',
  unknown_tool: 'grey',
  disabled: 'grey',
  unreachable: 'red',
  timeout: 'red',
  upstream_auth: 'amber',
  quarantined: 'red',
  cancelled: 'grey',
  too_large: 'amber',
  rejected: 'red',
  error: 'red',
};
export const OutcomeBadge = ({ outcome }: { outcome: string }) => (
  <Badge tone={OUTCOME_TONE[outcome] ?? 'grey'}>{outcome}</Badge>
);

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return '—';
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

export const Time = ({ iso, relative }: { iso: string | null | undefined; relative?: boolean }) => (
  <span title={iso ? new Date(iso).toLocaleString() : undefined}>{relative ? ago(iso) : fmtTime(iso)}</span>
);

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Non-secure contexts (plain http on a non-localhost name) have no clipboard API.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <button type="button" className="btn btn-small" onClick={copy}>{copied ? 'Copied' : label}</button>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error">{error instanceof Error ? error.message : String(error)}</div>;
}

/** useMutation that invalidates the given query keys on success. */
export function useAction<V = void, R = unknown>(fn: (v: V) => Promise<R>, invalidate: QueryKey[], onSuccess?: (r: R) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      onSuccess?.(r);
    },
  });
}

export const Json = ({ value }: { value: unknown }) => (
  <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
);
