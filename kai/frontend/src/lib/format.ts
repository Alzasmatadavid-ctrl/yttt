import { formatMoney } from '@shared';

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'ahora';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

export function shortTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '';
  const d = new Date(value);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone })
    : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone });
}

export function dateTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });
}

export function timeOnly(value: string | Date, timeZone?: string) {
  return new Date(value).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone });
}

export function dayLabel(value: string | Date, timeZone?: string) {
  return new Date(value).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
}

export const money = (cents: number | null | undefined, currency = 'EUR') => formatMoney(cents ?? 0, currency);

export function compact(n: number): string {
  return new Intl.NumberFormat('es-ES', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}

export const pct = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 1 })}%`;

export function duration(seconds: number): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toLocaleString('es-ES', { maximumFractionDigits: 1 })} h`;
}

export function initials(name: string | null | undefined): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
