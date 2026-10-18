import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type OAuthGrant } from '../api';
import { Badge, ErrorText, Time, useAction, useIsAdmin, useMe } from '../ui';

const MIN = 10;

/** Change your own password. With `forced`, this is all a user with a temporary password can see. */
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api('/api/auth/password', { method: 'POST', body: { current, password } }),
    onSuccess: () => { setDone(true); setCurrent(''); setPassword(''); setAgain(''); onDone?.(); },
  });
  const mismatch = again.length > 0 && again !== password;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN || mismatch) return;
    change.mutate();
  };
  return (
    <form className="card form narrow" onSubmit={submit}>
      <h3>{forced ? 'Choose your own password' : 'Change password'}</h3>
      {forced && <p className="muted">You signed in with a temporary password. Replace it to continue.</p>}
      <label>
        {forced ? 'Temporary password' : 'Current password'}
        <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label>
        New password <span className="muted">(at least {MIN} characters)</span>
        <input type="password" autoComplete="new-password" required minLength={MIN} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        Repeat new password
        <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {mismatch && <div className="error">The passwords don't match.</div>}
      <ErrorText error={change.error} />
      {done && !forced && <div className="ok-text">Password changed. Your other sessions were signed out.</div>}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={change.isPending || mismatch || password.length < MIN}>Save password</button>
      </div>
    </form>
  );
}

export function Account() {
  const { user } = useMe();
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Your account</h2>
          <p className="muted">{user.email} · {user.role}</p>
        </div>
      </div>
      <ChangePassword />
      <ConnectedApps />
    </>
  );
}

/** MCP clients that signed in with OAuth (browser login) instead of an API key. */
function ConnectedApps() {
  const admin = useIsAdmin();
  const [all, setAll] = useState(false);
  const grants = useQuery({ queryKey: ['grants', all], queryFn: () => api<OAuthGrant[]>(`/api/oauth/grants${all ? '?all=1' : ''}`) });
  const revoke = useAction((id: string) => api(`/api/oauth/grants/${id}`, { method: 'DELETE' }), [['grants']]);
  return (
    <div className="card">
      <div className="page-head">
        <div>
          <h3>Connected apps</h3>
          <p className="muted">MCP clients that signed in through the browser (OAuth). Each acts as {all ? 'its user' : 'you'}, like an API key.</p>
        </div>
        {admin && <label className="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all users</label>}
      </div>
      <ErrorText error={grants.error ?? revoke.error} />
      <table>
        <thead><tr><th>App</th>{all && <th>User</th>}<th>Returns to</th><th>Connected</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>
          {grants.data?.map((g) => (
            <tr key={g.id} className={g.revokedAt ? 'dim' : undefined}>
              <td className="strong">{g.clientName} {g.verified ? <Badge tone="green" title={g.clientId}>metadata URL</Badge> : <Badge tone="amber" title="Self-registered (dynamic client registration): the name is not verified">self-registered</Badge>}</td>
              {all && <td>{g.userEmail}</td>}
              <td><code>{g.redirectHost}</code></td>
              <td><Time iso={g.createdAt} /></td>
              <td>{g.lastUsedAt ? <Time iso={g.lastUsedAt} relative /> : <span className="muted">never</span>}</td>
              <td>{g.revokedAt ? <Badge tone="grey">Revoked</Badge> : <Badge tone="green">Active</Badge>}</td>
              <td className="actions">{!g.revokedAt && (
                <button className="btn btn-small btn-danger" disabled={revoke.isPending}
                  onClick={() => { if (confirm(`Disconnect ${g.clientName}? It must sign in again.`)) revoke.mutate(g.id); }}>Revoke</button>
              )}</td>
            </tr>
          ))}
          {grants.data?.length === 0 && <tr><td colSpan={7} className="empty">No apps connected with OAuth.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
