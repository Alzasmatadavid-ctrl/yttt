/**
 * Cálculo de huecos libres REALES.
 * Huecos = horario semanal configurado − citas existentes − ocupado en el calendario externo
 *          − antelación mínima − días bloqueados.
 * KAI solo puede ofrecer horarios que salgan de aquí: nunca inventa disponibilidad.
 */
import { DateTime } from 'luxon';
import type { AvailabilityWeek } from '../lib/domain.js';

export interface AvailabilityConfig {
  timezone: string;
  weekly: AvailabilityWeek;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  blackoutDates: string[];
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot extends Interval {
  id: string;
}

export const slotId = (start: Date) => `slot_${Math.round(start.getTime() / 60_000)}`;
export const slotStartFromId = (id: string): Date | null => {
  const m = /^slot_(\d{6,})$/.exec(id);
  return m ? new Date(Number(m[1]) * 60_000) : null;
};

function parseHm(hm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59) return null;
  return { hour, minute };
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

export function computeFreeSlots(
  cfg: AvailabilityConfig,
  busy: Interval[],
  range: { from: Date; to: Date },
  durationMinutes: number,
  now: Date = new Date(),
): Slot[] {
  const tz = cfg.timezone;
  const earliest = new Date(now.getTime() + cfg.minNoticeMinutes * 60_000);
  const latest = new Date(now.getTime() + cfg.maxDaysAhead * 24 * 3600_000);
  const from = range.from > earliest ? range.from : earliest;
  const to = range.to < latest ? range.to : latest;
  if (from >= to) return [];

  const buffered = busy.map((b) => ({
    start: new Date(b.start.getTime() - cfg.bufferMinutes * 60_000),
    end: new Date(b.end.getTime() + cfg.bufferMinutes * 60_000),
  }));
  const blackout = new Set(cfg.blackoutDates);
  const step = Math.max(5, cfg.slotMinutes);
  const slots: Slot[] = [];

  let day = DateTime.fromJSDate(from).setZone(tz).startOf('day');
  const lastDay = DateTime.fromJSDate(to).setZone(tz).startOf('day');
  let guard = 0;
  while (day <= lastDay && guard++ < 400) {
    const iso = day.toISODate();
    const ranges = cfg.weekly[String(day.weekday) as keyof AvailabilityWeek] ?? [];
    if (iso && !blackout.has(iso)) {
      for (const r of ranges) {
        const s = parseHm(r.start);
        const e = parseHm(r.end);
        if (!s || !e) continue;
        let cursor = day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
        const rangeEnd = e.hour === 24 ? day.plus({ days: 1 }) : day.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
        while (cursor.plus({ minutes: durationMinutes }) <= rangeEnd) {
          const start = cursor.toJSDate();
          const end = cursor.plus({ minutes: durationMinutes }).toJSDate();
          const candidate = { start, end };
          if (start >= from && start <= to && !buffered.some((b) => overlaps(candidate, b))) {
            slots.push({ id: slotId(start), start, end });
          }
          cursor = cursor.plus({ minutes: step });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'any';

export function partOfDay(d: Date, tz: string): Exclude<PartOfDay, 'any'> {
  const h = DateTime.fromJSDate(d).setZone(tz).hour;
  if (h < 14) return 'morning';
  if (h < 19) return 'afternoon';
  return 'evening';
}

/**
 * Elige pocos huecos variados para ofrecer (no una lista enorme): por defecto 2–3,
 * repartidos en días/franjas distintas para que el lead elija fácil.
 */
export function pickOfferSlots(
  slots: Slot[],
  tz: string,
  opts: { date?: string; partOfDay?: PartOfDay; count?: number } = {},
): Slot[] {
  const count = Math.min(Math.max(opts.count ?? 2, 1), 5);
  let pool = slots;
  if (opts.date) pool = pool.filter((s) => DateTime.fromJSDate(s.start).setZone(tz).toISODate() === opts.date);
  if (opts.partOfDay && opts.partOfDay !== 'any') {
    const filtered = pool.filter((s) => partOfDay(s.start, tz) === opts.partOfDay);
    if (filtered.length) pool = filtered;
  }
  if (pool.length <= count) return pool;
  const chosen: Slot[] = [];
  const seenKeys = new Set<string>();
  // 1ª pasada: franjas distintas (día + parte del día).
  for (const s of pool) {
    const key = `${DateTime.fromJSDate(s.start).setZone(tz).toISODate()}-${partOfDay(s.start, tz)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      chosen.push(s);
      if (chosen.length === count) break;
    }
  }
  // 2ª pasada: completar con huecos separados al menos 60 minutos.
  for (const s of pool) {
    if (chosen.length >= count) break;
    if (chosen.every((c) => Math.abs(c.start.getTime() - s.start.getTime()) >= 60 * 60_000)) chosen.push(s);
  }
  return chosen.sort((a, b) => a.start.getTime() - b.start.getTime());
}
