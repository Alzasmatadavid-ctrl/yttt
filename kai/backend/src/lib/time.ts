import { DateTime } from 'luxon';
import { countryCodeForTimezone, internationalDigits } from '../integrations/channels/phone.js';
import { normalize } from './text.js';

export const now = () => new Date();
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const addHours = (d: Date, h: number) => addMinutes(d, h * 60);
export const addDays = (d: Date, days: number) => addHours(d, days * 24);
export const hoursBetween = (a: Date, b: Date) => Math.abs(b.getTime() - a.getTime()) / 3_600_000;

/** Periodo de facturación/uso: "2026-10". */
export const usagePeriod = (d: Date = new Date()) => d.toISOString().slice(0, 7);

/** Opciones para las horas que lee el lead. */
export interface LeadTimeOptions {
  /**
   * WhatsApp (o teléfono) del lead. Si su prefijo es de otro país, se añade la zona horaria del entrenador y, si se
   * conoce, la hora en el país del lead: “mañana a las 18:00 (hora de España; en México, a las 10:00)”.
   */
  leadPhone?: string | null;
}

/**
 * “mañana a las 18:00”, “el jueves 9 a las 10:30”… en la zona horaria del negocio. Con `leadPhone` de otro país,
 * se aclara la zona (ver `leadZoneNote`).
 */
export function humanSlotLabel(startIso: string | Date, timezone: string, reference: Date = new Date(), opts: LeadTimeOptions = {}): string {
  const start = DateTime.fromJSDate(new Date(startIso)).setZone(timezone).setLocale('es');
  const ref = DateTime.fromJSDate(reference).setZone(timezone).startOf('day');
  const diffDays = Math.round(start.startOf('day').diff(ref, 'days').days);
  const time = start.toFormat('HH:mm');
  const note = opts.leadPhone ? leadZoneNote(startIso, timezone, opts.leadPhone, reference) : '';
  if (diffDays === 0) return `hoy a las ${time}${note}`;
  if (diffDays === 1) return `mañana a las ${time}${note}`;
  if (diffDays === 2) return `pasado mañana a las ${time}${note}`;
  if (diffDays > 2 && diffDays < 7) return `el ${start.toFormat('cccc d')} a las ${time}${note}`;
  return `el ${start.toFormat("cccc d 'de' LLLL")} a las ${time}${note}`;
}

/** Fecha con formato en la zona del negocio. Con `leadPhone` de otro país, se aclara la zona (ver `leadZoneNote`). */
export function formatInZone(d: Date | string, timezone: string, fmt = "cccc d 'de' LLLL, HH:mm", opts: LeadTimeOptions = {}) {
  const text = DateTime.fromJSDate(new Date(d)).setZone(timezone).setLocale('es').toFormat(fmt);
  return opts.leadPhone ? `${text}${leadZoneNote(d, timezone, opts.leadPhone)}` : text;
}

// ───────────── Leads de otro país ─────────────

/**
 * País y zona horaria según el prefijo telefónico (los países desde los que más se escribe a entrenadores de habla
 * hispana). La zona es null si el país tiene varias (+1: Estados Unidos, Canadá, República Dominicana…).
 */
const PHONE_COUNTRIES: Record<string, { country: string | null; timezone: string | null }> = {
  '34': { country: 'España', timezone: 'Europe/Madrid' },
  '351': { country: 'Portugal', timezone: 'Europe/Lisbon' },
  '376': { country: 'Andorra', timezone: 'Europe/Andorra' },
  '33': { country: 'Francia', timezone: 'Europe/Paris' },
  '44': { country: 'Reino Unido', timezone: 'Europe/London' },
  '49': { country: 'Alemania', timezone: 'Europe/Berlin' },
  '39': { country: 'Italia', timezone: 'Europe/Rome' },
  '41': { country: 'Suiza', timezone: 'Europe/Zurich' },
  '32': { country: 'Bélgica', timezone: 'Europe/Brussels' },
  '31': { country: 'Países Bajos', timezone: 'Europe/Amsterdam' },
  '52': { country: 'México', timezone: 'America/Mexico_City' },
  '57': { country: 'Colombia', timezone: 'America/Bogota' },
  '54': { country: 'Argentina', timezone: 'America/Argentina/Buenos_Aires' },
  '56': { country: 'Chile', timezone: 'America/Santiago' },
  '51': { country: 'Perú', timezone: 'America/Lima' },
  '58': { country: 'Venezuela', timezone: 'America/Caracas' },
  '593': { country: 'Ecuador', timezone: 'America/Guayaquil' },
  '598': { country: 'Uruguay', timezone: 'America/Montevideo' },
  '595': { country: 'Paraguay', timezone: 'America/Asuncion' },
  '591': { country: 'Bolivia', timezone: 'America/La_Paz' },
  '507': { country: 'Panamá', timezone: 'America/Panama' },
  '506': { country: 'Costa Rica', timezone: 'America/Costa_Rica' },
  '502': { country: 'Guatemala', timezone: 'America/Guatemala' },
  '503': { country: 'El Salvador', timezone: 'America/El_Salvador' },
  '504': { country: 'Honduras', timezone: 'America/Tegucigalpa' },
  '505': { country: 'Nicaragua', timezone: 'America/Managua' },
  '53': { country: 'Cuba', timezone: 'America/Havana' },
  '1': { country: null, timezone: null },
};

