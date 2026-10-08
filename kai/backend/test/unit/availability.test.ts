import { describe, expect, it } from 'vitest';
import { computeFreeSlots, partOfDay, pickOfferSlots, slotId, slotStartFromId, type Slot } from '../../src/calendar/availability.js';
import { MADRID, MEXICO, hm, interval, local, localStamp, makeAvailabilityConfig, makeWeek, slotAt } from './factories.js';

const iso = (slots: Slot[]) => slots.map((s) => s.start.toISOString());
const times = (slots: Slot[], tz = MADRID) => slots.map((s) => hm(s.start, tz));
const stamps = (slots: Slot[], tz = MADRID) => slots.map((s) => localStamp(s.start, tz));

describe('slotId / slotStartFromId', () => {
  it('ida y vuelta: el id codifica el minuto de inicio', () => {
    const start = new Date('2026-10-06T16:00:00.000Z');
    const id = slotId(start);
    expect(id).toBe(`slot_${start.getTime() / 60_000}`);
    expect(slotStartFromId(id)?.toISOString()).toBe(start.toISOString());
  });

  it('redondea al minuto más cercano', () => {
    const start = new Date('2026-10-06T16:00:40.000Z');
    expect(slotStartFromId(slotId(start))?.toISOString()).toBe('2026-10-06T16:01:00.000Z');
  });

  it.each(['slot_abc', 'slot_12345', 'xslot_29842560', 'slot_29842560x', '', '29842560'])('rechaza ids mal formados: %s', (id) => {
    expect(slotStartFromId(id)).toBeNull();
  });

  it('el id de cada hueco calculado coincide con su inicio', () => {
    const slots = computeFreeSlots(makeAvailabilityConfig(), [], { from: local('2026-10-05T00:00'), to: local('2026-10-05T23:00') }, 30, local('2026-10-05T07:00'));
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(slotStartFromId(s.id)?.getTime()).toBe(s.start.getTime());
  });
});

