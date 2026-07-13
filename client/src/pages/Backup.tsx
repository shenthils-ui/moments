import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, EmptyState, Field, Spinner, inputCls } from '../components/ui';
import { formatDateTime } from '../util';

interface Run {
  id: string;
  state: 'running' | 'done' | 'error' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  processed: number;
  uploaded: number;
  skipped: number;
  deleted: number;
  failed: number;
  error: string | null;
  failures: { relPath: string; reason: string }[];
}

interface Target {
  id: string;
  kind: 'local' | 'gdrive';
  displayName: string;
  config: { path?: string };
  schedule: { mode: 'manual' | 'hourly' | 'daily'; at?: string };
  mirrorDeletions: boolean;
  connected: boolean;
  activeRun: Run | null;
  lastRun: Run | null;
  fileCount: number;
}

export default function Backup() {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [params] = useSearchParams();
  const [banner, setBanner] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const list = await api<Target[]>('/api/backup/targets');
    setTargets(list);
    const anyRunning = list.some((t) => t.activeRun);
    if (anyRunning && !timer.current) {
      timer.current = setInterval(() => void load(), 1000);
    } else if (!anyRunning && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    if (params.get('connected')) setBanner('Google Drive connected ✓');
    const err = params.get('connect_error');
    if (err) setBanner(`Google Drive connection failed: ${err}`);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load, params]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-100">Backup</h1>
        <Link to="/settings" className="text-sm text-pink-400 hover:underline">← Settings</Link>
      </div>
      <p className="text-sm text-slate-400">
        One-way mirrors of your photo folder. Your local disk stays the single source of truth; a backup run only ever copies local → target and never deletes there unless you explicitly enable it per target.
      </p>
      {banner && <p className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm text-slate-200">{banner}</p>}

      {!targets && <Spinner />}
      {targets && targets.length === 0 && (
        <EmptyState icon="🛟" title="No backup targets yet" hint="Add an external disk / NAS folder, or connect Google Drive." />
      )}
      {targets?.map((target) => (
        <TargetCard key={target.id} target={target} reload={load} />
      ))}

      <AddTarget onAdded={load} />
    </div>
  );
}

