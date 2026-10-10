import { Fragment, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Server, type ServerEvent, type ServerStats, type Tool, type ToolAccess } from '../api';
import { Badge, ErrorText, StatusBadge, Time, useAction, useIsAdmin } from '../ui';

const SERVERS = ['servers'];

export function slugify(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s && !/^[a-z]/.test(s)) s = `s-${s}`;
  return s.slice(0, 31).replace(/-+$/, '');
}

export function Servers() {
  const admin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const servers = useQuery({ queryKey: SERVERS, queryFn: () => api<Server[]>('/api/servers'), refetchInterval: 2000 });
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<ServerStats[]>('/api/stats'), refetchInterval: 5000 });
  const statsBySlug = new Map((stats.data ?? []).map((x) => [x.server, x]));

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Upstream MCP servers</h2>
          <p className="muted">Status refreshes every 2 s. Tools are exposed to clients as <code>slug__tool</code>.</p>
        </div>
        {admin && !adding && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add server</button>}
      </div>
      {adding && <ServerForm onDone={() => setAdding(false)} />}
      <ErrorText error={servers.error} />
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th />
              <th>Server</th>
              <th>Status</th>
              <th>Protocol</th>
              <th className="num">Tools</th>
              <th title="Tool calls through the gateway in the last hour (failures = unreachable, timeout, denied…; p95 latency)">Last hour</th>
              <th>Status since</th>
              <th>Last error</th>
              {admin && <th className="actions">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {servers.data?.map((s) => <ServerRow key={s.id} server={s} admin={admin} stats={statsBySlug.get(s.slug)} />)}
            {servers.data?.length === 0 && (
              <tr><td colSpan={9} className="empty">No servers registered yet.</td></tr>
            )}
            {servers.isPending && <tr><td colSpan={9} className="empty">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

type Panel = 'tools' | 'edit' | 'history' | null;

function ServerRow({ server: s, admin, stats }: { server: Server; admin: boolean; stats?: ServerStats }) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const patch = useAction((body: Partial<Server>) => api(`/api/servers/${s.id}`, { method: 'PATCH', body }), [SERVERS]);
  const del = useAction(() => api(`/api/servers/${s.id}`, { method: 'DELETE' }), [SERVERS]);
  const cols = admin ? 9 : 8;

  return (
    <Fragment>
      <tr className={panel ? 'row-open' : undefined}>
        <td className="expander">
          <button className="link" onClick={() => toggle('tools')} aria-label="Show tools">
            {panel === 'tools' ? '▾' : '▸'}
          </button>
        </td>
        <td>
          <div className="strong">{s.name}</div>
          <div className="sub"><code>{s.slug}</code> · <span className="url">{s.url}</span></div>
        </td>
        <td><StatusBadge status={s.status} /></td>
        <td>
          {s.era ? <Badge tone="blue">{s.era}</Badge> : <span className="muted">—</span>}
          {s.protocolVersion && <div className="sub">{s.protocolVersion}</div>}
        </td>
        <td className="num">
          {s.tools.length}
          {s.tools.some((t) => t.changed) && <div><Badge tone="red" title="A tool changed its definition">review</Badge></div>}
        </td>
        <td>
          {stats ? (
            <>
              <div>{stats.calls} call{stats.calls === 1 ? '' : 's'}{stats.failures > 0 && <span className="err-text"> · {stats.failures} failed</span>}</div>
              <div className="sub">p95 {stats.p95} ms</div>
            </>
          ) : <span className="muted">—</span>}
        </td>
        <td><Time iso={s.statusSince} relative /></td>
        <td className="err-cell" title={s.lastError ?? undefined}>{s.lastError ?? <span className="muted">—</span>}</td>
        {admin && (
          <td className="actions">
            <label className="switch" title={s.enabled ? 'Disable' : 'Enable'}>
              <input type="checkbox" checked={s.enabled} disabled={patch.isPending}
                onChange={() => patch.mutate({ enabled: !s.enabled })} />
              <span>{s.enabled ? 'On' : 'Off'}</span>
            </label>
            <button className="btn btn-small" onClick={() => toggle('edit')}>Edit</button>
            <button className="btn btn-small" onClick={() => toggle('history')}>History</button>
            <button className="btn btn-small btn-danger" disabled={del.isPending}
              onClick={() => { if (confirm(`Delete server "${s.name}"? Its tools disappear from the gateway.`)) del.mutate(); }}>
              Delete
            </button>
          </td>
        )}
      </tr>
      {(patch.error || del.error) && (
        <tr><td colSpan={cols}><ErrorText error={patch.error ?? del.error} /></td></tr>
      )}
      {panel && (
        <tr className="detail">
          <td colSpan={cols}>
            {panel === 'tools' && <ToolList server={s} admin={admin} />}
            {panel === 'edit' && <ServerForm server={s} onDone={() => setPanel(null)} />}
            {panel === 'history' && <History id={s.id} />}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

const ACCESS_LABEL: Record<ToolAccess, string> = { member: 'Everyone', admin: 'Admins only', off: 'Off' };

function ToolList({ server, admin }: { server: Server; admin: boolean }) {
  const tools: Tool[] = server.tools;
  const setAccess = useAction(({ tool, access }: { tool: string; access: ToolAccess }) =>
    api(`/api/servers/${server.id}/tools/${encodeURIComponent(tool)}/access`, { method: 'PUT', body: { access } }), [SERVERS]);
  const approve = useAction((tool: string) =>
    api(`/api/servers/${server.id}/tools/${encodeURIComponent(tool)}/approve`, { method: 'POST' }), [SERVERS]);
  if (tools.length === 0) return <p className="muted">No tools (server not connected or exposes none).</p>;
  return (
    <table className="inner">
      <thead><tr><th>Gateway name</th><th>Description</th><th>Hints</th><th title="Restricted tools are hidden from tools/list and rejected if called">Access</th></tr></thead>
      <tbody>
        {(setAccess.error || approve.error) && <tr><td colSpan={4}><ErrorText error={setAccess.error ?? approve.error} /></td></tr>}
        {tools.map((t) => (
          <tr key={t.gatewayName}>
            <td><code>{t.gatewayName}</code>{t.title && <div className="sub">{t.title}</div>}</td>
            <td className="desc">
              {t.changed && (
                <div className="changed">
                  <Badge tone="red" title="Hidden from clients and the chat until an admin approves the new definition">definition changed</Badge>
                  <div className="sub">Approved: {t.approvedDescription ?? '—'}</div>
                  <div className="sub">Now:</div>
                </div>
              )}
              {t.description ?? <span className="muted">—</span>}
              {t.changed && admin && (
                <div><button className="btn btn-small" disabled={approve.isPending}
                  onClick={() => { if (confirm(`Approve the new definition of ${t.gatewayName}? Clients will see it again.`)) approve.mutate(t.name); }}>
                  Approve change</button></div>
              )}
            </td>
            <td className="chips">
              {t.annotations?.readOnlyHint && <Badge tone="green">read-only</Badge>}
              {t.annotations?.destructiveHint && <Badge tone="red">destructive</Badge>}
              {t.annotations?.idempotentHint && <Badge tone="grey">idempotent</Badge>}
              {!t.annotations?.readOnlyHint && <Badge tone="amber" title="Chat asks for approval">needs approval</Badge>}
            </td>
            <td>
              {admin ? (
                <select value={t.access} disabled={setAccess.isPending}
                  onChange={(e) => setAccess.mutate({ tool: t.name, access: e.target.value as ToolAccess })}>
                  {(Object.keys(ACCESS_LABEL) as ToolAccess[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
                </select>
              ) : (
                <Badge tone={t.access === 'member' ? 'green' : t.access === 'admin' ? 'amber' : 'grey'}>{ACCESS_LABEL[t.access]}</Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function History({ id }: { id: string }) {
  const events = useQuery({
    queryKey: [...SERVERS, id, 'events'],
    queryFn: () => api<ServerEvent[]>(`/api/servers/${id}/events`),
    refetchInterval: 2000,
  });
  if (events.error) return <ErrorText error={events.error} />;
  if (!events.data) return <p className="muted">Loading…</p>;
  if (events.data.length === 0) return <p className="muted">No status changes recorded.</p>;
  return (
    <table className="inner">
      <thead><tr><th>When</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>
        {events.data.map((e, i) => (
          <tr key={`${e.at}-${i}`}>
            <td><Time iso={e.at} /> <span className="sub">({<Time iso={e.at} relative />})</span></td>
            <td><StatusBadge status={e.status} /></td>
            <td className="desc">{e.error ?? <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServerForm({ server, onDone }: { server?: Server; onDone: () => void }) {
  const editing = !!server;
  const [name, setName] = useState(server?.name ?? '');
  const [slug, setSlug] = useState(server?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(false);
  const [url, setUrl] = useState(server?.url ?? '');
  const [authHeader, setAuthHeader] = useState(server?.authHeader ?? 'Authorization');
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [timeout, setTimeoutS] = useState(server?.timeoutMs ? String(server.timeoutMs / 1000) : '');

  const save = useAction(
    (body: Record<string, unknown>) =>
      editing
        ? api(`/api/servers/${server.id}`, { method: 'PATCH', body })
        : api('/api/servers', { method: 'POST', body }),
    [SERVERS],
    onDone,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { name: name.trim(), url: url.trim() };
    if (!editing) body.slug = slug;
    const t = Number(timeout);
    if (timeout.trim() && t > 0) body.timeoutMs = Math.round(t * 1000);
    const header = authHeader.trim() || 'Authorization';
    if (clearCredential) {
      body.credential = '';
    } else if (credential) {
      body.authHeader = header;
      body.credential = credential;
    } else if (editing && server.hasCredential && header !== server.authHeader) {
      body.authHeader = header;
    }
    save.mutate(body);
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{editing ? `Edit ${server.name}` : 'Add an upstream MCP server'}</h3>
      <div className="grid">
        <label>
          Name
          <input required value={name} placeholder="WooCommerce store"
            onChange={(e) => { setName(e.target.value); if (!editing && !slugTouched) setSlug(slugify(e.target.value)); }} />
        </label>
        <label>
          Slug {editing && <span className="muted">(fixed)</span>}
          <input required value={slug} disabled={editing} pattern="[a-z][a-z0-9\-]{1,30}"
            title="Lowercase letter first, then 1-30 of a-z, 0-9, -"
            onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} />
        </label>
        <label className="wide">
          URL
          <input required type="url" value={url} placeholder="http://woo-mcp.store.svc:3000/mcp"
            onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Auth header name
          <input value={authHeader} placeholder="Authorization" onChange={(e) => setAuthHeader(e.target.value)} />
        </label>
        <label>
          Credential (full header value)
          <input type="password" autoComplete="new-password" value={credential} disabled={clearCredential}
            placeholder={editing && server.hasCredential ? 'unchanged — leave blank to keep' : 'e.g. Bearer xyz (optional)'}
            onChange={(e) => setCredential(e.target.value)} />
        </label>
        <label>
          Timeout (seconds)
          <input type="number" min="1" step="1" value={timeout} placeholder="default"
            onChange={(e) => setTimeoutS(e.target.value)} />
        </label>
        {editing && server.hasCredential && (
          <label className="check">
            <input type="checkbox" checked={clearCredential} onChange={(e) => setClearCredential(e.target.checked)} />
            Remove stored credential
          </label>
        )}
      </div>
      <ErrorText error={save.error} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={save.isPending}>{editing ? 'Save' : 'Add server'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
