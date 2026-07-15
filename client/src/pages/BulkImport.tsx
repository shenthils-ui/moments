import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, inputCls } from '../components/ui';
import { useAppState } from '../state';
import { formatDate } from '../util';

interface Job {
  id: string;
  kind: 'scan' | 'import';
  state: 'running' | 'done' | 'error';
  error: string | null;
  total: number;
  processed: number;
  added: number;
  duplicates: number;
  datesFixed: number;
  failed: number;
  failures: { file: string; reason: string }[];
  earliest: string | null;
  latest: string | null;
}

export default function BulkImport() {
  const { children } = useAppState();
  const [sourcePath, setSourcePath] = useState('');
  const [scan, setScan] = useState<Job | null>(null);
  const [run, setRun] = useState<Job | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [fixDates, setFixDates] = useState(false);

  // an only child is selected automatically once children load
  useEffect(() => {
    if (children.length === 1) setSelected((prev) => (prev.length > 0 ? prev : [children[0].id]));
  }, [children]);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = (jobId: string, set: (job: Job) => void) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await api<Job>(`/api/import/jobs/${jobId}`);
        set(job);
        if (job.state !== 'running' && pollRef.current) clearInterval(pollRef.current);
      } catch {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 500);
  };

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const startScan = async () => {
    setError('');
    setScan(null);
    setRun(null);
    try {
      const job = await api<Job>('/api/import/scan', { method: 'POST', body: JSON.stringify({ sourcePath }) });
      setScan(job);
      poll(job.id, setScan);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startRun = async () => {
    setError('');
    try {
      const job = await api<Job>('/api/import/run', {
        method: 'POST',
        body: JSON.stringify({ sourcePath, childIds: selected, mode, fixDates }),
      });
      setRun(job);
      poll(job.id, setRun);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleChild = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Bulk import</h1>
      <p className="text-sm text-slate-400">
        Import years of old photos (e.g. a Peekaboo Moments or TimeHut export) from a folder that is already on the server's disk. A dry run first shows what would happen; nothing is written until you confirm.
      </p>

      <Card title="1 · Source folder on the server">
        <Field label="Folder path (as the server sees it)">
          <input
            data-testid="source-path"
            className={inputCls}
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="D:\exports\timehut  or  /volume1/exports"
          />
        </Field>
        <div className="mt-3">
          <Button onClick={() => void startScan()} disabled={!sourcePath || scan?.state === 'running'}>
            {scan?.state === 'running' ? 'Scanning…' : 'Dry run'}
          </Button>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </Card>

      {scan && (
        <Card title="2 · Dry-run result">
          {scan.state === 'running' && <Progress job={scan} label="Scanning" />}
          {scan.state === 'error' && <p className="text-sm text-red-400">{scan.error}</p>}
          {scan.state === 'done' && (
            <div className="space-y-1 text-sm text-slate-200" data-testid="scan-result">
              <p>
                <strong>{scan.total}</strong> images found
                {scan.duplicates > 0 && (
                  <>
                    {' '}· <strong>{scan.duplicates}</strong> already in the library or duplicated (will be skipped)
                  </>
                )}
              </p>
              {scan.earliest && scan.latest && (
                <p className="text-slate-400">
                  Dates from {formatDate(scan.earliest)} to {formatDate(scan.latest)}
                </p>
              )}
              {scan.failed > 0 && <p className="text-amber-400">{scan.failed} unreadable files will be skipped.</p>}
            </div>
          )}
        </Card>
      )}

      {scan?.state === 'done' && scan.total > 0 && (
        <Card title="3 · Import">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Assign to</p>
          <div className="flex flex-wrap gap-2">
            {children.map((c) => (
              <button
                key={c.id}
                onClick={() => toggleChild(c.id)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium ${selected.includes(c.id) ? 'text-slate-900' : 'text-slate-300'}`}
                style={selected.includes(c.id) ? { background: c.color, borderColor: c.color } : { borderColor: c.color + '66' }}
              >
                {c.name}
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} />
              Copy (source stays untouched — default)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === 'move'} onChange={() => setMode('move')} />
              Move
            </label>
          </div>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-300">
            <input type="checkbox" className="mt-0.5" checked={fixDates} onChange={(e) => setFixDates(e.target.checked)} />
            <span>
              Fix dates of photos already imported
              <span className="block text-xs text-slate-500">
                For files already in the library, correct a guessed date using the date in the file or its filename. Use
                this to repair photos that landed in the wrong month.
              </span>
            </span>
          </label>
          <div className="mt-3">
            <Button onClick={() => void startRun()} disabled={selected.length === 0 || run?.state === 'running'}>
              {run?.state === 'running' ? 'Importing…' : `Import ${scan.total - scan.duplicates} files`}
            </Button>
          </div>
        </Card>
      )}

      {run && (
        <Card title="Import progress">
          {run.state === 'running' && <Progress job={run} label="Importing" />}
          {run.state === 'error' && <p className="text-sm text-red-400">{run.error}</p>}
          {run.state === 'done' && (
            <div className="space-y-1 text-sm text-slate-200" data-testid="import-result">
              <p className="text-emerald-400">
                Done: {run.added} imported, {run.duplicates} duplicates skipped
                {run.datesFixed > 0 && `, ${run.datesFixed} dates fixed`}
                {run.failed > 0 && `, ${run.failed} failed`}.
              </p>
              {run.failures.length > 0 && (
                <ul className="list-inside list-disc text-xs text-amber-400">
                  {run.failures.slice(0, 20).map((f, i) => (
                    <li key={i}>
                      {f.file}: {f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Progress({ job, label }: { job: Job; label: string }) {
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  return (
    <div>
      <p className="mb-1 text-sm text-slate-300">
        {label} {job.processed}/{job.total}…
      </p>
      <div className="h-2 w-full overflow-hidden rounded bg-slate-800">
        <div className="h-full bg-pink-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
