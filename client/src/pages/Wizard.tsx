import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_NAME } from '../../../shared/appName';
import { api } from '../api';
import { Button, Card, Field, inputCls } from '../components/ui';
import { useAppState } from '../state';
import { formatDateTime } from '../util';

export default function Wizard() {
  const { status, refresh } = useAppState();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [color, setColor] = useState('#f472b6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState<{ children: number; photos: number; missingFiles: string[] } | null>(null);

  const restore = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api('/api/system/restore', { method: 'POST', body: JSON.stringify({}) });
      setRestored(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (goto: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/api/system/setup', {
        method: 'POST',
        body: JSON.stringify({ password: password || undefined, child: { name, birthDate, color } }),
      });
      await refresh();
      navigate(goto);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (restored) {
    return (
      <Shell>
        <Card>
          <h2 className="mb-2 text-lg font-semibold text-slate-100">Library restored 🎉</h2>
          <p className="text-sm text-slate-300">
            {restored.photos} photos and {restored.children} {restored.children === 1 ? 'child' : 'children'} are back.
          </p>
          {restored.missingFiles.length > 0 && (
            <p className="mt-2 text-sm text-amber-400">
              {restored.missingFiles.length} files referenced in the metadata were not found on disk — check that the photo folder copied completely.
            </p>
          )}
          <div className="mt-4">
            <Button onClick={() => void refresh()}>Open {APP_NAME}</Button>
          </div>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      {step === 0 && (
        <Card>
          <h2 className="mb-2 text-lg font-semibold text-slate-100">Welcome to {APP_NAME}</h2>
          <p className="text-sm text-slate-300">
            Your photos will live as plain files in this folder on the server — browsable and backupable with any tool, no app required:
          </p>
          <p className="my-3 break-all rounded-lg bg-slate-800 p-3 font-mono text-xs text-emerald-300" data-testid="photos-root">
            {status?.photosRoot}
          </p>
          {status?.restoreAvailable && status.restorePreview && (
            <div className="mb-4 rounded-lg border border-emerald-800 bg-emerald-950/50 p-3">
              <p className="text-sm text-emerald-200">
                An existing {APP_NAME} library was found here: {status.restorePreview.photos} photos,{' '}
                {status.restorePreview.children} {status.restorePreview.children === 1 ? 'child' : 'children'}, last saved{' '}
                {formatDateTime(status.restorePreview.exportedAt)}.
              </p>
              <div className="mt-2">
                <Button onClick={restore} disabled={busy}>
                  {busy ? 'Restoring…' : 'Restore this library'}
                </Button>
              </div>
            </div>
          )}
          <Button onClick={() => setStep(1)} kind={status?.restoreAvailable ? 'secondary' : 'primary'}>
            {status?.restoreAvailable ? 'Start fresh instead' : 'Get started'}
          </Button>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </Card>
      )}

      {step === 1 && (
        <Card title="Optional: family password">
          <p className="mb-3 text-sm text-slate-300">
            Leave empty for open access on your home network, or set one password the whole family shares. You can change this later in Settings.
          </p>
          <Field label="Password (optional)">
            <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave empty for no password" />
          </Field>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => setStep(2)}>Continue</Button>
            <Button kind="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Add your first child">
          <div className="space-y-3">
            <Field label="Name">
              <input data-testid="child-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Mila" />
            </Field>
            <Field label="Birth date">
              <input data-testid="child-birthdate" type="date" className={inputCls} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
            </Field>
            <Field label="Color">
              <input type="color" className="h-10 w-20 cursor-pointer rounded-lg border border-slate-700 bg-slate-800" value={color} onChange={(e) => setColor(e.target.value)} />
            </Field>
          </div>
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => void finish('/upload')} disabled={busy || !name || !birthDate}>
              {busy ? 'Setting up…' : 'Finish & upload photos'}
            </Button>
            <Button kind="secondary" onClick={() => void finish('/import')} disabled={busy || !name || !birthDate}>
              Finish & bulk import
            </Button>
            <Button kind="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
          </div>
        </Card>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold text-slate-100">{APP_NAME}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
