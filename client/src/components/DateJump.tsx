import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { MONTH_NAMES } from '../util';

export interface HistogramYear {
  year: string;
  count: number;
  months: { key: string; month: number; count: number }[];
}

/**
 * A "Jump to date" dropdown: years → months → days, each with photo counts.
 * Clicking a month or day jumps the timeline to that point. Days are loaded
 * lazily from the calendar endpoint the first time a month is expanded.
 */
export function DateJump({
  years,
  child,
  onJump,
}: {
  years: HistogramYear[];
  child: string | null;
  onJump: (anchorIso: string, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openYear, setOpenYear] = useState<string | null>(null);
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, Record<string, number>>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // default-expand the most recent year for quick access
  useEffect(() => {
    if (open && openYear === null && years[0]) setOpenYear(years[0].year);
  }, [open, years, openYear]);

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

  if (years.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500"
        data-testid="date-jump-button"
      >
        📅 Jump to date <span className="text-xs text-slate-400">▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-1 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-xl"
          data-testid="date-jump-panel"
        >
          {years.map((y) => (
            <div key={y.year}>
              <button
                onClick={() => setOpenYear(openYear === y.year ? null : y.year)}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-800"
              >
                <span>
                  <span className="mr-1 inline-block w-3 text-slate-500">{openYear === y.year ? '▾' : '▸'}</span>
                  {y.year}
                </span>
                <span className="text-xs text-slate-500">{y.count}</span>
              </button>
              {openYear === y.year && (
                <div className="ml-3 border-l border-slate-800 pl-1">
                  {y.months.map((mo) => (
                    <div key={mo.key}>
                      <div className="flex items-center">
                        <button
                          onClick={() => onJump(endOfMonthKey(mo.key), monthLabel(mo.key))}
                          className="flex flex-1 items-center justify-between rounded-lg px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
                          data-testid="date-jump-month"
                        >
                          <span>{MONTH_NAMES[mo.month - 1]}</span>
                          <span className="text-xs text-slate-500">{mo.count}</span>
                        </button>
                        <button
                          aria-label={`Show days in ${monthLabel(mo.key)}`}
                          onClick={() => void loadDays(mo.key)}
                          className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-800"
                        >
                          {openMonth === mo.key ? '▾' : '▸'}
                        </button>
                      </div>
                      {openMonth === mo.key && days[mo.key] && (
                        <div className="ml-3 flex flex-wrap gap-1 py-1">
                          {Object.keys(days[mo.key])
                            .sort()
                            .map((day) => (
                              <button
                                key={day}
                                onClick={() => onJump(endOfDayKey(day), dayLabel(day))}
                                className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300 hover:bg-pink-500 hover:text-white"
                                title={`${days[mo.key][day]} photos`}
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
          ))}
        </div>
      )}
    </div>
  );
}

// Local helpers kept here to avoid a circular import with util (which the
// timeline also uses); mirror endOfMonthIso/endOfDayIso semantics.
function endOfMonthKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999).toISOString();
}
function endOfDayKey(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}
