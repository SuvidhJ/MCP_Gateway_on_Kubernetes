import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrf, type Me } from './api';
import { ErrorText, MeContext } from './ui';
import { Login } from './pages/Login';
import { Servers } from './pages/Servers';
import { Members } from './pages/Members';
import { Keys } from './pages/Keys';
import { Audit } from './pages/Audit';
import { Chat, resetChat } from './pages/Chat';
import { Account, ChangePassword } from './pages/Account';
import { Stores } from './pages/Stores';

const PAGES = [
  { id: 'servers', label: 'Servers', Component: Servers },
  { id: 'stores', label: 'Stores', Component: Stores },
  { id: 'members', label: 'Members', Component: Members },
  { id: 'keys', label: 'API keys', Component: Keys },
  { id: 'audit', label: 'Audit log', Component: Audit },
  { id: 'chat', label: 'Chat', Component: Chat },
  { id: 'account', label: 'Account', Component: Account },
] as const;

function useHashRoute(): string {
  const read = () => window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'servers';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>('/api/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function App() {
  const qc = useQueryClient();
  const route = useHashRoute();
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: Infinity });

  if (me.data) setCsrf(me.data.csrf);

  if (me.isPending) return <div className="center muted">Loading…</div>;
  if (me.isError) {
    return (
      <div className="center">
        <ErrorText error={me.error} />
        <button className="btn" onClick={() => void me.refetch()}>Retry</button>
      </div>
    );
  }
  if (!me.data) {
    return (
      <Login
        onLogin={(m) => {
          setCsrf(m.csrf);
          qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
          qc.setQueryData(['me'], m);
        }}
      />
    );
  }

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
    resetChat();
    setCsrf('');
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], null);
  };

  const page = PAGES.find((p) => p.id === route) ?? PAGES[0];
  const { user } = me.data;
  // a temporary (invite/reset) password must be replaced before anything else; the API enforces the same
  if (user.mustChangePassword) {
    return (
      <div className="login-wrap">
        <div>
          <ChangePassword forced onDone={() => qc.setQueryData(['me'], { ...me.data, user: { ...user, mustChangePassword: false } })} />
          <div className="center-row"><button className="btn btn-small" onClick={() => void logout()}>Log out</button></div>
        </div>
      </div>
    );
  }
  return (
    <MeContext.Provider value={me.data}>
      <header className="topbar">
        <div className="brand">Urumi <span>MCP Gateway</span></div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === page.id ? 'active' : undefined}>{p.label}</a>
          ))}
        </nav>
        <div className="whoami">
          <span title={user.name}>{user.email}</span>
          <span className={`role role-${user.role}`}>{user.role}</span>
          <button className="btn btn-small" onClick={() => void logout()}>Log out</button>
        </div>
      </header>
      <main className="page">
        <page.Component />
      </main>
    </MeContext.Provider>
  );
}
