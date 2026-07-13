import { useEffect, useMemo, useState } from 'react';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { Lightbox } from '../components/Lightbox';
import { Thumb } from '../components/PhotoGrid';
import { EmptyState, Spinner } from '../components/ui';
import { useAppState } from '../state';
import { ageLabel, formatDate } from '../util';

export default function Milestones() {
  const { children } = useAppState();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = () =>
    api<{ photos: Photo[] }>('/api/photos?milestone=*&pageSize=500').then((res) => setPhotos(res.photos));

  useEffect(() => {
    void load();
  }, []);

  const byChild = useMemo(() => {
    if (!photos) return [];
    return children
      .map((child) => {
        const own = photos
          .filter((p) => p.childIds.includes(child.id))
          .sort((a, b) => a.takenAt.localeCompare(b.takenAt)); // age order
        return { child, photos: own };
      })
      .filter((g) => g.photos.length > 0);
  }, [photos, children]);

  if (!photos) return <Spinner label="Loading milestones…" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">Milestones</h1>
      {byChild.length === 0 && (
        <EmptyState
          icon="⭐"
          title="No milestones yet"
          hint='Open a photo and set a milestone like "first steps" or "first tooth" — they collect here in age order.'
        />
      )}
      {byChild.map(({ child, photos: own }) => (
        <section key={child.id}>
          <h2 className="mb-2 text-lg font-bold" style={{ color: child.color }}>
            {child.name}
          </h2>
          <div className="space-y-2">
            {own.map((photo) => (
              <button
                key={photo.id}
                onClick={() => setOpen(photos.indexOf(photo))}
                className="flex w-full items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-2 text-left hover:border-slate-600"
                data-testid="milestone-row"
              >
                <Thumb photo={photo} className="h-16 w-16 shrink-0 rounded-lg" />
                <div>
                  <p className="font-medium text-amber-300">★ {photo.milestone}</p>
                  <p className="text-sm text-slate-400">
                    {ageLabel(child, photo.takenAt) ?? ''} · {formatDate(photo.takenAt)}
                  </p>
                  {photo.caption && <p className="text-sm text-slate-300">{photo.caption}</p>}
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
      {open !== null && (
        <Lightbox
          photos={photos}
          index={open}
          onClose={() => setOpen(null)}
          onNavigate={setOpen}
          onChange={() => void load()}
          onDelete={async (photo) => {
            await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
            setOpen(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
