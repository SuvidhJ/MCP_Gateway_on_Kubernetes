import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Provision } from '../api';
import { ErrorText, Time, useAction } from '../ui';
import { ProvisionStatus } from './Stores';
import { slugify } from './Servers';

/** "KEY=value" lines -> object (blank lines and # comments ignored). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`not KEY=value: ${line.slice(0, 40)}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

/** Admins: MCP servers the platform runs from a container image (own namespace, Secret, limits, NetworkPolicy). */
export function HostedServers() {
  const [adding, setAdding] = useState(false);
  const hosted = useQuery({ queryKey: ['hosted'], queryFn: () => api<Provision[]>('/api/hosted'), refetchInterval: 2000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Hosted MCP servers</h2>
          <p className="muted">Deploy a Streamable HTTP MCP server from a container image: it runs in its own namespace as an unprivileged
            user with a read-only filesystem, its secrets in a Kubernetes Secret, reachable only by the gateway, and is registered automatically.</p>
        </div>
        {!adding && <button className="btn btn-primary" onClick={() => setAdding(true)}>Deploy from image</button>}
      </div>
      {adding && <HostedForm onDone={() => setAdding(false)} />}
      <ErrorText error={hosted.error} />
      <div className="card table-card">
        <table>
          <thead><tr><th>Server</th><th>Image</th><th>Status</th><th>Network</th><th>Created</th><th className="actions" /></tr></thead>
          <tbody>
            {hosted.data?.map((h) => <HostedRow key={h.id} h={h} />)}
            {hosted.data?.length === 0 && <tr><td colSpan={6} className="empty">None deployed.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HostedRow({ h }: { h: Provision }) {
  const del = useAction(() => api(`/api/hosted/${h.id}`, { method: 'DELETE' }), [['hosted'], ['servers']]);
  const retry = useAction(() => api(`/api/hosted/${h.id}/retry`, { method: 'POST' }), [['hosted']]);
  return (
    <>
      <tr className={h.status === 'deleting' ? 'dim' : undefined}>
        <td><div className="strong">{h.name}</div><div className="sub"><code>{h.slug}</code> · port {h.spec?.port}{h.spec?.path}</div></td>
        <td><code>{h.spec?.image}</code>{!!h.spec?.secretEnvNames?.length && <div className="sub">secrets: {h.spec.secretEnvNames.join(', ')}</div>}</td>
        <td><ProvisionStatus p={h} />{h.status !== 'ready' && h.step && <div className="sub">{h.step}</div>}
          {h.reason && <div className={`sub ${h.status === 'failed' ? 'err-text' : ''}`}>{h.reason}</div>}</td>
        <td>{h.spec?.egress === 'internet' ? 'public internet' : 'no outbound'}</td>
        <td><Time iso={h.createdAt} /></td>
        <td className="actions">
          {h.status === 'failed' && <button className="btn btn-small" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>Retry</button>}
          {h.status !== 'deleting' && <button className="btn btn-small btn-danger" disabled={del.isPending}
            onClick={() => { if (confirm(`Remove "${h.name}"? Its namespace, Secret and tools are deleted.`)) del.mutate(undefined); }}>Remove</button>}
        </td>
      </tr>
      {(del.error || retry.error) && <tr><td colSpan={6}><ErrorText error={del.error ?? retry.error} /></td></tr>}
    </>
  );
}

function HostedForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [image, setImage] = useState('');
  const [port, setPort] = useState('8080');
  const [path, setPath] = useState('/mcp');
  const [env, setEnv] = useState('');
  const [secretEnv, setSecretEnv] = useState('');
  const [egress, setEgress] = useState<'none' | 'internet'>('none');
  const [parseError, setParseError] = useState<unknown>(null);
  const create = useAction((body: unknown) => api('/api/hosted', { method: 'POST', body }), [['hosted']], onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      setParseError(null);
      create.mutate({ name: name.trim(), slug, image: image.trim(), port: Number(port), path, env: parseEnv(env), secretEnv: parseEnv(secretEnv), egress });
    } catch (err) { setParseError(err); }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h3>Deploy an MCP server from an image</h3>
      <div className="grid">
        <label>Name<input required value={name} onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }} /></label>
        <label>Slug (tool prefix)<input required value={slug} pattern="[a-z][a-z0-9\-]{1,30}" onChange={(e) => setSlug(e.target.value)} /></label>
        <label>Outbound network
          <select value={egress} onChange={(e) => setEgress(e.target.value as 'none' | 'internet')}>
            <option value="none">none (DNS only)</option><option value="internet">public internet (no cluster, no metadata)</option>
          </select>
        </label>
        <label className="wide">Image (pinned tag or digest)<input required value={image} placeholder="ghcr.io/org/mcp-server:1.2.3" onChange={(e) => setImage(e.target.value)} /></label>
        <label>Container port<input required type="number" min="1024" max="65535" value={port} onChange={(e) => setPort(e.target.value)} /></label>
        <label>MCP path<input required value={path} onChange={(e) => setPath(e.target.value)} /></label>
        <span />
        <label className="wide">Environment (KEY=value per line)<textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} /></label>
        <label className="wide">Secret environment (stored in a Kubernetes Secret, never shown again)<textarea rows={2} value={secretEnv} onChange={(e) => setSecretEnv(e.target.value)} /></label>
      </div>
      <ErrorText error={parseError ?? create.error} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={create.isPending}>Deploy</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