describe('computeFreeSlots', () => {
  it('genera los huecos del horario semanal en la zona horaria de Madrid', () => {
    const now = local('2026-10-05T07:00'); // lunes
    const slots = computeFreeSlots(makeAvailabilityConfig(), [], { from: now, to: local('2026-10-05T23:00') }, 30, now);
    expect(times(slots)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    // Madrid en octubre (antes del cambio) es UTC+2.
    expect(slots[0].start.toISOString()).toBe('2026-10-05T07:00:00.000Z');
    for (const s of slots) expect(s.end.getTime() - s.start.getTime()).toBe(30 * 60_000);
  });

  it('genera los huecos en la zona horaria de Ciudad de México (UTC−6, sin horario de verano)', () => {
    const cfg = makeAvailabilityConfig({ timezone: MEXICO });
    const now = local('2026-10-05T06:00', MEXICO);
    const slots = computeFreeSlots(cfg, [], { from: now, to: local('2026-10-05T23:00', MEXICO) }, 30, now);
    expect(times(slots, MEXICO)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(slots[0].start.toISOString()).toBe('2026-10-05T15:00:00.000Z');
  });

  it('la duración de la llamada puede ser distinta del paso entre huecos', () => {
    const now = local('2026-10-05T07:00');
    const slots = computeFreeSlots(makeAvailabilityConfig({ slotMinutes: 30 }), [], { from: now, to: local('2026-10-05T23:00') }, 60, now);
    // El último hueco de 60 min debe terminar como tarde a las 12:00.
    expect(times(slots)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(hm(slots[slots.length - 1].end)).toBe('12:00');
  });

  it('no ofrece fines de semana si no hay horario configurado', () => {
    const now = local('2026-10-09T07:00'); // viernes
    const slots = computeFreeSlots(makeAvailabilityConfig(), [], { from: now, to: local('2026-10-12T23:00') }, 30, now);
    const days = new Set(stamps(slots).map((s) => s.slice(0, 10)));
    expect([...days]).toEqual(['2026-10-09', '2026-10-12']);
  });

  it('resta las citas ocupadas', () => {
    const now = local('2026-10-05T07:00');
    const busy = [interval(local('2026-10-05T10:00'), 30)];
    const slots = computeFreeSlots(makeAvailabilityConfig(), busy, { from: now, to: local('2026-10-05T23:00') }, 30, now);
    // Los extremos que solo “tocan” la cita siguen libres.
    expect(times(slots)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('aplica el margen (buffer) antes y después de cada ocupado', () => {
    const now = local('2026-10-05T07:00');
    const busy = [interval(local('2026-10-05T10:00'), 30)];
    const slots = computeFreeSlots(makeAvailabilityConfig({ bufferMinutes: 15 }), busy, { from: now, to: local('2026-10-05T23:00') }, 30, now);
    // Ocupado efectivo: 09:45–10:45.
    expect(times(slots)).toEqual(['09:00', '11:00', '11:30']);
  });

  it('un ocupado que atraviesa varios huecos los bloquea todos', () => {
    const now = local('2026-10-05T07:00');
    const busy = [{ start: local('2026-10-05T09:15'), end: local('2026-10-05T11:10') }];
    const slots = computeFreeSlots(makeAvailabilityConfig(), busy, { from: now, to: local('2026-10-05T23:00') }, 30, now);
    expect(times(slots)).toEqual(['11:30']);
  });

  it('respeta la antelación mínima', () => {
    const now = local('2026-10-05T09:10');
    const slots = computeFreeSlots(makeAvailabilityConfig({ minNoticeMinutes: 60 }), [], { from: now, to: local('2026-10-05T23:00') }, 30, now);
    // Primer hueco posible: 10:10 → el siguiente inicio del calendario es 10:30.
    expect(times(slots)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('nunca ofrece huecos en el pasado aunque el rango empiece antes', () => {
    const now = local('2026-10-05T10:05');
    const slots = computeFreeSlots(makeAvailabilityConfig(), [], { from: local('2026-10-05T00:00'), to: local('2026-10-05T23:00') }, 30, now);
    expect(times(slots)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('salta los días bloqueados (fecha local)', () => {
    const now = local('2026-10-04T12:00'); // domingo
    const cfg = makeAvailabilityConfig({ blackoutDates: ['2026-10-06'] });
    const slots = computeFreeSlots(cfg, [], { from: now, to: local('2026-10-07T23:00') }, 30, now);
    const days = [...new Set(stamps(slots).map((s) => s.slice(0, 10)))];
    expect(days).toEqual(['2026-10-05', '2026-10-07']);
    expect(slots).toHaveLength(12);
  });

  it('respeta maxDaysAhead aunque el rango pedido sea mayor', () => {
    const now = local('2026-10-05T08:00'); // lunes
    const cfg = makeAvailabilityConfig({ maxDaysAhead: 2 });
    const slots = computeFreeSlots(cfg, [], { from: now, to: local('2026-10-20T23:00') }, 30, now);
    // Límite: miércoles 08:00 → el miércoles a las 09:00 ya queda fuera.
    expect(slots).toHaveLength(12);
    expect(stamps(slots)[slots.length - 1]).toBe('2026-10-06 11:30');
    for (const s of slots) expect(s.start.getTime()).toBeLessThanOrEqual(now.getTime() + 2 * 24 * 3600_000);
  });

  it('devuelve vacío si el rango queda fuera de la ventana permitida', () => {
    const now = local('2026-10-05T08:00');
    expect(computeFreeSlots(makeAvailabilityConfig(), [], { from: local('2026-10-05T12:00'), to: local('2026-10-05T10:00') }, 30, now)).toEqual([]);
    expect(computeFreeSlots(makeAvailabilityConfig({ maxDaysAhead: 1 }), [], { from: local('2026-10-08T00:00'), to: local('2026-10-09T00:00') }, 30, now)).toEqual([]);
  });

  it('admite varios tramos por día, fin “24:00” e ignora formatos inválidos', () => {
    const cfg = makeAvailabilityConfig({
      slotMinutes: 60,
      weekly: makeWeek({
        '1': [
          { start: '09:00', end: '10:00' },
          { start: '9', end: '12:00' },
          { start: '22:00', end: '24:00' },
        ],
      }),
    });
    const now = local('2026-10-05T07:00');
    const slots = computeFreeSlots(cfg, [], { from: now, to: local('2026-10-06T08:00') }, 60, now);
    expect(stamps(slots)).toEqual(['2026-10-05 09:00', '2026-10-05 22:00', '2026-10-05 23:00']);
  });

  it('devuelve los huecos ordenados aunque los tramos no lo estén', () => {
    const cfg = makeAvailabilityConfig({
      weekly: makeWeek({ '1': [{ start: '17:00', end: '18:00' }, { start: '09:00', end: '10:00' }] }),
    });
    const now = local('2026-10-05T07:00');
    const slots = computeFreeSlots(cfg, [], { from: now, to: local('2026-10-05T23:00') }, 30, now);
    expect(times(slots)).toEqual(['09:00', '09:30', '17:00', '17:30']);
  });

  describe('cambios de horario (DST)', () => {
    const cfg = makeAvailabilityConfig({ weekly: makeWeek({ '1': [{ start: '09:00', end: '10:00' }], '2': [], '3': [], '4': [], '5': [{ start: '09:00', end: '10:00' }] }) });

    it('Madrid, fin del horario de verano (25/10/2026): las 09:00 locales cambian de UTC', () => {
      const now = new Date('2026-10-22T00:00:00.000Z');
      const slots = computeFreeSlots(cfg, [], { from: new Date('2026-10-23T00:00:00Z'), to: new Date('2026-10-27T00:00:00Z') }, 30, now);
      expect(iso(slots)).toEqual(['2026-10-23T07:00:00.000Z', '2026-10-23T07:30:00.000Z', '2026-10-26T08:00:00.000Z', '2026-10-26T08:30:00.000Z']);
      expect(new Set(times(slots))).toEqual(new Set(['09:00', '09:30']));
    });

    it('Madrid, inicio del horario de verano (29/03/2026)', () => {
      const now = new Date('2026-03-26T00:00:00.000Z');
      const slots = computeFreeSlots(cfg, [], { from: new Date('2026-03-27T00:00:00Z'), to: new Date('2026-03-31T00:00:00Z') }, 30, now);
      expect(iso(slots)).toEqual(['2026-03-27T08:00:00.000Z', '2026-03-27T08:30:00.000Z', '2026-03-30T07:00:00.000Z', '2026-03-30T07:30:00.000Z']);
    });

    it('Ciudad de México no cambia de hora: las 09:00 son siempre las 15:00 UTC', () => {
      const mx = { ...cfg, timezone: MEXICO };
      const now = new Date('2026-10-22T00:00:00.000Z');
      const slots = computeFreeSlots(mx, [], { from: new Date('2026-10-23T06:00:00Z'), to: new Date('2026-10-27T06:00:00Z') }, 30, now);
      expect(iso(slots)).toEqual(['2026-10-23T15:00:00.000Z', '2026-10-23T15:30:00.000Z', '2026-10-26T15:00:00.000Z', '2026-10-26T15:30:00.000Z']);
    });

    it('el día que se retrasa la hora (domingo 25/10) un tramo 01:00–04:00 tiene 4 horas reales', () => {
      const night = makeAvailabilityConfig({ slotMinutes: 60, weekly: makeWeek({ '7': [{ start: '01:00', end: '04:00' }] }) });
      const now = new Date('2026-10-20T00:00:00.000Z');
      const slots = computeFreeSlots(night, [], { from: new Date('2026-10-24T20:00:00Z'), to: new Date('2026-10-25T06:00:00Z') }, 60, now);
      expect(iso(slots)).toEqual(['2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z']);
    });

    it('el día que se adelanta la hora (domingo 29/03) un tramo 01:00–04:00 tiene 2 horas reales', () => {
      const night = makeAvailabilityConfig({ slotMinutes: 60, weekly: makeWeek({ '7': [{ start: '01:00', end: '04:00' }] }) });
      const now = new Date('2026-03-20T00:00:00.000Z');
      const slots = computeFreeSlots(night, [], { from: new Date('2026-03-28T20:00:00Z'), to: new Date('2026-03-29T06:00:00Z') }, 60, now);
      expect(iso(slots)).toEqual(['2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z']);
      expect(times(slots)).toEqual(['01:00', '03:00']);
    });
  });
});

describe('partOfDay', () => {
  it.each([
    ['2026-10-05T08:00', 'morning'],
    ['2026-10-05T13:59', 'morning'],
    ['2026-10-05T14:00', 'afternoon'],
    ['2026-10-05T18:59', 'afternoon'],
    ['2026-10-05T19:00', 'evening'],
    ['2026-10-05T23:30', 'evening'],
  ])('%s (hora local) → %s', (t, expected) => {
    expect(partOfDay(local(t), MADRID)).toBe(expected);
  });

  it('depende de la zona horaria', () => {
    const d = new Date('2026-10-05T17:00:00.000Z'); // 19:00 Madrid, 11:00 México
    expect(partOfDay(d, MADRID)).toBe('evening');
    expect(partOfDay(d, MEXICO)).toBe('morning');
  });
});

describe('pickOfferSlots', () => {
  const pool = [
    slotAt('2026-10-05T09:00'),
    slotAt('2026-10-05T09:30'),
    slotAt('2026-10-05T10:00'),
    slotAt('2026-10-05T16:00'),
    slotAt('2026-10-05T16:30'),
    slotAt('2026-10-06T09:00'),
    slotAt('2026-10-06T19:30'),
  ];

  it('por defecto ofrece 2 huecos de franjas distintas', () => {
    expect(stamps(pickOfferSlots(pool, MADRID))).toEqual(['2026-10-05 09:00', '2026-10-05 16:00']);
  });

  it('reparte los huecos entre días y franjas (variedad)', () => {
    expect(stamps(pickOfferSlots(pool, MADRID, { count: 3 }))).toEqual(['2026-10-05 09:00', '2026-10-05 16:00', '2026-10-06 09:00']);
  });

  it('filtra por fecha local', () => {
    expect(stamps(pickOfferSlots(pool, MADRID, { date: '2026-10-06' }))).toEqual(['2026-10-06 09:00', '2026-10-06 19:30']);
  });

  it('una fecha sin huecos devuelve vacío (no inventa)', () => {
    expect(pickOfferSlots(pool, MADRID, { date: '2026-10-10' })).toEqual([]);
  });

  it('filtra por franja del día', () => {
    expect(stamps(pickOfferSlots(pool, MADRID, { partOfDay: 'afternoon' }))).toEqual(['2026-10-05 16:00', '2026-10-05 16:30']);
    expect(stamps(pickOfferSlots(pool, MADRID, { partOfDay: 'evening' }))).toEqual(['2026-10-06 19:30']);
  });

  it('si la franja pedida no tiene huecos, ofrece otros del día', () => {
    const morningOnly = pool.slice(0, 3);
    expect(stamps(pickOfferSlots(morningOnly, MADRID, { partOfDay: 'evening' }))).toEqual(['2026-10-05 09:00', '2026-10-05 10:00']);
  });

  it('combina fecha y franja', () => {
    expect(stamps(pickOfferSlots(pool, MADRID, { date: '2026-10-05', partOfDay: 'morning', count: 3 }))).toEqual([
      '2026-10-05 09:00',
      '2026-10-05 09:30',
      '2026-10-05 10:00',
    ]);
  });

  it('si todo es de la misma franja, separa los huecos al menos 60 minutos', () => {
    const sameMorning = ['09:00', '09:30', '10:00', '10:30', '11:00'].map((t) => slotAt(`2026-10-05T${t}`));
    expect(times(pickOfferSlots(sameMorning, MADRID, { count: 3 }))).toEqual(['09:00', '10:00', '11:00']);
  });

  it('limita la cantidad entre 1 y 5', () => {
    const many = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00'].flatMap((t) => [slotAt(`2026-10-05T${t}`), slotAt(`2026-10-06T${t}`)]);
    expect(pickOfferSlots(many, MADRID, { count: 10 })).toHaveLength(5);
    expect(pickOfferSlots(many, MADRID, { count: 0 })).toHaveLength(1);
  });

  it('devuelve los huecos ordenados cronológicamente', () => {
    const shuffled = [pool[5], pool[3], pool[0], pool[6]];
    const picked = pickOfferSlots(shuffled, MADRID, { count: 3 });
    const sorted = [...picked].sort((a, b) => a.start.getTime() - b.start.getTime());
    expect(picked).toEqual(sorted);
  });

  it('la franja se calcula en la zona del negocio (México)', () => {
    const mx = [slotAt('2026-10-05T09:00', MEXICO), slotAt('2026-10-05T15:00', MEXICO), slotAt('2026-10-05T20:00', MEXICO)];
    expect(times(pickOfferSlots(mx, MEXICO, { partOfDay: 'evening' }), MEXICO)).toEqual(['20:00']);
    expect(times(pickOfferSlots(mx, MEXICO, { partOfDay: 'afternoon' }), MEXICO)).toEqual(['15:00']);
  });
});
