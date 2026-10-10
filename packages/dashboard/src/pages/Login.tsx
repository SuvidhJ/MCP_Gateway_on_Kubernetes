import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type Me } from '../api';
import { ErrorText } from '../ui';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<Me>('/api/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: onLogin,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Urumi <span>MCP Gateway</span></h1>
        <p className="muted">Sign in to manage upstream servers, members, API keys and the audit log.</p>
        <label>
          Email
          <input type="email" autoComplete="username" required autoFocus value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorText error={login.error} />
        <button className="btn btn-primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
