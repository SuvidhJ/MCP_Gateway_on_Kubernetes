import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Provision } from '../api';
import { Badge, ErrorText, Time, useAction, useIsAdmin, useMe, type Tone } from '../ui';
import { slugify } from './Servers';

const STATUS: Record<Provision['status'], [Tone, string]> = {
  provisioning: ['amber', 'Provisioning'], ready: ['green', 'Ready'], failed: ['red', 'Failed'], deleting: ['grey', 'Deleting'],
};
export const ProvisionStatus = ({ p }: { p: Provision }) => {
  const [tone, label] = STATUS[p.status];
  return <Badge tone={tone} title={p.step ?? undefined}>{label}</Badge>;
};

/** WooCommerce stores provisioned on demand, each in its own namespace and registered in the gateway as <slug>__…. */
export function Stores() {
  const me = useMe();
  const admin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api<Provision[]>('/api/stores'), refetchInterval: 2000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Stores</h2>
          <p className="muted">Each store gets its own namespace, database, volumes, secrets and URL, and its own WooCommerce MCP server,
            registered in the gateway automatically (tools <code>&lt;slug&gt;__list_orders</code>, …).</p>
        </div>
        {!adding && <button className="btn btn-primary" onClick={() => setAdding(true)}>New store</button>}
      </div>
      {adding && <StoreForm admin={admin} onDone={() => setAdding(false)} />}
      <ErrorText error={stores.error} />
      <div className="card table-card">
        <table>
          <thead><tr><th>Store</th><th>Status</th><th>URL</th><th>Owner</th><th>Created</th><th className="actions" /></tr></thead>
          <tbody>
            {stores.data?.map((s) => <StoreRow key={s.id} s={s} canManage={admin || s.ownerId === Number(me.user.id)} />)}
            {stores.data?.length === 0 && <tr><td colSpan={6} className="empty">No provisioned stores yet. The main store is registered as <code>store</code>.</td></tr>}
            {stores.isPending && <tr><td colSpan={6} className="empty">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StoreRow({ s, canManage }: { s: Provision; canManage: boolean }) {
  const del = useAction(() => api(`/api/stores/${s.id}`, { method: 'DELETE' }), [['stores'], ['servers']]);
  const retry = useAction(() => api(`/api/stores/${s.id}/retry`, { method: 'POST' }), [['stores']]);
  return (
    <>
      <tr className={s.status === 'deleting' ? 'dim' : undefined}>
        <td><div className="strong">{s.name}</div><div className="sub"><code>{s.slug}</code> · namespace <code>{s.namespace}</code></div></td>
        <td>
          <ProvisionStatus p={s} />
          {s.status !== 'ready' && s.step && <div className="sub">{s.step}</div>}
          {s.reason && <div className={`sub ${s.status === 'failed' ? 'err-text' : ''}`}>{s.reason}</div>}
        </td>
        <td>{s.url && s.status === 'ready' ? <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a> : <span className="muted">{s.url}</span>}</td>
        <td>{s.ownerEmail}</td>
        <td><Time iso={s.createdAt} /></td>
        <td className="actions">
          {canManage && s.status === 'failed' && <button className="btn btn-small" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>Retry</button>}
          {canManage && s.status !== 'deleting' && (
            <button className="btn btn-small btn-danger" disabled={del.isPending}
              onClick={() => { if (confirm(`Delete store "${s.name}"? Its namespace, database, volumes, secrets and MCP tools are removed. This cannot be undone.`)) del.mutate(undefined); }}>
              Delete</button>
          )}
        </td>
      </tr>
      {(del.error || retry.error) && <tr><td colSpan={6}><ErrorText error={del.error ?? retry.error} /></td></tr>}
    </>
  );
}

function StoreForm({ admin, onDone }: { admin: boolean; onDone: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [timeout, setTimeoutS] = useState('');
  const create = useAction(() => api('/api/stores', { method: 'POST', body: { name: name.trim(), slug, ...(admin && timeout ? { timeoutS: Number(timeout) } : {}) } }), [['stores']], onDone);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };
  return (
    <form className="card form" onSubmit={submit}>
      <h3>New store</h3>
      <div className="grid">
        <label>Name<input required value={name} placeholder="Summer Shop" onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} /></label>
        <label>Slug (URL and tool prefix)<input required value={slug} pattern="[a-z][a-z0-9\-]{1,30}" onChange={(e) => { setSlug(e.target.value); setTouched(true); }} /></label>
        {admin && <label>Timeout (s) <span className="muted">(optional)</span><input type="number" min="20" max="3600" value={timeout} placeholder="600" onChange={(e) => setTimeoutS(e.target.value)} /></label>}
      </div>
      <p className="muted small">Takes about a minute. Tools appear as <code>{slug || 'slug'}__list_orders</code>, …</p>
      <ErrorText error={create.error} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={create.isPending}>Create store</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
