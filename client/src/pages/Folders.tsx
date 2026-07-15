import { useEffect, useMemo, useState } from 'react';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { Lightbox } from '../components/Lightbox';
import { Thumb, VideoOverlay } from '../components/PhotoGrid';
import { EmptyState, Spinner } from '../components/ui';

interface FolderListing {
  path: string;
  dirs: string[];
  files: { name: string; photo: Photo | null }[];
}

export default function Folders() {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError('');
    api<FolderListing>(`/api/folders?path=${encodeURIComponent(path)}`)
      .then(setListing)
      .catch((err) => setError((err as Error).message));
  }, [path, reload]);

  const crumbs = path ? path.split('/') : [];
  const photos = useMemo(() => (listing?.files ?? []).map((f) => f.photo).filter((p): p is Photo => p !== null), [listing]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Folders</h1>
      <p className="text-xs text-slate-500">This is the real folder tree on disk — exactly what a file manager or backup tool sees.</p>

      <nav className="flex flex-wrap items-center gap-1 text-sm">
        <button onClick={() => setPath('')} className="rounded px-2 py-1 font-mono text-pink-400 hover:bg-slate-800">
          photos
        </button>
        {crumbs.map((part, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-slate-600">/</span>
            <button
              onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
              className="rounded px-2 py-1 font-mono text-pink-400 hover:bg-slate-800"
            >
              {part}
            </button>
          </span>
        ))}
      </nav>

      {error && <EmptyState icon="⚠️" title="Folder unavailable" hint={error} />}
      {!listing && !error && <Spinner />}

      {listing && (
        <>
          {listing.dirs.length === 0 && listing.files.length === 0 && (
            <EmptyState icon="🗂️" title="Empty folder" hint="Photos appear here as you upload or import them." />
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {listing.dirs.map((dir) => (
              <button
                key={dir}
                onClick={() => setPath(path ? `${path}/${dir}` : dir)}
                className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-left hover:border-slate-600"
                data-testid="folder-tile"
              >
                <span className="text-2xl">📁</span>
                <span className="truncate text-sm text-slate-200">{dir}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
            {listing.files.map((file) => {
              const idx = file.photo ? photos.indexOf(file.photo) : -1;
              return file.photo ? (
                <button key={file.name} onClick={() => setOpen(idx)} className="relative aspect-square overflow-hidden rounded-md">
                  <Thumb photo={file.photo} className="absolute inset-0 h-full w-full" />
                  {file.photo.kind === 'video' && <VideoOverlay photo={file.photo} />}
                </button>
              ) : (
                <div key={file.name} className="flex aspect-square flex-col items-center justify-center rounded-md bg-slate-800 p-1 text-center">
                  <span className="text-xl">🖼️</span>
                  <span className="break-all text-[9px] text-slate-400">{file.name}</span>
                  <span className="text-[9px] text-amber-400">not indexed</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {open !== null && (
        <Lightbox
          photos={photos}
          index={open}
          onClose={() => setOpen(null)}
          onNavigate={setOpen}
          onChange={() => setReload((n) => n + 1)}
          onDelete={async (photo) => {
            await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
            setOpen(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
