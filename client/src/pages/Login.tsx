import { useState } from 'react';
import { APP_NAME } from '../../../shared/appName';
import { api } from '../api';
import { Button, Card, Field, inputCls } from '../components/ui';
import { useAppState } from '../state';

export default function Login() {
  const { refresh, setNeedsLogin } = useAppState();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      setNeedsLogin(false);
      await refresh();
    } catch {
      setError('Wrong password — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold text-slate-100">{APP_NAME}</h1>
        </div>
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Family password">
              <input
                type="password"
                autoFocus
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
