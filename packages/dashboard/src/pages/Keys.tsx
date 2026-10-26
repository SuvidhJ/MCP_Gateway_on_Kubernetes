import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ApiKey, type Info, type Member } from '../api';
import { Badge, CopyButton, ErrorText, Time, useAction, useIsAdmin } from '../ui';

export const useInfo = () => useQuery({ queryKey: ['info'], queryFn: () => api<Info>('/api/info'), staleTime: 60_000 });

export function Keys() {
  const admin = useIsAdmin();
  const [all, setAll] = useState(false);
  const [name, setName] = useState('');
  const [owner, setOwner] = useState(''); // admins: issue for another member ('' = me)
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/api/members'), enabled: admin });
  const showAll = admin && all;
  const keys = useQuery({
    queryKey: ['keys', showAll],
    queryFn: () => api<ApiKey[]>(showAll ? '/api/keys?all=1' : '/api/keys'),
  });
  const create = useAction(
    (n: string) => api<{ key: ApiKey; secret: string }>('/api/keys', { method: 'POST', body: { name: n, ...(owner ? { userId: Number(owner) } : {}) } }),
    [['keys']],
    (r) => { setCreated(r); setName(''); },
  );
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(name.trim()); };

  return (
    <>
      <div className="page-head">
        <div>
          <h2>API keys</h2>
          <p className="muted">Each key acts as you. MCP clients send it as <code>Authorization: Bearer urumi_…</code>.</p>
        </div>
        {admin && (
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all users' keys
          </label>
        )}
      </div>
      <form className="card form inline-form" onSubmit={submit}>
        <label>
          New key name
          <input required value={name} placeholder="e.g. claude-code-laptop" onChange={(e) => setName(e.target.value)} />
        </label>
        {admin && (
          <label>
            For
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">me</option>
              {members.data?.filter((m) => !m.disabled).map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn-primary" disabled={create.isPending}>Create key</button>
        <ErrorText error={create.error} />
      </form>
      {created && <NewKey created={created} onClose={() => setCreated(null)} />}
      <ErrorText error={keys.error} />
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Prefix</th>{showAll && <th>Owner</th>}<th>Created</th><th>Last used</th><th>Status</th>
              <th className="actions" />
            </tr>
          </thead>
          <tbody>
            {keys.data?.map((k) => <KeyRow key={k.id} k={k} showOwner={showAll} />)}
            {keys.data?.length === 0 && <tr><td colSpan={7} className="empty">No keys yet.</td></tr>}
            {keys.isPending && <tr><td colSpan={7} className="empty">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function KeyRow({ k, showOwner }: { k: ApiKey; showOwner: boolean }) {
  const revoke = useAction(() => api(`/api/keys/${k.id}`, { method: 'DELETE' }), [['keys']]);
  return (
    <>
      <tr className={k.revokedAt ? 'dim' : undefined}>
        <td className="strong">{k.name}</td>
        <td><code>{k.prefix}…</code></td>
        {showOwner && <td>{k.userEmail}</td>}
        <td><Time iso={k.createdAt} /></td>
        <td>{k.lastUsedAt ? <Time iso={k.lastUsedAt} relative /> : <span className="muted">never</span>}</td>
        <td>
          {k.revokedAt
            ? <span title={new Date(k.revokedAt).toLocaleString()}><Badge tone="grey">Revoked</Badge></span>
            : <Badge tone="green">Active</Badge>}
        </td>
        <td className="actions">
          {!k.revokedAt && (
            <button className="btn btn-small btn-danger" disabled={revoke.isPending}
              onClick={() => { if (confirm(`Revoke key "${k.name}"? Clients using it stop working immediately.`)) revoke.mutate(); }}>
              Revoke
            </button>
          )}
        </td>
      </tr>
      {revoke.error && <tr><td colSpan={7}><ErrorText error={revoke.error} /></td></tr>}
    </>
  );
}

function NewKey({ created, onClose }: { created: { key: ApiKey; secret: string }; onClose: () => void }) {
  const info = useInfo();
  const mcpUrl = info.data?.mcpUrl ?? `${window.location.origin}/mcp`;
  const { secret } = created;
  const cli = `claude mcp add --transport http urumi ${mcpUrl} --header "Authorization: Bearer ${secret}"`;
  const json = JSON.stringify(
    { mcpServers: { urumi: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } } } },
    null,
    2,
  );
  return (
    <div className="card secret-box">
      <div className="secret-head">
        Key <strong>{created.key.name}</strong> created for <strong>{created.key.userEmail}</strong>. Copy the secret now: it is
        shown <strong>only once</strong>.
      </div>
      <div className="secret-line">
        <code className="secret">{secret}</code>
        <CopyButton text={secret} />
      </div>
      <h4>Claude Code</h4>
      <div className="snippet">
        <pre>{cli}</pre>
        <CopyButton text={cli} />
      </div>
      <p className="muted small">Clients that support OAuth can also connect with just <code>{mcpUrl}</code> and a browser sign-in
        (no key): they appear under Account → Connected apps.</p>
      <h4>JSON client config (<code>mcpServers</code>)</h4>
      <div className="snippet">
        <pre>{json}</pre>
        <CopyButton text={json} />
      </div>
      <button className="btn btn-small" onClick={onClose}>I have saved it</button>
    </div>
  );
}
