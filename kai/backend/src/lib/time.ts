import { DateTime } from 'luxon';

export const now = () => new Date();
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const addHours = (d: Date, h: number) => addMinutes(d, h * 60);
export const addDays = (d: Date, days: number) => addHours(d, days * 24);
export const hoursBetween = (a: Date, b: Date) => Math.abs(b.getTime() - a.getTime()) / 3_600_000;

/** Periodo de facturación/uso: "2026-10". */
export const usagePeriod = (d: Date = new Date()) => d.toISOString().slice(0, 7);

/** “mañana a las 18:00”, “el jueves 9 a las 10:30”… en la zona horaria del negocio. */
export function humanSlotLabel(startIso: string | Date, timezone: string, reference: Date = new Date()): string {
  const start = DateTime.fromJSDate(new Date(startIso)).setZone(timezone).setLocale('es');
  const ref = DateTime.fromJSDate(reference).setZone(timezone).startOf('day');
  const diffDays = Math.round(start.startOf('day').diff(ref, 'days').days);
  const time = start.toFormat('HH:mm');
  if (diffDays === 0) return `hoy a las ${time}`;
  if (diffDays === 1) return `mañana a las ${time}`;
  if (diffDays === 2) return `pasado mañana a las ${time}`;
  if (diffDays > 2 && diffDays < 7) return `el ${start.toFormat('cccc d')} a las ${time}`;
  return `el ${start.toFormat("cccc d 'de' LLLL")} a las ${time}`;
}

export function formatInZone(d: Date | string, timezone: string, fmt = "cccc d 'de' LLLL, HH:mm") {
  return DateTime.fromJSDate(new Date(d)).setZone(timezone).setLocale('es').toFormat(fmt);
}

/** ¿Está la hora local dentro del rango de silencio (p. ej. 21:00–09:00)? */
export function isWithinQuietHours(d: Date, timezone: string, quiet?: { start: string; end: string }): boolean {
  if (!quiet) return false;
  const local = DateTime.fromJSDate(d).setZone(timezone);
  const minutes = local.hour * 60 + local.minute;
  const [sh, sm] = quiet.start.split(':').map(Number);
  const [eh, em] = quiet.end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** Mueve una fecha al final del horario de silencio si cae dentro. */
export function shiftOutOfQuietHours(d: Date, timezone: string, quiet?: { start: string; end: string }): Date {
  if (!quiet || !isWithinQuietHours(d, timezone, quiet)) return d;
  const [eh, em] = quiet.end.split(':').map(Number);
  let local = DateTime.fromJSDate(d).setZone(timezone).set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (local.toJSDate() <= d) local = local.plus({ days: 1 });
  return local.toJSDate();
}