function TargetCard({ target, reload }: { target: Target; reload: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<null | { sampled: number; ok: number; missing: { relPath: string }[] }>(null);
  const [verifying, setVerifying] = useState(false);
  const [showFailures, setShowFailures] = useState(false);
  const run = target.activeRun ?? null;
  const last = target.lastRun;

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const patch = (body: Record<string, unknown>) =>
    act(() => api(`/api/backup/targets/${target.id}`, { method: 'PATCH', body: JSON.stringify(body) }));

  const doVerify = async () => {
    setVerifying(true);
    setError('');
    try {
      setVerify(await api(`/api/backup/targets/${target.id}/verify`, { method: 'POST', body: JSON.stringify({ sampleRate: 0.01 }) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVerifying(false);
    }
  };

  const connectDrive = async () => {
    setError('');
    try {
      const { url } = await api<{ url: string }>(`/api/backup/gdrive/auth-url?targetId=${target.id}`);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl">{target.kind === 'local' ? '💽' : '☁️'}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-100">{target.displayName}</p>
          <p className="truncate font-mono text-xs text-slate-500">
            {target.kind === 'local' ? target.config.path : 'Google Drive (drive.file scope)'}
          </p>
        </div>
        {target.connected ? (
          <span className="rounded-full bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300">connected</span>
        ) : target.kind === 'gdrive' ? (
          <Button small onClick={() => void connectDrive()}>Connect / reconnect</Button>
        ) : (
          <span className="rounded-full bg-red-900/60 px-2 py-0.5 text-xs text-red-300" title="folder not reachable/writable">unreachable</span>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Schedule">
          <select
            className={inputCls}
            value={target.schedule.mode}
            onChange={(e) =>
              void patch({ schedule: e.target.value === 'daily' ? { mode: 'daily', at: target.schedule.at ?? '03:00' } : { mode: e.target.value } })
            }
          >
            <option value="manual">Manual only</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily at…</option>
          </select>
        </Field>
        {target.schedule.mode === 'daily' && (
          <Field label="Time">
            <input
              type="time"
              className={inputCls}
              value={target.schedule.at ?? '03:00'}
              onChange={(e) => void patch({ schedule: { mode: 'daily', at: e.target.value } })}
            />
          </Field>
        )}
        <Field label="Mirror deletions">
          <label className="flex h-9 items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={target.mirrorDeletions}
              onChange={(e) => void patch({ mirrorDeletions: e.target.checked })}
            />
            delete at target after trash expiry
          </label>
        </Field>
      </div>

      {run && (
        <div className="mt-3" data-testid="backup-progress">
          <p className="mb-1 text-sm text-slate-300">
            Backing up… {run.processed}/{run.total} files ({run.uploaded} uploaded)
          </p>
          <div className="h-2 w-full overflow-hidden rounded bg-slate-800">
            <div
              className="h-full bg-pink-400 transition-all"
              style={{ width: `${run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {!run && last && (
        <div className="mt-3 text-sm" data-testid="last-run">
          <p className={last.state === 'done' && last.failed === 0 ? 'text-emerald-400' : 'text-amber-400'}>
            Last run {formatDateTime(last.startedAt)}: {last.state}
            {last.state !== 'error' && (
              <> — {last.uploaded} uploaded, {last.skipped} already present{last.deleted > 0 && `, ${last.deleted} deleted`}{last.failed > 0 && `, ${last.failed} FAILED`}</>
            )}
            {last.error && <> — {last.error}</>}
          </p>
          {last.failures.length > 0 && (
            <button className="text-xs text-pink-400 underline" onClick={() => setShowFailures((v) => !v)}>
              {showFailures ? 'hide' : 'show'} failure list ({last.failures.length})
            </button>
          )}
          {showFailures && (
            <ul className="mt-1 list-inside list-disc text-xs text-amber-400">
              {last.failures.map((f, i) => (
                <li key={i} className="break-all">{f.relPath}: {f.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {verify && (
        <p className="mt-2 text-sm" data-testid="verify-result">
          {verify.missing.length === 0 ? (
            <span className="text-emerald-400">Verified {verify.sampled} sampled files — no drift.</span>
          ) : (
            <span className="text-red-400">
              Drift detected: {verify.missing.length} of {verify.sampled} sampled files missing or corrupted at the target. Run a backup to heal.
            </span>
          )}
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button small onClick={() => void act(() => api(`/api/backup/targets/${target.id}/run`, { method: 'POST', body: JSON.stringify({}) }))} disabled={Boolean(run)}>
          {run ? 'Running…' : 'Back up now'}
        </Button>
        <Button small kind="secondary" onClick={() => void doVerify()} disabled={verifying || target.fileCount === 0}>
          {verifying ? 'Verifying…' : 'Verify backup (1% sample)'}
        </Button>
        <Button
          small
          kind="ghost"
          onClick={() => {
            if (window.confirm('Remove this backup target? Files already at the target are NOT touched.')) {
              void act(() => api(`/api/backup/targets/${target.id}`, { method: 'DELETE' }));
            }
          }}
        >
          Remove
        </Button>
      </div>
    </Card>
  );
}

function AddTarget({ onAdded }: { onAdded: () => Promise<void> }) {
  const [kind, setKind] = useState<'local' | 'gdrive' | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [clientIdSet, setClientIdSet] = useState(true);

  useEffect(() => {
    void api<{ clientIdSet: boolean }>('/api/backup/gdrive/status').then((s) => setClientIdSet(s.clientIdSet));
  }, []);

  const add = async (body: Record<string, unknown>) => {
    setError('');
    try {
      await api('/api/backup/targets', { method: 'POST', body: JSON.stringify(body) });
      setKind(null);
      setFolderPath('');
      setName('');
      await onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card title="Add a backup target">
      <div className="flex gap-2">
        <Button small kind={kind === 'local' ? 'primary' : 'secondary'} onClick={() => setKind('local')}>
          💽 Local folder / USB / NAS share
        </Button>
        <Button small kind={kind === 'gdrive' ? 'primary' : 'secondary'} onClick={() => setKind('gdrive')}>
          ☁️ Google Drive
        </Button>
      </div>

      {kind === 'local' && (
        <div className="mt-3 space-y-3">
          <Field label="Folder path (as the server sees it)">
            <input data-testid="backup-path" className={inputCls} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="E:\MomentsBackup  or  /mnt/usb/moments" />
          </Field>
          <Field label="Name (optional)">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="USB disk" />
          </Field>
          <Button small onClick={() => void add({ kind: 'local', displayName: name, config: { path: folderPath } })} disabled={!folderPath}>
            Add folder target
          </Button>
        </div>
      )}

      {kind === 'gdrive' && (
        <div className="mt-3 space-y-3">
          {!clientIdSet && (
            <p className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
              The server has no <span className="font-mono">GOOGLE_CLIENT_ID</span> configured. Follow the README's "Google Drive backup" section to create an OAuth client, then restart with the env var set.
            </p>
          )}
          <p className="text-sm text-slate-400">
            Uses the minimal <span className="font-mono">drive.file</span> permission: the app can only see files it uploaded itself. After adding, press "Connect" to grant access in your browser.
          </p>
          <Button small onClick={() => void add({ kind: 'gdrive', displayName: name || 'Google Drive' })} disabled={!clientIdSet}>
            Add Google Drive target
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </Card>
  );
}
