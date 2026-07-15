import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { ChildChips } from '../components/ChildChips';
import { DateJump, type HistogramYear } from '../components/DateJump';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { Button, EmptyState, Spinner } from '../components/ui';
import { useAppState } from '../state';
import { ageLabel, monthTitle } from '../util';

const PAGE_SIZE = 100;
type Kind = 'all' | 'photo' | 'video';

export default function Timeline() {
  const { children } = useAppState();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [child, setChild] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [anchor, setAnchor] = useState<{ iso: string; label: string } | null>(null);
  const [years, setYears] = useState<HistogramYear[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const buildQuery = useCallback(
    (pageNum: number) => {
      const q = new URLSearchParams({ page: String(pageNum), pageSize: String(PAGE_SIZE) });
      if (child) q.set('child', child);
      if (kind !== 'all') q.set('kind', kind);
      if (anchor) q.set('to', anchor.iso);
      return q;
    },
    [child, kind, anchor],
  );

  const load = useCallback(
    async (pageNum: number) => {
      setLoading(true);
      try {
        const res = await api<{ total: number; photos: Photo[] }>(`/api/photos?${buildQuery(pageNum)}`);
        setTotal(res.total);
        setPhotos((prev) => (pageNum === 1 ? res.photos : [...prev, ...res.photos]));
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  // reload from the top whenever a filter or the jump anchor changes
  useEffect(() => {
    setPage(1);
    void load(1);
  }, [child, kind, anchor, load]);

  // the jump navigator reflects the current child/kind filters
  useEffect(() => {
    const q = new URLSearchParams();
    if (child) q.set('child', child);
    if (kind !== 'all') q.set('kind', kind);
    void api<{ years: HistogramYear[] }>(`/api/photos/histogram?${q}`).then((r) => setYears(r.years));
  }, [child, kind]);

  // infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && total !== null && photos.length < total) {
        const next = page + 1;
        setPage(next);
        void load(next);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, total, photos.length, page, load]);

  const jumpTo = (iso: string, label: string) => {
    setAnchor({ iso, label });
    setOpen(null);
    window.scrollTo({ top: 0 });
  };

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

  const header = (
    <Header
      child={child}
      setChild={setChild}
      kind={kind}
      setKind={setKind}
      years={years}
      anchor={anchor}
      onJump={jumpTo}
      onClearAnchor={() => setAnchor(null)}
    />
  );

  if (!loading && total === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={kind === 'video' ? '🎬' : '🌱'}
          title={kind === 'video' ? 'No videos yet' : kind === 'photo' ? 'No photos yet' : 'Nothing here yet'}
          hint={
            anchor
              ? 'No media at that date for this filter.'
              : 'Upload your first photos or videos, or bulk-import an old Peekaboo/TimeHut export.'
          }
          action={
            anchor ? (
              <Button onClick={() => setAnchor(null)}>Back to newest</Button>
            ) : (
              <div className="flex gap-2">
                <Link to="/upload"><Button>Upload</Button></Link>
                <Link to="/import"><Button kind="secondary">Bulk import</Button></Link>
              </div>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
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

function Header({
  child,
  setChild,
  kind,
  setKind,
  years,
  anchor,
  onJump,
  onClearAnchor,
}: {
  child: string | null;
  setChild: (id: string | null) => void;
  kind: Kind;
  setKind: (k: Kind) => void;
  years: HistogramYear[];
  anchor: { iso: string; label: string } | null;
  onJump: (iso: string, label: string) => void;
  onClearAnchor: () => void;
}) {
  const kinds: { key: Kind; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'photo', label: 'Photos' },
    { key: 'video', label: 'Videos' },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-100">Timeline</h1>
        <DateJump years={years} child={child} onJump={onJump} />
      </div>
      <ChildChips selected={child} onSelect={setChild} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-800 p-0.5" data-testid="kind-filter">
          {kinds.map((k) => (
            <button
              key={k.key}
              onClick={() => setKind(k.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                kind === k.key ? 'bg-pink-500 text-white' : 'text-slate-300 hover:text-white'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        {anchor && (
          <span className="flex items-center gap-1 text-xs text-slate-400">
            jumped to <span className="font-medium text-slate-200">{anchor.label}</span>
            <button onClick={onClearAnchor} className="rounded bg-slate-800 px-2 py-0.5 text-pink-400 hover:bg-slate-700">
              ↑ newest
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
