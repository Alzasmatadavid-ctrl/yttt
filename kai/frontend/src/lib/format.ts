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

/**
 * Convierte un importe escrito a mano en céntimos. Entiende el formato español y el internacional:
 * «1.500» → 150000 · «1.500,50» → 150050 · «1500.5» → 150050 · «97,50» → 9750 · «297 €» → 29700 · «1,500.50» → 150050.
 * Un separador seguido de exactamente tres cifras se toma como separador de miles («1.500», «12.000»);
 * seguido de una o dos cifras, como decimales («97,5», «1500.50»).
 * Ignora el símbolo o el código de la moneda escrito junto al importe («$300», «149 MXN», «USD 99»): el negocio
 * puede trabajar en otra moneda distinta del euro.
 * Devuelve null si el texto está vacío o no es un importe válido (letras, negativos, más de dos decimales…).
 * Es la única versión de esta conversión en la app: el resto de pantallas la reutilizan.
 */
export function parseEurosToCents(raw: string): number | null {
  const s = raw
    .replace(/\s|\p{Sc}|eur(os?)?/giu, '')
    .replace(/^[a-z]{3}(?=\d)/i, '')
    .replace(/(\d)[a-z]{3}$/i, '$1');
  if (!s) return null;
  let integer: string;
  let decimals = '';
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Los dos separadores: el último es el decimal y el otro agrupa miles («1.500,50» o «1,500.50»).
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    const [intPart, decPart, ...rest] = s.split(decimalSep);
    if (rest.length || !/^\d{1,2}$/.test(decPart ?? '')) return null;
    if (!new RegExp(`^\\d{1,3}(\\${thousandsSep}\\d{3})+$`).test(intPart)) return null;
    integer = intPart.split(thousandsSep).join('');
    decimals = decPart;
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const thousands = new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`);
    if (thousands.test(s)) integer = s.split(sep).join('');
    else {
      const m = new RegExp(`^(\\d+)\\${sep}(\\d{1,2})$`).exec(s);
      if (!m) return null;
      integer = m[1];
      decimals = m[2];
    }
  } else {
    if (!/^\d+$/.test(s)) return null;
    integer = s;
  }
  const cents = Number(integer) * 100 + Number(decimals.padEnd(2, '0') || '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Importe máximo de una venta que acepta el servidor (1.000.000 €). */
export const MAX_DEAL_CENTS = 100_000_000;

/**
 * Valida un importe opcional escrito por el entrenador (por ejemplo, el de una venta).
 * Vacío → sin importe (cents null, sin error). Inválido o fuera de rango → mensaje de error listo para mostrar.
 */
export function parseOptionalAmount(raw: string, maxCents = MAX_DEAL_CENTS): { cents: number | null; error: string | null } {
  if (!raw.trim()) return { cents: null, error: null };
  const cents = parseEurosToCents(raw);
  if (cents === null) return { cents: null, error: 'Escribe solo el importe, por ejemplo 1200 o 1.200,50.' };
  if (cents > maxCents) return { cents: null, error: `El importe máximo es ${formatMoney(maxCents, 'EUR')}.` };
  return { cents, error: null };
}

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
