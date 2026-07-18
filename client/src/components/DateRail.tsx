import { useEffect, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES } from '../util';

export interface HistogramYear {
  year: string;
  count: number;
  months: { key: string; month: number; count: number }[];
}

interface Props {
  years: HistogramYear[];
  child: string | null;
  activeMonth: string | null; // "YYYY-MM" currently in view, for highlighting
  onJumpMonth: (monthKey: string) => void;
  onJumpDay: (day: string) => void;
  onJumpNewest: () => void;
  onDropToMonth: (photoId: string, monthKey: string) => void;
  onDropToDay: (photoId: string, day: string) => void;
}

/**
 * TimeHut-style date rail: a scrollable list of years → months → days, with
 * counts. It stays visible while scrolling (the parent renders it sticky on
 * desktop / in a drawer on mobile). Click an entry to jump there; drop a photo
 * on an entry to move it to that date.
 */
export function DateRail({
  years,
  child,
  activeMonth,
  onJumpMonth,
  onJumpDay,
  onJumpNewest,
  onDropToMonth,
  onDropToDay,
}: Props) {
  const [openYears, setOpenYears] = useState<Set<string>>(new Set());
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, Record<string, number>>>({});
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // keep the year containing the active month expanded
  useEffect(() => {
    if (activeMonth) setOpenYears((prev) => new Set(prev).add(activeMonth.slice(0, 4)));
  }, [activeMonth]);

  const toggleYear = (year: string) =>
    setOpenYears((prev) => {
      const next = new Set(prev);
      next.has(year) ? next.delete(year) : next.add(year);
      return next;
    });

  const loadDays = async (monthKey: string) => {
    if (openMonth === monthKey) {
      setOpenMonth(null);
      return;
    }
    setOpenMonth(monthKey);
    if (!days[monthKey]) {
      const [y, m] = monthKey.split('-');
      const q = new URLSearchParams({ year: y, month: String(Number(m)) });
      if (child) q.set('child', child);
      const res = await api<{ days: Record<string, number> }>(`/api/calendar?${q}`);
      setDays((prev) => ({ ...prev, [monthKey]: res.days }));
    }
  };

  const dropHandlers = (key: string, onDrop: (id: string) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      const id = e.dataTransfer.getData('text/plain');
      if (id) onDrop(id);
    },
  });

  return (
    <nav className="text-sm" data-testid="date-rail" aria-label="Jump to date">
      <button
        onClick={onJumpNewest}
        className="mb-2 block w-full rounded-lg px-2 py-1 text-right font-semibold text-pink-400 hover:bg-slate-800"
      >
        Today ↑
      </button>
      {years.map((y) => {
        const open = openYears.has(y.year);
        return (
          <div key={y.year} className="mb-0.5">
            <button
              onClick={() => toggleYear(y.year)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1 font-semibold text-slate-200 hover:bg-slate-800"
            >
              <span className="text-xs text-slate-500">{y.count}</span>
              <span>
                {y.year} <span className="inline-block w-3 text-slate-500">{open ? '▾' : '▸'}</span>
              </span>
            </button>
            {open && (
              <div className="border-r border-slate-800 pr-1">
                {y.months.map((mo) => (
                  <div key={mo.key}>
                    <div
                      className={`flex items-center justify-end rounded-lg pr-1 ${
                        dropTarget === mo.key ? 'bg-pink-500/30 ring-1 ring-pink-400' : ''
                      } ${activeMonth === mo.key ? 'bg-slate-800' : ''}`}
                      {...dropHandlers(mo.key, (id) => onDropToMonth(id, mo.key))}
                    >
                      <button
                        onClick={() => void loadDays(mo.key)}
                        className="px-1 py-0.5 text-[10px] text-slate-500 hover:text-slate-300"
                        aria-label={`days in ${MONTH_NAMES[mo.month - 1]} ${y.year}`}
                      >
                        {openMonth === mo.key ? '▾' : '▸'}
                      </button>
                      <button
                        onClick={() => onJumpMonth(mo.key)}
                        data-testid="rail-month"
                        className={`flex-1 rounded-lg px-2 py-1 text-right hover:bg-slate-800 ${
                          activeMonth === mo.key ? 'font-semibold text-pink-400' : 'text-slate-300'
                        }`}
                      >
                        {MONTH_NAMES[mo.month - 1]} <span className="text-xs text-slate-500">{mo.count}</span>
                      </button>
                    </div>
                    {openMonth === mo.key && days[mo.key] && (
                      <div className="flex flex-wrap justify-end gap-1 py-1 pr-2">
                        {Object.keys(days[mo.key])
                          .sort()
                          .map((day) => (
                            <button
                              key={day}
                              onClick={() => onJumpDay(day)}
                              {...dropHandlers(day, (id) => onDropToDay(id, day))}
                              className={`rounded px-1.5 py-0.5 text-xs hover:bg-pink-500 hover:text-white ${
                                dropTarget === day ? 'bg-pink-500 text-white' : 'bg-slate-800 text-slate-300'
                              }`}
                              title={`${days[mo.key][day]} items — click to jump, drop a photo to move it here`}
                            >
                              {Number(day.slice(8, 10))}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
