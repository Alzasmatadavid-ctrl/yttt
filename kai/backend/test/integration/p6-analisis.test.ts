/**
 * Revisión nº6 (análisis de horarios), de extremo a extremo con base de datos en memoria y sin IA:
 *  - tras dos «ninguna me va bien» seguidos, KAI no vuelve a ofrecer los días que ya descartó (y lo olvida al reservar);
 *  - «no puedo antes de las 18:00» llega a la agenda: no se le ofrece ningún horario anterior;
 *  - la herramienta de agenda no ofrece las horas descartadas aunque la IA no las pase.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { conversations } from '../../src/database/schema.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import { loadBusinessContext, loadConversationContext, loadLeadContext } from '../../src/ai/context/context.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Álex Romero', businessName: 'Álex Fit' });
  await openAgenda(T.client);
});

afterAll(async () => {
  await teardownTestApp(app);
});

async function start(leadName: string) {
  const res = await T.client.post('/api/simulator/conversations', { leadName });
  expect(res.statusCode).toBe(200);
  const { conversationId, leadId } = res.json() as { conversationId: string; leadId: string };
  const say = async (text: string) => {
    const r = await T.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result as { status: string; directive?: string; text?: string };
  };
  const state = async () => {
    const [c] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    return c.state as SetterState;
  };
  /** Días (en Madrid) de la última oferta. */
  const offeredDays = async () => {
    const s = await state();
    return new Set((s.lastOfferIds ?? []).map((id) => DateTime.fromISO(s.offeredSlots!.find((o) => o.id === id)!.start).setZone(TZ).toISODate()!));
  };
  const offeredTimes = async () => {
    const s = await state();
    return (s.lastOfferIds ?? []).map((id) => DateTime.fromISO(s.offeredSlots!.find((o) => o.id === id)!.start).setZone(TZ).toFormat('HH:mm'));
  };
  return { conversationId, leadId, say, state, offeredDays, offeredTimes };
}

describe('rechazos acumulados al buscar horario', () => {
  it('tras dos «ninguna», la tercera oferta no repite ningún día descartado; al reservar se olvidan', async () => {
    const sim = await start('Rubén Ortega');
    const first = await sim.say('Hola, quiero hacer la llamada');
    expect(first.directive).toBe('offer_slots');
    const days1 = await sim.offeredDays();
    expect(days1.size).toBeGreaterThan(0);

    const second = await sim.say('Ninguna me va bien');
    expect(second.directive).toBe('offer_slots');
    const days2 = await sim.offeredDays();
    for (const d of days2) expect(days1.has(d), `repite el ${d}`).toBe(false);
    expect((await sim.state()).rejectedDates).toEqual([...days1].sort());

    const third = await sim.say('Tampoco me va ninguna, ¿otro día?');
    expect(third.directive).toBe('offer_slots');
    const days3 = await sim.offeredDays();
    for (const d of days3) expect(days1.has(d) || days2.has(d), `repite el ${d}`).toBe(false);
    expect((await sim.state()).rejectedDates).toEqual([...new Set([...days1, ...days2])].sort());

    const booked = await sim.say('La primera');
    expect(booked.directive).toBe('book_slot');
    expect((await sim.state()).rejectedDates).toBeUndefined();
  });
});

describe('límites de hora', () => {
  it('«no puedo antes de las 18:00»: todos los horarios que se le ofrecen son a partir de las 18:00', async () => {
    const sim = await start('Iván Prieto');
    const res = await sim.say('Quiero hacer la llamada, pero no puedo antes de las 18:00');
    expect(res.directive).toBe('offer_slots');
    const times = await sim.offeredTimes();
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t >= '18:00', `ofrece las ${t}`).toBe(true);
    expect((await sim.state()).rejectedTimes).toEqual(['<18:00']);
  });

  it('la herramienta de agenda aplica las horas descartadas del turno aunque la IA no las pase', async () => {
    const sim = await start('Marta Gil');
    await sim.say('Hola');
    const biz = await loadBusinessContext(T.businessId);
    const leadCtx = await loadLeadContext(T.businessId, sim.leadId);
    const conv = (await loadConversationContext(T.businessId, sim.conversationId)).conversation;
    const box = new SetterToolbox(biz, leadCtx, conv, { directive: { kind: 'offer_slots', slotQuery: { excludeTimes: ['<20:00'] } } });
    const r = await box.run('get_available_slots', { date: null, part_of_day: 'any' });
    expect(r.isError).toBe(false);
    const times = await sim.offeredTimes();
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t >= '20:00', `ofrece las ${t}`).toBe(true);
  });
});
