import type { Child } from '../../shared/types';

/**
 * Age label at a moment: "2y 4m", "7m", "newborn" — or "pregnancy" for
 * photos dated before the child's birth. Children without a birth date
 * (created by a rebuild) get no age label.
 */
export function ageLabel(child: Child, atIso: string): string | null {
  if (!child.birthDate) return null;
  const birth = new Date(child.birthDate + 'T00:00:00');
  const at = new Date(atIso);
  if (at < birth) return 'pregnancy';
  let months = (at.getFullYear() - birth.getFullYear()) * 12 + (at.getMonth() - birth.getMonth());
  if (at.getDate() < birth.getDate()) months--;
  if (months < 1) return 'newborn';
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months}m`;
  return rem === 0 ? `${years}y` : `${years}y ${rem}m`;
}

export function monthTitle(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Seconds → "m:ss" (or "h:mm:ss" for long clips), for video badges. */
export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  return `${(bytes / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** ISO datetime -> value usable in <input type="datetime-local"> (local time). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
