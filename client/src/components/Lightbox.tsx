import { useEffect, useRef, useState } from 'react';
import type { Photo } from '../../../shared/types';
import { api, downloadUrl, originalUrl, thumbUrl } from '../api';
import { useAppState } from '../state';
import { ageLabel, formatDateTime, toLocalInput } from '../util';
import { Button, Field, inputCls } from './ui';

interface Props {
  photos: Photo[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onChange: (photo: Photo) => void; // metadata edited
  onDelete: (photo: Photo) => void; // moved to trash
}

export function Lightbox({ photos, index, onClose, onNavigate, onChange, onDelete }: Props) {
  const photo = photos[index];
  const { children } = useAppState();
  const [editing, setEditing] = useState(false);
  const [fullRes, setFullRes] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failed, setFailed] = useState(false);
  const touchStart = useRef<number | null>(null);

  useEffect(() => {
    setEditing(false);
    setFullRes(false);
    setConfirmDelete(false);
    setFailed(false);
  }, [photo?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && index < photos.length - 1) onNavigate(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, photos.length, onClose, onNavigate]);

  if (!photo) return null;
  const owners = children.filter((c) => photo.childIds.includes(c.id));
  const isVideo = photo.kind === 'video';
  // GIFs only animate from the original, not the static poster thumbnail.
  const isGif = photo.mimeType === 'image/gif';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95" data-testid="lightbox">
      <div className="flex items-center justify-between p-3">
        <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
          ✕ Close
        </button>
        <div className="flex gap-2">
          <button
            onClick={async () => onChange(await api<Photo>(`/api/photos/${photo.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !photo.favorite }) }))}
            className={`rounded-lg px-3 py-1.5 text-sm hover:bg-slate-800 ${photo.favorite ? 'text-pink-400' : 'text-slate-300'}`}
            aria-label={photo.favorite ? 'Remove favorite' : 'Add favorite'}
            title={photo.favorite ? 'Favorited' : 'Mark as favorite'}
            data-testid="favorite-toggle"
          >
            {photo.favorite ? '♥' : '♡'}
          </button>
          {!fullRes && !isVideo && !isGif && (
            <Button small kind="secondary" onClick={() => setFullRes(true)}>
              Full resolution
            </Button>
          )}
          <a href={downloadUrl(photo.id)} className="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600">
            Download
          </a>
          <Button small kind="secondary" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Hide details' : 'Edit'}
          </Button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onTouchStart={(e) => (touchStart.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchStart.current === null) return;
          const dx = e.changedTouches[0].clientX - touchStart.current;
          if (dx > 60 && index > 0) onNavigate(index - 1);
          if (dx < -60 && index < photos.length - 1) onNavigate(index + 1);
          touchStart.current = null;
        }}
      >
        {index > 0 && (
          <button aria-label="Previous photo" onClick={() => onNavigate(index - 1)} className="absolute left-2 z-10 rounded-full bg-black/50 p-3 text-xl text-white">
            ‹
          </button>
        )}
        {failed ? (
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <span className="text-6xl">{isVideo ? '🎬' : '🖼️'}</span>
            <p className="text-sm">
              {isVideo ? "This video's format can't play in the browser" : 'No preview available for this file'} (
              {photo.filename.split('.').pop()?.toUpperCase()}).
            </p>
            <p className="text-xs">The original is safe on disk — use Download to view it elsewhere.</p>
          </div>
        ) : isVideo ? (
          <video
            key={photo.id}
            src={originalUrl(photo.id)}
            poster={thumbUrl(photo.id, 1024)}
            controls
            autoPlay
            playsInline
            onError={() => setFailed(true)}
            className="max-h-full max-w-full"
            data-testid="lightbox-video"
          />
        ) : (
          <img
            key={fullRes ? 'full' : 'fit'}
            src={fullRes || isGif ? originalUrl(photo.id) : thumbUrl(photo.id, 1024)}
            alt={photo.caption || photo.filename}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain"
          />
        )}
        {index < photos.length - 1 && (
          <button aria-label="Next photo" onClick={() => onNavigate(index + 1)} className="absolute right-2 z-10 rounded-full bg-black/50 p-3 text-xl text-white">
            ›
          </button>
        )}
      </div>

      <div className="max-h-[45%] overflow-y-auto border-t border-slate-800 bg-slate-900 p-4">
        {!editing ? (
          <div className="mx-auto max-w-xl space-y-1 text-sm text-slate-300">
            {photo.caption && <p className="text-base text-slate-100">{photo.caption}</p>}
            <p>
              {formatDateTime(photo.takenAt)}
              {owners.map((c) => {
                const age = ageLabel(c, photo.takenAt);
                return (
                  <span key={c.id} className="ml-2 rounded-full px-2 py-0.5 text-xs" style={{ background: c.color + '33', color: c.color }}>
                    {c.name}
                    {age ? `, ${age}` : ''}
                  </span>
                );
              })}
            </p>
            {photo.takenAtSource === 'file' && (
              <p className="text-xs text-amber-400" data-testid="guessed-date">
                ⚠ Date guessed from the file — this photo had no date info. Tap <strong>Edit</strong> to correct it.
              </p>
            )}
            {photo.milestone && <p className="text-amber-300">★ {photo.milestone}</p>}
            {photo.tags.length > 0 && <p className="text-slate-400">{photo.tags.map((t) => `#${t}`).join(' ')}</p>}
            <p className="break-all font-mono text-xs text-slate-500" data-testid="photo-path">
              {photo.relPath}
            </p>
          </div>
        ) : (
          <EditForm photo={photo} onSaved={onChange} onDelete={() => setConfirmDelete(true)} />
        )}
        {confirmDelete && (
          <div className="mx-auto mt-3 max-w-xl rounded-lg border border-red-800 bg-red-950/60 p-3 text-sm text-red-200">
            <p className="mb-2">Move this photo to trash? It stays recoverable for 30 days.</p>
            <div className="flex gap-2">
              <Button small kind="danger" onClick={() => onDelete(photo)}>
                Move to trash
              </Button>
              <Button small kind="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EditForm({ photo, onSaved, onDelete }: { photo: Photo; onSaved: (p: Photo) => void; onDelete: () => void }) {
  const [caption, setCaption] = useState(photo.caption);
  const [tags, setTags] = useState(photo.tags.join(', '));
  const [milestone, setMilestone] = useState(photo.milestone ?? '');
  const [takenAt, setTakenAt] = useState(toLocalInput(photo.takenAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const updated = await api<Photo>(`/api/photos/${photo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          caption,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          milestone: milestone.trim() || null,
          ...(toLocalInput(photo.takenAt) !== takenAt ? { takenAt: new Date(takenAt).toISOString() } : {}),
        }),
      });
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-3">
      <Field label="Caption">
        <input data-testid="caption-input" className={inputCls} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Say something about this moment…" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tags (comma separated)">
          <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="beach, grandma" />
        </Field>
        <Field label="Milestone">
          <input className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="first steps" />
        </Field>
      </div>
      <Field label="Taken at">
        <input type="datetime-local" className={inputCls} value={takenAt} onChange={(e) => setTakenAt(e.target.value)} />
      </Field>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center justify-between">
        <Button small onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button small kind="danger" onClick={onDelete}>
          Delete…
        </Button>
      </div>
      <p className="text-xs text-slate-500">Changing the date updates the timeline only — the file on disk is never renamed or moved.</p>
    </div>
  );
}
