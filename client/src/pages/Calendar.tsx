import { useEffect, useState } from 'react';
import type { Photo } from '../../../shared/types';
import { api } from '../api';
import { ChildChips } from '../components/ChildChips';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { EmptyState, Spinner } from '../components/ui';

export default function Calendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [child, setChild] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, number>>({});
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayPhotos, setDayPhotos] = useState<Photo[]>([]);
  const [loadingDay, setLoadingDay] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ year: String(year), month: String(month) });
    if (child) q.set('child', child);
    void api<{ days: Record<string, number> }>(`/api/calendar?${q}`).then((res) => setDays(res.days));
    setSelectedDay(null);
  }, [year, month, child]);

  useEffect(() => {
    if (!selectedDay) return;
    setLoadingDay(true);
    const q = new URLSearchParams({ from: `${selectedDay}T00:00:00.000Z`, to: `${selectedDay}T23:59:59.999Z`, pageSize: '500' });
    if (child) q.set('child', child);
    void api<{ photos: Photo[] }>(`/api/photos?${q}`)
      .then((res) => setDayPhotos(res.photos))
      .finally(() => setLoadingDay(false));
  }, [selectedDay, child]);

  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const shift = (delta: number) => {
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">Calendar</h1>
      <ChildChips selected={child} onSelect={setChild} />
      <div className="flex items-center justify-between">
        <button onClick={() => shift(-1)} className="rounded-lg px-3 py-1 text-xl text-slate-300 hover:bg-slate-800">‹</button>
        <h2 className="text-lg font-semibold text-slate-100">{monthLabel}</h2>
        <button onClick={() => shift(1)} className="rounded-lg px-3 py-1 text-xl text-slate-300 hover:bg-slate-800">›</button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
          <div key={d} className="py-1 text-xs font-medium text-slate-500">{d}</div>
        ))}
        {Array.from({ length: firstWeekday }).map((_, i) => (
          <div key={`pad-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
          const count = days[day] ?? 0;
          return (
            <button
              key={day}
              onClick={() => count > 0 && setSelectedDay(day)}
              className={`flex aspect-square flex-col items-center justify-center rounded-lg text-sm ${
                selectedDay === day
                  ? 'bg-pink-500 text-white'
                  : count > 0
                    ? 'bg-slate-800 text-slate-100 hover:bg-slate-700'
                    : 'text-slate-600'
              }`}
            >
              <span>{i + 1}</span>
              {count > 0 && <span className={`text-[10px] ${selectedDay === day ? 'text-pink-100' : 'text-pink-400'}`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">
            {new Date(selectedDay + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </h3>
          {loadingDay ? <Spinner /> : <PhotoGrid photos={dayPhotos} onOpen={setOpen} />}
        </section>
      )}
      {!selectedDay && Object.keys(days).length === 0 && (
        <EmptyState icon="📅" title="No photos this month" hint="Use ‹ and › to move between months." />
      )}

      {open !== null && (
        <Lightbox
          photos={dayPhotos}
          index={open}
          onClose={() => setOpen(null)}
          onNavigate={setOpen}
          onChange={(updated) => setDayPhotos((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
          onDelete={async (photo) => {
            await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
            setDayPhotos((prev) => prev.filter((p) => p.id !== photo.id));
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
