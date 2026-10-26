import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Member, type Role } from '../api';
import { Badge, CopyButton, ErrorText, Time, useAction, useIsAdmin, useMe } from '../ui';

const MEMBERS = ['members'];

export function Members() {
  const admin = useIsAdmin();
  const me = useMe();
  const [inviting, setInviting] = useState(false);
  const [created, setCreated] = useState<{ member: Member; password: string } | null>(null);
  const members = useQuery({ queryKey: MEMBERS, queryFn: () => api<Member[]>('/api/members') });

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Team members</h2>
          <p className="muted">Admins manage servers and members; members use the gateway with their own API keys.</p>
        </div>
        {admin && !inviting && (
          <button className="btn btn-primary" onClick={() => { setInviting(true); setCreated(null); }}>Invite member</button>
        )}
      </div>
      {inviting && (
        <InviteForm onDone={(r) => { setInviting(false); if (r) setCreated(r); }} />
      )}
      {created && (
        <div className="card secret-box">
          <div className="secret-head">
            <strong>{created.member.email}</strong> ({created.member.role}): share this temporary password now; it is
            shown only once and must be changed at first sign-in.
          </div>
          <div className="secret-line">
            <code className="secret">{created.password}</code>
            <CopyButton text={created.password} />
          </div>
          <button className="btn btn-small" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}
      <ErrorText error={members.error} />
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th>
              {admin && <th className="actions">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.data?.map((m) => <MemberRow key={m.id} m={m} admin={admin} self={m.id === me.user.id}
              onReset={(r) => setCreated(r)} />)}
            {members.isPending && <tr><td colSpan={6} className="empty">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MemberRow({ m, admin, self, onReset }: { m: Member; admin: boolean; self: boolean; onReset: (r: { member: Member; password: string }) => void }) {
  const patch = useAction((body: Partial<Member>) => api(`/api/members/${m.id}`, { method: 'PATCH', body }), [MEMBERS, ['keys']]);
  const del = useAction(() => api(`/api/members/${m.id}`, { method: 'DELETE' }), [MEMBERS, ['keys']]);
  const reset = useAction(() => api<{ member: Member; password: string }>(`/api/members/${m.id}/reset-password`, { method: 'POST' }), [MEMBERS], onReset);
  const selfTitle = self ? 'You cannot change your own account here' : undefined;
  return (
    <>
      <tr className={m.disabled ? 'dim' : undefined}>
        <td className="strong">{m.name}{self && <span className="sub"> (you)</span>}</td>
        <td>{m.email}</td>
        <td>
          {admin && !self ? (
            <select value={m.role} disabled={patch.isPending}
              onChange={(e) => patch.mutate({ role: e.target.value as Role })}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          ) : (
            <span className={`role role-${m.role}`}>{m.role}</span>
          )}
        </td>
        <td>{m.disabled ? <Badge tone="grey">Disabled</Badge> : <Badge tone="green">Active</Badge>}</td>
        <td><Time iso={m.createdAt} /></td>
        {admin && (
          <td className="actions">
            <button className="btn btn-small" disabled={self || patch.isPending} title={selfTitle}
              onClick={() => {
                if (m.disabled || confirm(`Disable ${m.email}? This also revokes all of their API keys.`)) {
                  patch.mutate({ disabled: !m.disabled });
                }
              }}>
              {m.disabled ? 'Enable' : 'Disable'}
            </button>
            <button className="btn btn-small" disabled={self || reset.isPending} title={selfTitle ?? 'Issue a new temporary password and sign them out'}
              onClick={() => { if (confirm(`Reset the password of ${m.email}? They are signed out and must use the new temporary password.`)) reset.mutate(undefined); }}>
              Reset password
            </button>
            <button className="btn btn-small btn-danger" disabled={self || del.isPending} title={selfTitle}
              onClick={() => { if (confirm(`Delete ${m.email}? This cannot be undone.`)) del.mutate(); }}>
              Delete
            </button>
          </td>
        )}
      </tr>
      {(patch.error || del.error || reset.error) && (
        <tr><td colSpan={6}><ErrorText error={patch.error ?? del.error ?? reset.error} /></td></tr>
      )}
    </>
  );
}

function InviteForm({ onDone }: { onDone: (r: { member: Member; password: string } | null) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const invite = useAction(
    () => api<{ member: Member; password: string }>('/api/members', { method: 'POST', body: { email, name, role } }),
    [MEMBERS],
    onDone,
  );
  const submit = (e: FormEvent) => { e.preventDefault(); invite.mutate(undefined); };
  return (
    <form className="card form" onSubmit={submit}>
      <h3>Invite a team member</h3>
      <div className="grid">
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      <ErrorText error={invite.error} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={invite.isPending}>Create member</button>
        <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}
