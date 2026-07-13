import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TRASH_RETENTION_DAYS, type Photo } from '../../../shared/types';
import { api } from '../api';
import { Thumb } from '../components/PhotoGrid';
import { Button, EmptyState, Spinner } from '../components/ui';
import { formatDateTime } from '../util';

export default function Trash() {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [error, setError] = useState('');

  const load = () => api<Photo[]>('/api/trash').then(setPhotos).catch((err) => setError((err as Error).message));

  useEffect(() => {
    void load();
  }, []);

  const restore = async (photo: Photo) => {
    await api(`/api/trash/${photo.id}/restore`, { method: 'POST', body: JSON.stringify({}) });
    void load();
  };

  const purge = async (photo: Photo) => {
    if (!window.confirm('Delete this photo permanently? This cannot be undone.')) return;
    await api(`/api/trash/${photo.id}`, { method: 'DELETE' });
    void load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-100">Trash</h1>
        <Link to="/settings" className="text-sm text-pink-400 hover:underline">← Settings</Link>
      </div>
      <p className="text-sm text-slate-400">
        Deleted photos stay here (and in <span className="font-mono">_trash/</span> on disk) for {TRASH_RETENTION_DAYS} days before being removed for good.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!photos && !error && <Spinner />}
      {photos && photos.length === 0 && <EmptyState icon="🗑️" title="Trash is empty" />}
      {photos && photos.length > 0 && (
        <div className="space-y-2">
          {photos.map((photo) => (
            <div key={photo.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-2" data-testid="trash-row">
              <Thumb photo={photo} className="h-16 w-16 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-200">{photo.caption || photo.filename}</p>
                <p className="text-xs text-slate-500">deleted {photo.trashedAt ? formatDateTime(photo.trashedAt) : ''}</p>
              </div>
              <Button small kind="secondary" onClick={() => void restore(photo)}>Restore</Button>
              <Button small kind="danger" onClick={() => void purge(photo)}>Delete forever</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
