import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { APP_NAME } from '../../../shared/appName';
import type { Child } from '../../../shared/types';
import { api } from '../api';
import { Button, Card, Field, inputCls } from '../components/ui';
import { useAppState } from '../state';
import { formatBytes, formatDate, formatDateTime } from '../util';

interface DiskInfo {
  photosRoot: string;
  dataDir: string;
  freeBytes: number;
  totalBytes: number;
  libraryBytes: number;
  photoCount: number;
  lastSnapshotAt: string | null;
}

export default function Settings() {
  const { status, children, refresh } = useAppState();
  const [disk, setDisk] = useState<DiskInfo | null>(null);

  useEffect(() => {
    void api<DiskInfo>('/api/system/disk').then(setDisk);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Settings</h1>

      <ChildrenSection children={children} refresh={refresh} />

      <Card title="Disk & backup status">
        {disk ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-400">Photo folder</dt>
            <dd className="break-all font-mono text-xs text-emerald-300">{disk.photosRoot}</dd>
            <dt className="text-slate-400">Photos</dt>
            <dd className="text-slate-100">{disk.photoCount}</dd>
            <dt className="text-slate-400">Library size</dt>
            <dd className="text-slate-100">{formatBytes(disk.libraryBytes)}</dd>
            <dt className="text-slate-400">Free disk space</dt>
            <dd className="text-slate-100">{disk.totalBytes > 0 ? `${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)}` : 'unknown'}</dd>
            <dt className="text-slate-400">Last metadata snapshot</dt>
            <dd className="text-slate-100" data-testid="last-snapshot">{disk.lastSnapshotAt ? formatDateTime(disk.lastSnapshotAt) : 'not yet written'}</dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-400">Loading…</p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Back up the photo folder above and you have everything — photos as plain files plus <span className="font-mono">_meta/metadata.json</span> with all captions and children.
        </p>
        <div className="mt-3">
          <Link to="/backup" className="rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-400">
            Backup mirrors (USB / NAS / Google Drive) →
          </Link>
        </div>
      </Card>

      <PasswordSection authEnabled={status?.authEnabled ?? false} refresh={refresh} />
      <ExportImportSection />
      <MaintenanceSection />

      <Card title="About">
        <p className="text-sm text-slate-300">
          {APP_NAME} — a private, self-hosted photo timeline for your family. Photos are plain files on your own disk; this app is only an organizer on top. Nothing ever leaves your network.
        </p>
      </Card>
    </div>
  );
}

function ChildrenSection({ children, refresh }: { children: Child[]; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<Child | 'new' | null>(null);
  const [error, setError] = useState('');

  const remove = async (child: Child) => {
    setError('');
    if (!window.confirm(`Remove ${child.name}? This only works when no photos are assigned.`)) return;
    try {
      await api(`/api/children/${child.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card title="Children">
      <div className="space-y-2">
        {children.map((child) => (
          <div key={child.id} className="flex items-center gap-3 rounded-lg border border-slate-800 p-2">
            <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: child.color }} />
            <div className="flex-1">
              <p className="font-medium text-slate-100">{child.name}</p>
              <p className="text-xs text-slate-400">
                {child.birthDate ? `born ${formatDate(child.birthDate + 'T00:00:00')}` : '⚠ birth date missing — ages can’t be shown'}
              </p>
            </div>
            <Button small kind="secondary" onClick={() => setEditing(child)}>Edit</Button>
            <Button small kind="ghost" onClick={() => void remove(child)}>Remove</Button>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <div className="mt-3">
        <Button small kind="secondary" onClick={() => setEditing('new')}>+ Add child</Button>
      </div>
      {editing && <ChildForm child={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await refresh(); }} onCancel={() => setEditing(null)} />}
    </Card>
  );
}

function ChildForm({ child, onDone, onCancel }: { child: Child | null; onDone: () => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(child?.name ?? '');
  const [birthDate, setBirthDate] = useState(child?.birthDate ?? '');
  const [color, setColor] = useState(child?.color ?? '#38bdf8');
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    try {
      if (child) {
        await api(`/api/children/${child.id}`, { method: 'PATCH', body: JSON.stringify({ name, birthDate, color }) });
      } else {
        await api('/api/children', { method: 'POST', body: JSON.stringify({ name, birthDate, color }) });
      }
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <Field label="Name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Birth date">
        <input type="date" className={inputCls} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      </Field>
      <Field label="Color">
        <input type="color" className="h-10 w-20 cursor-pointer rounded-lg border border-slate-700 bg-slate-800" value={color} onChange={(e) => setColor(e.target.value)} />
      </Field>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button small onClick={() => void save()} disabled={!name || !birthDate}>Save</Button>
        <Button small kind="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function PasswordSection({ authEnabled, refresh }: { authEnabled: boolean; refresh: () => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const apply = async (newPassword: string | null) => {
    setMessage('');
    setError('');
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password: newPassword, currentPassword: current || undefined }),
      });
      setMessage(newPassword ? 'Password set.' : 'Password removed — the app is open on your network again.');
      setCurrent('');
      setNext('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card title="Family password">
      <p className="mb-3 text-sm text-slate-400">
        {authEnabled
          ? 'A password currently protects everything, including photo URLs.'
          : 'No password set — anyone on your home network can view the library.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {authEnabled && (
          <Field label="Current password">
            <input type="password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        )}
        <Field label={authEnabled ? 'New password' : 'Password'}>
          <input type="password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {message && <p className="mt-2 text-sm text-emerald-400">{message}</p>}
      <div className="mt-3 flex gap-2">
        <Button small onClick={() => void apply(next)} disabled={!next}>
          {authEnabled ? 'Change password' : 'Set password'}
        </Button>
        {authEnabled && (
          <Button small kind="danger" onClick={() => void apply(null)}>
            Remove password
          </Button>
        )}
      </div>
    </Card>
  );
}

function ExportImportSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ children: number; photos: number; exportedAt: string | null } | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const pick = async (file: File) => {
    setError('');
    setMessage('');
    try {
      const parsed = JSON.parse(await file.text());
      const res = await api('/api/export/import', { method: 'POST', body: JSON.stringify({ snapshot: parsed }) });
      setSnapshot(parsed);
      setPreview(res);
    } catch (err) {
      setError(err instanceof SyntaxError ? 'That file is not valid JSON.' : (err as Error).message);
    }
  };

  const confirm = async () => {
    setError('');
    try {
      const res = await api('/api/export/import', { method: 'POST', body: JSON.stringify({ snapshot, confirm: true }) });
      setMessage(`Imported: ${res.photos} photos, ${res.children} children.${res.missingFiles.length > 0 ? ` ${res.missingFiles.length} files missing on disk.` : ''}`);
      setPreview(null);
      setSnapshot(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card title="Export / import metadata">
      <p className="mb-3 text-sm text-slate-400">
        The export is a single JSON file with all children, captions, tags and milestones. Importing replaces ALL current metadata (photos on disk are never touched).
      </p>
      <div className="flex flex-wrap gap-2">
        <a href="/api/export/metadata" download className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
          Download metadata JSON
        </a>
        <a href="/api/export/zip" className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
          Download all originals (ZIP)
        </a>
        <Button small kind="secondary" onClick={() => fileRef.current?.click()}>
          Import metadata JSON…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = '';
          }}
        />
      </div>
      {preview && (
        <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
          <p>
            This file contains {preview.photos} photos and {preview.children} children
            {preview.exportedAt ? `, exported ${formatDateTime(preview.exportedAt)}` : ''}. Importing replaces everything currently in the app.
          </p>
          <div className="mt-2 flex gap-2">
            <Button small kind="danger" onClick={() => void confirm()}>Replace all metadata</Button>
            <Button small kind="secondary" onClick={() => { setPreview(null); setSnapshot(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {message && <p className="mt-2 text-sm text-emerald-400">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </Card>
  );
}

function MaintenanceSection() {
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  const rebuild = async () => {
    if (!window.confirm('Rebuild the index by scanning the photo folder? Existing metadata stays; missing photos are re-added from files.')) return;
    setBusy(true);
    setResult('');
    try {
      const res = await api('/api/system/rebuild', { method: 'POST', body: JSON.stringify({}) });
      setResult(`Scanned ${res.scanned} files: ${res.added} added, ${res.alreadyIndexed} already indexed${res.childrenCreated.length > 0 ? `, new children: ${res.childrenCreated.join(', ')}` : ''}${res.errors.length > 0 ? `, ${res.errors.length} errors` : ''}.`);
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Maintenance">
      <div className="flex flex-wrap items-center gap-2">
        <Button small kind="secondary" onClick={() => void rebuild()} disabled={busy}>
          {busy ? 'Rebuilding…' : 'Rebuild index from folders'}
        </Button>
        <Link to="/trash" className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
          Open trash
        </Link>
        <Link to="/folders" className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
          Browse folders on disk
        </Link>
        <Link to="/import" className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
          Bulk import
        </Link>
      </div>
      {result && <p className="mt-2 text-sm text-slate-300" data-testid="rebuild-result">{result}</p>}
    </Card>
  );
}
