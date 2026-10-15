/**
 * p6-integrador, de extremo a extremo con base de datos en memoria y sin IA (simulador):
 *  - lead de México que pide una hora que no se le ofreció: KAI le pregunta de qué país es esa hora y, con «la mía»,
 *    le ofrece y reserva las 11:00 de México (el motor pasa el historial con el mensaje que se analiza al final);
 *  - «¿No tienes nada más tarde?» le ofrece horarios posteriores a los que tenía;
 *  - con la llamada agendada, «Al final no voy a poder, tengo que cancelar la llamada» la cancela;
 *  - tras cerrar la objeción del precio por tercera vez, un «Vale» no recibe otra pregunta.
 * Los horarios ofrecidos se fijan en el estado de la conversación para que el test no dependa de la hora a la que se ejecuta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations, leads, messages } from '../../src/database/schema.js';
import { slotId } from '../../src/calendar/availability.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { futureLocal, openAgenda, questionCount, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
const MX = 'America/Mexico_City';
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

async function start(leadName: string, whatsappId?: string) {
  const res = await T.client.post('/api/simulator/conversations', { leadName });
  expect(res.statusCode).toBe(200);
  const { conversationId, leadId } = res.json() as { conversationId: string; leadId: string };
  if (whatsappId) await getDb().update(leads).set({ whatsappId }).where(eq(leads.id, leadId));
  const say = async (text: string) => {
    const r = await T.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result as { status: string; directive?: string; text?: string };
  };
  const state = async () => (await getDb().select().from(conversations).where(eq(conversations.id, conversationId)))[0].state as SetterState;
  /** Horarios de la última oferta. */
  const offered = async () => {
    const s = await state();
    return (s.lastOfferIds ?? []).map((id) => DateTime.fromISO(s.offeredSlots!.find((o) => o.id === id)!.start));
  };
  /** Sustituye la última oferta por estos horarios (y el último mensaje de KAI por uno que los nombra). */
  const forceOffer = async (starts: Date[]) => {
    const slots = starts.map((start) => ({
      id: slotId(start),
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      label: humanSlotLabel(start, TZ, new Date(), { leadPhone: whatsappId }),
    }));
    const s = await state();
    await getDb()
      .update(conversations)
      .set({ state: { ...s, offeredSlots: slots, lastOfferIds: slots.map((x) => x.id), offeredAt: new Date().toISOString() } })
      .where(eq(conversations.id, conversationId));
    const [last] = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    await getDb()
      .update(messages)
      .set({ content: `Perfecto. Tengo ${slots.map((x) => x.label).join(' o ')}. ¿Cuál te viene mejor?` })
      .where(eq(messages.id, last.id));
  };
  const appts = async () => getDb().select().from(appointments).where(eq(appointments.leadId, leadId));
  return { conversationId, leadId, say, state, offered, forceOffer, appts };
}

describe('lead de México que pide una hora que no se le ofreció', () => {
  it('KAI pregunta de qué país es, y con «la mía» ofrece y reserva las 11:00 de México', async () => {
    const sim = await start('Luis Hernández', '5215512345678');
    expect((await sim.say('Hola, quiero hacer la llamada')).directive).toBe('offer_slots');
    // Pasado mañana a las 9:00 y 9:30 en España (la 1:00 y la 1:30 en México): ninguna es «las 11» en ninguna zona.
    await sim.forceOffer([futureLocal(2, 9), futureLocal(2, 9, 30)]);

    const ask = await sim.say('A las 11 me va bien');
    expect(ask.directive).toBe('clarify_slot');
    expect(ask.text).toMatch(/España/);
    expect(ask.text).toMatch(/México/);
    expect(ask.text).not.toMatch(/\d/);

    const offer = await sim.say('La mía');
    expect(offer.directive).toBe('offer_slots');
    const times = (await sim.offered()).map((d) => d.setZone(MX).toFormat('HH:mm'));
    expect(times[0]).toBe('11:00');

    const booked = await sim.say('La primera');
    expect(booked.directive).toBe('book_slot');
    const [appt] = (await sim.appts()).filter((a) => a.status === 'scheduled');
    expect(DateTime.fromJSDate(appt.startsAt).setZone(MX).toFormat('HH:mm')).toBe('11:00');
  });
});

describe('pedir algo más tarde y cancelar', () => {
  it('«¿No tienes nada más tarde?» ofrece horarios posteriores; con la llamada agendada, «tengo que cancelarla» la cancela', async () => {
    const sim = await start('Andrés Silva');
    expect((await sim.say('Hola, quiero hacer la llamada')).directive).toBe('offer_slots');
    await sim.forceOffer([futureLocal(2, 18), futureLocal(3, 18)]);

    const later = await sim.say('¿No tienes nada más tarde?');
    expect(later.directive).toBe('offer_slots');
    const times = (await sim.offered()).map((d) => d.setZone(TZ).toFormat('HH:mm'));
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t > '18:00', `ofrece las ${t}`).toBe(true);

    expect((await sim.say('La primera')).directive).toBe('book_slot');
    expect((await sim.appts()).filter((a) => a.status === 'scheduled')).toHaveLength(1);

    const cancel = await sim.say('Al final no voy a poder, tengo que cancelar la llamada');
    expect(cancel.directive).toBe('cancel_booking');
    expect(cancel.text).not.toMatch(/lo movemos|¿Cuál te viene mejor\?/);
    expect((await sim.appts()).map((a) => a.status)).toEqual(['cancelled']);
  });
});

describe('objeción del precio por tercera vez', () => {
  it('tras el cierre sin insistir, un «Vale» no recibe otra pregunta', async () => {
    const sim = await start('Miguel Torres');
    await sim.say('Hola, ¿cuánto cuesta?');
    expect((await sim.say('Ya, pero dime el precio')).directive).toBe('share_price');
    await sim.say('Es caro');
    await sim.say('Es caro, la verdad');
    const closing = await sim.say('Sigue siendo caro para mí');
    expect(closing.directive).toBe('handle_objection');
    expect(questionCount(closing.text ?? '')).toBe(0);
    const ack = await sim.say('Vale');
    expect(ack.directive).toBe('continue_without_call');
    expect(questionCount(ack.text ?? ''), ack.text).toBe(0);
  });
});
