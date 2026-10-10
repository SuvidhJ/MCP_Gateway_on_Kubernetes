import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, OUTCOMES, qs, type AuditItem, type AuditPage, type Server } from '../api';
import { ErrorText, OutcomeBadge, Time, useIsAdmin } from '../ui';

const LIMIT = 100;

export function Audit() {
  const admin = useIsAdmin();
  const [user, setUser] = useState('');
  const [server, setServer] = useState('');
  const [outcome, setOutcome] = useState('');
  const filters = { user: admin ? user.trim() : '', server, outcome };

  // Newest page refreshes every 3 s; older pages are fetched on demand and kept.
  const head = useQuery({
    queryKey: ['audit', filters],
    queryFn: () => api<AuditPage>(`/api/audit${qs({ limit: LIMIT, ...filters })}`),
    refetchInterval: 3000,
  });
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<Server[]>('/api/servers') });

  const [older, setOlder] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<AuditPage['nextBefore'] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const filterKey = JSON.stringify(filters);
  useEffect(() => { setOlder([]); setCursor(undefined); setOlderError(null); }, [filterKey]);

  const next = cursor === undefined ? head.data?.nextBefore ?? null : cursor;
  const loadOlder = async () => {
    if (next === null) return;
    setLoading(true);
    setOlderError(null);
    try {
      const page = await api<AuditPage>(`/api/audit${qs({ limit: LIMIT, before: next, ...filters })}`);
      setOlder((o) => [...o, ...page.items]);
      setCursor(page.nextBefore);
    } catch (e) {
      setOlderError(e);
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...(head.data?.items ?? []), ...older].filter((r) => {
      const id = String(r.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [head.data, older]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">
            Every tool call through the gateway{admin ? ', for all users' : ' you made'}. Refreshes every 3 s.
          </p>
        </div>
      </div>
      <div className="card filters">
        {admin && (
          <label>User<input value={user} placeholder="email" onChange={(e) => setUser(e.target.value)} /></label>
        )}
        <label>
          Server
          <select value={server} onChange={(e) => setServer(e.target.value)}>
            <option value="">all</option>
            {servers.data?.map((s) => <option key={s.id} value={s.slug}>{s.slug}</option>)}
          </select>
        </label>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">all</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        {(user || server || outcome) && (
          <button className="btn btn-small" onClick={() => { setUser(''); setServer(''); setOutcome(''); }}>Clear</button>
        )}
      </div>
      <ErrorText error={head.error} />
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>User</th><th>Via</th><th>Server</th><th>Tool</th>
              <th className="num">Duration</th><th>Outcome</th><th>Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="nowrap"><Time iso={r.at} /></td>
                <td>{r.userEmail}</td>
                <td>
                  <code className="via">{r.via}</code>
                  {(r.client || r.era) && <div className="sub">{[r.client, r.era].filter(Boolean).join(' · ')}</div>}
                </td>
                <td>{r.server ?? <span className="muted">—</span>}</td>
                <td><code>{r.tool ?? '—'}</code></td>
                <td className="num">{r.durationMs != null ? `${r.durationMs} ms` : '—'}</td>
                <td><OutcomeBadge outcome={r.outcome} /></td>
                <td className="err-cell" title={r.error ?? undefined}>{r.error ?? ''}</td>
              </tr>
            ))}
            {head.data && rows.length === 0 && <tr><td colSpan={8} className="empty">No audit entries.</td></tr>}
            {head.isPending && <tr><td colSpan={8} className="empty">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      <ErrorText error={olderError} />
      {head.data && (
        <div className="center-row">
          {next !== null
            ? <button className="btn" disabled={loading} onClick={() => void loadOlder()}>{loading ? 'Loading…' : 'Load older'}</button>
            : rows.length > 0 && <span className="muted">End of log.</span>}
        </div>
      )}
    </>
  );
}
