import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { ChildChips } from '../components/ChildChips';
import { DateRail, type HistogramYear } from '../components/DateRail';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { Button, EmptyState, Spinner } from '../components/ui';
import { useAppState } from '../state';
import { ageLabel, endOfDayIso, endOfMonthIso, monthTitle, reDayIso, reMonthIso } from '../util';

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
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [railOpen, setRailOpen] = useState(false);
  const [bulkDate, setBulkDate] = useState('');
  const sentinel = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

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

  const loadHistogram = useCallback(() => {
    const q = new URLSearchParams();
    if (child) q.set('child', child);
    if (kind !== 'all') q.set('kind', kind);
    void api<{ years: HistogramYear[] }>(`/api/photos/histogram?${q}`).then((r) => setYears(r.years));
  }, [child, kind]);

  useEffect(() => {
    setPage(1);
    void load(1);
  }, [child, kind, anchor, load]);

  useEffect(() => loadHistogram(), [loadHistogram]);

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

  // highlight the month currently near the top of the viewport in the rail
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveMonth((visible[0].target as HTMLElement).dataset.month ?? null);
      },
      { rootMargin: '0px 0px -80% 0px' },
    );
    for (const el of sectionRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [groups]);

  const reload = useCallback(() => {
    setPage(1);
    void load(1);
    loadHistogram();
  }, [load, loadHistogram]);

  const jumpTo = (iso: string, label: string) => {
    setAnchor({ iso, label });
    setOpen(null);
    setRailOpen(false);
    window.scrollTo({ top: 0 });
  };

  // drag-and-drop a photo onto a rail entry to change its date
  const reDate = async (photoId: string, iso: string) => {
    await api(`/api/photos/${photoId}`, { method: 'PATCH', body: JSON.stringify({ takenAt: iso }) });
    reload();
  };
  const findIso = (id: string) => photos.find((p) => p.id === id)?.takenAt ?? new Date().toISOString();

  const relevantChildren = child ? children.filter((c) => c.id === child) : children;

  const patchPhoto = (updated: Photo) => setPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  const removePhoto = async (photo: Photo) => {
    await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setTotal((t) => (t === null ? t : t - 1));
    setOpen(null);
  };

  // ---- selection ----
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const selectGroup = (monthPhotos: Photo[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = monthPhotos.every((p) => next.has(p.id));
      for (const p of monthPhotos) (allSelected ? next.delete(p.id) : next.add(p.id));
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  const exitSelect = () => {
    setSelectMode(false);
    clearSelection();
  };

  const applyBulkDate = async () => {
    if (!bulkDate || selected.size === 0) return;
    const iso = new Date(`${bulkDate}T12:00:00`).toISOString();
    await api('/api/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selected], takenAt: iso }) });
    setBulkDate('');
    exitSelect();
    reload();
  };
  const bulkDelete = async () => {
    if (selected.size === 0 || !window.confirm(`Move ${selected.size} item(s) to trash?`)) return;
    await api('/api/photos/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selected], trash: true }) });
    exitSelect();
    reload();
  };

  const header = (
    <Header
      child={child}
      setChild={setChild}
      kind={kind}
      setKind={setKind}
      anchor={anchor}
      onClearAnchor={() => setAnchor(null)}
      selectMode={selectMode}
      onToggleSelect={() => (selectMode ? exitSelect() : setSelectMode(true))}
    />
  );

  const rail = (
    <DateRail
      years={years}
      child={child}
      activeMonth={activeMonth}
      onJumpMonth={(m) => jumpTo(endOfMonthIso(m), monthTitle(m))}
      onJumpDay={(d) => jumpTo(endOfDayIso(d), d)}
      onJumpNewest={() => {
        setAnchor(null);
        setRailOpen(false);
        window.scrollTo({ top: 0 });
      }}
      onDropToMonth={(id, m) => void reDate(id, reMonthIso(findIso(id), m))}
      onDropToDay={(id, d) => void reDate(id, reDayIso(findIso(id), d))}
    />
  );

  const empty = !loading && total === 0;

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1 space-y-6">
        {header}

        {empty ? (
          <EmptyState
            icon={kind === 'video' ? '🎬' : '🌱'}
            title={kind === 'video' ? 'No videos yet' : kind === 'photo' ? 'No photos yet' : 'Nothing here yet'}
            hint={anchor ? 'No media at that date for this filter.' : 'Upload photos/videos, or bulk-import an old export.'}
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
        ) : (
          groups.map(([month, monthPhotos]) => {
            const at = monthPhotos[0].takenAt;
            const guessedCount = monthPhotos.filter((p) => p.takenAtSource === 'file').length;
            return (
              <section
                key={month}
                data-testid="month-group"
                data-month={month}
                ref={(el) => {
                  if (el) sectionRefs.current.set(month, el);
                  else sectionRefs.current.delete(month);
                }}
              >
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
                  {guessedCount > 0 && (
                    <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300" title="These dates were guessed from the file. Select and set the right date, or drag onto the date rail.">
                      ⚠ {guessedCount} guessed date{guessedCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {selectMode && (
                    <button onClick={() => selectGroup(monthPhotos)} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-pink-400 hover:bg-slate-700">
                      select month
                    </button>
                  )}
                </div>
                <PhotoGrid
                  photos={monthPhotos}
                  onOpen={(i) => setOpen(photos.indexOf(monthPhotos[i]))}
                  selectMode={selectMode}
                  selectedIds={selected}
                  onToggleSelect={toggleSelect}
                  draggable
                />
              </section>
            );
          })
        )}
        {loading && <Spinner />}
        <div ref={sentinel} className="h-4" />
      </div>

      {/* desktop: always-visible sticky rail */}
      {years.length > 0 && (
        <aside className="hidden w-40 shrink-0 lg:block">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pb-4">{rail}</div>
        </aside>
      )}

      {/* mobile: floating button toggles the rail as a drawer */}
      {years.length > 0 && (
        <>
          <button
            onClick={() => setRailOpen(true)}
            className="fixed bottom-20 right-4 z-30 rounded-full bg-pink-500 px-4 py-2 text-sm font-medium text-white shadow-lg lg:hidden"
          >
            📅 Dates
          </button>
          {railOpen && (
            <div className="fixed inset-0 z-40 flex lg:hidden" onClick={() => setRailOpen(false)}>
              <div className="ml-auto h-full w-56 overflow-y-auto bg-slate-900 p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setRailOpen(false)} className="mb-2 text-sm text-slate-400">
                  ✕ close
                </button>
                {rail}
              </div>
            </div>
          )}
        </>
      )}

      {selectMode && selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-40 mx-auto max-w-2xl rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-xl backdrop-blur md:bottom-4" data-testid="bulk-bar">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-slate-100">{selected.size} selected</span>
            <span className="text-slate-400">Set date:</span>
            <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100" />
            <Button small onClick={() => void applyBulkDate()} disabled={!bulkDate}>Apply</Button>
            <Button small kind="danger" onClick={() => void bulkDelete()}>Delete</Button>
            <Button small kind="ghost" onClick={clearSelection}>Clear</Button>
          </div>
        </div>
      )}

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
  anchor,
  onClearAnchor,
  selectMode,
  onToggleSelect,
}: {
  child: string | null;
  setChild: (id: string | null) => void;
  kind: Kind;
  setKind: (k: Kind) => void;
  anchor: { iso: string; label: string } | null;
  onClearAnchor: () => void;
  selectMode: boolean;
  onToggleSelect: () => void;
}) {
  const kinds: { key: Kind; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'photo', label: 'Photos' },
    { key: 'video', label: 'Videos' },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-100">Timeline</h1>
        <Button small kind={selectMode ? 'primary' : 'secondary'} onClick={onToggleSelect}>
          {selectMode ? 'Done' : 'Select'}
        </Button>
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
        {selectMode && <span className="text-xs text-slate-400">Tap photos to select · or drag a photo onto a date in the rail →</span>}
      </div>
    </div>
  );
}
