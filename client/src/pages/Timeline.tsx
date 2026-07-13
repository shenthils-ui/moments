import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { ChildChips } from '../components/ChildChips';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { Button, EmptyState, Spinner } from '../components/ui';
import { useAppState } from '../state';
import { ageLabel, monthTitle } from '../util';

const PAGE_SIZE = 100;

export default function Timeline() {
  const { children } = useAppState();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [child, setChild] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (pageNum: number, childFilter: string | null) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ page: String(pageNum), pageSize: String(PAGE_SIZE) });
        if (childFilter) q.set('child', childFilter);
        const res = await api<{ total: number; photos: Photo[] }>(`/api/photos?${q}`);
        setTotal(res.total);
        setPhotos((prev) => (pageNum === 1 ? res.photos : [...prev, ...res.photos]));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setPage(1);
    void load(1, child);
  }, [child, load]);

  // infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && total !== null && photos.length < total) {
        const next = page + 1;
        setPage(next);
        void load(next, child);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, total, photos.length, page, child, load]);

  const groups = useMemo(() => {
    const map = new Map<string, Photo[]>();
    for (const photo of photos) {
      const key = photo.takenAt.slice(0, 7);
      const list = map.get(key) ?? [];
      list.push(photo);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [photos]);

  const relevantChildren = child ? children.filter((c) => c.id === child) : children;

  const patchPhoto = (updated: Photo) => setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  const removePhoto = async (photo: Photo) => {
    await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setTotal((t) => (t === null ? t : t - 1));
    setOpen(null);
  };

  if (!loading && total === 0) {
    return (
      <div className="space-y-4">
        <Header child={child} setChild={setChild} />
        <EmptyState
          icon="🌱"
          title="No photos yet"
          hint="Upload your first photos, or bulk-import an old Peekaboo/TimeHut export."
          action={
            <div className="flex gap-2">
              <Link to="/upload"><Button>Upload</Button></Link>
              <Link to="/import"><Button kind="secondary">Bulk import</Button></Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header child={child} setChild={setChild} />
      {groups.map(([month, monthPhotos]) => {
        // Age labels are computed at the moment of the newest photo in the group.
        const at = monthPhotos[0].takenAt;
        return (
          <section key={month} data-testid="month-group">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h2 className="text-lg font-bold text-slate-100">{monthTitle(month)}</h2>
              {relevantChildren.map((c) => {
                const age = ageLabel(c, at);
                if (!age) return null;
                return (
                  <span key={c.id} data-testid="age-label" className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: c.color + '33', color: c.color }}>
                    {c.name}, {age}
                  </span>
                );
              })}
            </div>
            <PhotoGrid photos={monthPhotos} onOpen={(i) => setOpen(photos.indexOf(monthPhotos[i]))} />
          </section>
        );
      })}
      {loading && <Spinner />}
      <div ref={sentinel} className="h-4" />
      {open !== null && (
        <Lightbox
          photos={photos}
          index={open}
          onClose={() => setOpen(null)}
          onNavigate={setOpen}
          onChange={patchPhoto}
          onDelete={(p) => void removePhoto(p)}
        />
      )}
    </div>
  );
}

function Header({ child, setChild }: { child: string | null; setChild: (id: string | null) => void }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold text-slate-100">Timeline</h1>
      <ChildChips selected={child} onSelect={setChild} />
    </div>
  );
}
