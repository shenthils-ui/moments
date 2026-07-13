import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state';
import { Button, Card, EmptyState, Field, inputCls } from '../components/ui';

type FileState = 'queued' | 'uploading' | 'added' | 'duplicate' | 'error';

interface QueuedFile {
  file: File;
  preview: string;
  state: FileState;
  progress: number;
  reason?: string;
}

export default function Upload() {
  const { children } = useAppState();
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [caption, setCaption] = useState('');

  // an only child is selected automatically once children load
  useEffect(() => {
    if (children.length === 1) setSelected((prev) => (prev.length > 0 ? prev : [children[0].id]));
  }, [children]);
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[]) => {
    const accepted = [...files].filter((f) => /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    setQueue((prev) => [
      ...prev,
      ...accepted.map((file) => ({ file, preview: URL.createObjectURL(file), state: 'queued' as FileState, progress: 0 })),
    ]);
  };

  const toggleChild = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const setItem = (index: number, patch: Partial<QueuedFile>) =>
    setQueue((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  /** One request per file so each gets its own progress bar and retry. */
  const uploadOne = (index: number, item: QueuedFile) =>
    new Promise<void>((resolve) => {
      const form = new FormData();
      form.append('childIds', JSON.stringify(selected));
      form.append('caption', caption);
      form.append('tags', JSON.stringify(tags.split(',').map((t) => t.trim()).filter(Boolean)));
      form.append('lastModified', JSON.stringify({ [item.file.name]: item.file.lastModified }));
      form.append('files', item.file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setItem(index, { progress: Math.round((e.loaded / e.total) * 100) });
      };
      xhr.onload = () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status !== 200) {
            setItem(index, { state: 'error', reason: body.error ?? `upload failed (${xhr.status})` });
          } else {
            const result = body.results[0];
            setItem(index, {
              state: result.outcome,
              reason: result.outcome === 'duplicate' ? 'already in the library' : result.reason,
            });
          }
        } catch {
          setItem(index, { state: 'error', reason: 'unexpected server response' });
        }
        resolve();
      };
      xhr.onerror = () => {
        setItem(index, { state: 'error', reason: "can't reach the server" });
        resolve();
      };
      setItem(index, { state: 'uploading', progress: 0 });
      xhr.send(form);
    });

  const start = async () => {
    setBusy(true);
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].state === 'queued' || queue[i].state === 'error') {
        await uploadOne(i, queue[i]);
      }
    }
    setBusy(false);
  };

  const retry = (index: number) => void uploadOne(index, queue[index]);

  const pending = queue.filter((q) => q.state === 'queued' || q.state === 'error').length;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Upload</h1>

      <Card title="Who is in these photos?">
        <div className="flex flex-wrap gap-2">
          {children.map((c) => (
            <button
              key={c.id}
              onClick={() => toggleChild(c.id)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                selected.includes(c.id) ? 'text-slate-900' : 'text-slate-300'
              }`}
              style={selected.includes(c.id) ? { background: c.color, borderColor: c.color } : { borderColor: c.color + '66' }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Caption for this batch (optional)">
            <input className={inputCls} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </Field>
          <Field label="Tags (optional, comma separated)">
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
      </Card>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
        className="cursor-pointer rounded-2xl border-2 border-dashed border-slate-700 p-8 text-center hover:border-pink-400"
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic"
          className="hidden"
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="text-3xl">📸</p>
        <p className="mt-1 text-sm text-slate-300">Tap to choose photos, or drop them here</p>
        <p className="text-xs text-slate-500">JPEG, PNG, WebP and HEIC</p>
      </div>

      {queue.length === 0 && <EmptyState icon="🪄" title="Nothing queued yet" hint="Photos you pick will show up here with previews before anything is uploaded." />}

      {queue.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
            {queue.map((item, i) => (
              <div key={i} className="relative overflow-hidden rounded-lg" data-testid="upload-item">
                <img src={item.preview} alt={item.file.name} className="aspect-square w-full bg-slate-800 object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-black/70 p-1 text-center text-[10px]">
                  {item.state === 'queued' && <span className="text-slate-300">ready</span>}
                  {item.state === 'uploading' && (
                    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-700">
                      <div className="h-full bg-pink-400 transition-all" style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                  {item.state === 'added' && <span className="text-emerald-400">✓ added</span>}
                  {item.state === 'duplicate' && <span className="text-amber-400">≡ duplicate</span>}
                  {item.state === 'error' && (
                    <button onClick={() => retry(i)} className="text-red-400 underline" title={item.reason}>
                      ✕ retry
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {queue.some((q) => q.state === 'error') && (
            <p className="text-xs text-red-400">
              {queue.filter((q) => q.state === 'error').map((q, i) => `${q.file.name}: ${q.reason}`).join(' · ')}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={() => void start()} disabled={busy || selected.length === 0 || pending === 0}>
              {busy ? 'Uploading…' : `Upload ${pending} photo${pending === 1 ? '' : 's'}`}
            </Button>
            {selected.length === 0 && <p className="text-sm text-amber-400">Select at least one child first.</p>}
            <Button kind="ghost" onClick={() => setQueue([])} disabled={busy}>
              Clear
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