/** Lugar con el que se nombra la hora de algunas zonas (para Europa, Intl da “hora de Europa central”, poco claro). */
const ZONE_PLACES: Record<string, string> = {
  'Europe/Madrid': 'España',
  'Africa/Ceuta': 'España',
  'Atlantic/Canary': 'Canarias',
  'Europe/Lisbon': 'Portugal',
  'Europe/Andorra': 'Andorra',
  'Europe/Paris': 'Francia',
  'Europe/London': 'Reino Unido',
  'Europe/Berlin': 'Alemania',
  'Europe/Rome': 'Italia',
  'Europe/Zurich': 'Suiza',
  'Europe/Brussels': 'Bélgica',
  'Europe/Amsterdam': 'Países Bajos',
};

/** Lugar con el que se nombra la hora de una zona: “España”, “Ciudad de México”, “Colombia”, “Nueva York”… */
export function zonePlace(timezone: string): string {
  if (ZONE_PLACES[timezone]) return ZONE_PLACES[timezone];
  try {
    const name = new Intl.DateTimeFormat('es', { timeZone: timezone, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name?.startsWith('hora de ')) return name.slice('hora de '.length);
  } catch {
    // Zona desconocida: se usa su nombre.
  }
  return timezone.split('/').pop()!.replace(/_/g, ' ');
}

/**
 * Lugares con los que se puede atribuir una hora a una zona (“en México, a las 10:00”, “a las 18:00, hora de España”),
 * en minúsculas y sin tildes. Las zonas de `first` (la del negocio) mandan sobre las de la lista general.
 */
export function placeZones(first: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const tz of first) out.set(normalize(zonePlace(tz)), tz);
  for (const [tz, place] of Object.entries(ZONE_PLACES)) if (!out.has(normalize(place))) out.set(normalize(place), tz);
  for (const c of Object.values(PHONE_COUNTRIES)) if (c.country && c.timezone && !out.has(normalize(c.country))) out.set(normalize(c.country), c.timezone);
  return out;
}

/** País del lead y su zona horaria (null si no se sabe o su país tiene varias). */
export interface LeadZone {
  country: string | null;
  timezone: string | null;
}

/**
 * ¿Escribe el lead desde otro país? Se deduce del prefijo de su WhatsApp frente al país del negocio (según su zona).
 * null si es el mismo país, si a esa hora (`at`) los dos países tienen la misma hora, o si no se puede saber
 * (Instagram, número sin prefijo de un negocio de país desconocido…).
 */
export function leadZone(leadPhone: string | null | undefined, timezone: string, at: Date = new Date()): LeadZone | null {
  if (!leadPhone) return null;
  const businessCode = countryCodeForTimezone(timezone);
  const digits = internationalDigits(leadPhone, businessCode);
  if (!digits) return null;
  if (businessCode && digits.startsWith(businessCode)) return null;
  const known = [3, 2, 1].map((n) => PHONE_COUNTRIES[digits.slice(0, n)]).find(Boolean);
  if (known?.timezone) {
    const offset = (zone: string) => DateTime.fromJSDate(at).setZone(zone).offset;
    if (offset(known.timezone) === offset(timezone)) return null; // misma hora: no hace falta aclarar nada
    return { country: known.country, timezone: known.timezone };
  }
  // País con varias zonas o desconocido: solo se sabe que es otro país si se conoce el del negocio.
  return businessCode ? { country: known?.country ?? null, timezone: null } : null;
}

/**
 * Aclaración para un lead de otro país, para que no entienda la hora en la suya:
 * “ (hora de España; en México, a las 10:00)”, o “ (hora de España)” si no se sabe su zona. Si en su país el día
 * es otro, se dice (“en México, hoy a las 17:30”). Cadena vacía si el lead está en el mismo país o no se puede saber.
 */
export function leadZoneNote(start: string | Date, timezone: string, leadPhone: string | null | undefined, reference: Date = new Date()): string {
  const at = new Date(start);
  const zone = leadZone(leadPhone, timezone, at);
  if (!zone) return '';
  const own = `hora de ${zonePlace(timezone)}`;
  if (!zone.timezone || !zone.country) return ` (${own})`;
  const ours = humanSlotLabel(at, timezone, reference);
  const theirs = humanSlotLabel(at, zone.timezone, reference);
  const day = (label: string) => label.slice(0, label.lastIndexOf(' a las '));
  const local = day(ours) === day(theirs) ? theirs.slice(theirs.lastIndexOf('a las ')) : theirs;
  return ` (${own}; en ${zone.country}, ${local})`;
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
