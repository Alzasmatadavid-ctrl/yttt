/**
 * Setter de extremo a extremo con el simulador (/api/simulator/...), en modo simulación
 * (AI_PROVIDER=simulated: análisis heurístico + motor de reglas, deterministas).
 *
 * Usa exactamente el mismo motor que en producción: análisis, estrategia, agenda real,
 * control de calidad, CRM y automatizaciones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { followUps, leads, scheduledJobs } from '../../src/database/schema.js';
import { MEDICAL_MESSAGE } from '../../src/ai/setter/setter-engine.js';
import type { OfferedSlot } from '../../src/lib/domain.js';
import { openAgenda, questionCount, registerTrainer, setupTestApp, teardownTestApp, wideRange, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
const SERVICE = { name: 'Plan Transformación 12 semanas', priceCents: 14900, billingPeriod: 'monthly', includes: ['Plan de entrenamiento', 'Pautas de nutrición'] };

/** Respuestas del lead según la variable que KAI le acaba de preguntar. */
const ANSWERS: Record<string, string> = {
  goal: 'Quiero perder 10 kilos para mi boda en junio',
  current_situation: 'Ahora mismo no entreno nada, trabajo en una oficina y ceno mal',
  problem: 'No soy constante, me cuesta organizarme con el trabajo',
  motivation: 'Quiero sentirme bien conmigo misma el día de mi boda',
  previous_attempts: 'He probado dietas y el gimnasio pero lo dejo siempre',
  frustration: 'Que nunca me funciona a largo plazo y recupero el peso',
  urgency: 'Me caso en junio y quiero empezar cuanto antes',
  commitment: 'Sí, estoy dispuesta, voy en serio',
  budget: 'Sí, puedo invertir en ello',
};

/** Seguimiento genérico prohibido (“solo hago seguimiento”…). */
const GENERIC_FOLLOW_UP = /solo (hago|te hago|queria hacer|para hacer) (un )?seguimiento|solo queria saber si|te escribo para hacer seguimiento|hago seguimiento/i;

interface SetterResult {
  status: 'sent' | 'skipped' | 'handoff' | 'blocked' | 'failed';
  reason?: string;
  text?: string;
  directive?: string;
  messageId?: string;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  senderType: string;
  content: string;
  status: string;
  metadata: Record<string, unknown>;
}

let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit' });
  await openAgenda(T.client);
  const svc = await T.client.put('/api/settings/primary-service', SERVICE);
  expect(svc.statusCode).toBe(200);
});

afterAll(async () => {
  await teardownTestApp(app);
});

/** Conversación de prueba con un “lead” del simulador. */
class SimConversation {
  constructor(
    readonly id: string,
    readonly leadId: string,
  ) {}

  static async start(leadName = 'Marta') {
    const res = await T.client.post('/api/simulator/conversations', { leadName });
    expect(res.statusCode).toBe(200);
    return new SimConversation(res.json().conversationId, res.json().leadId);
  }

  async say(text: string): Promise<SetterResult> {
    const res = await T.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result as SetterResult;
  }

  async detail() {
    const res = await T.client.get(`/api/simulator/conversations/${this.id}`);
    expect(res.statusCode).toBe(200);
    return res.json() as {
      conversation: { id: string; aiEnabled: boolean; handoffActive: boolean; handoffReason: string | null; state: Record<string, any> };
      lead: { id: string; status: string; score: number; optedOut: boolean; isTest: boolean; source: string };
      messages: Message[];
      pendingFollowUps: { id: string; step: number; jobId: string }[];
      events: { type: string }[];
    };
  }

  async outbound() {
    return (await this.detail()).messages.filter((m) => m.direction === 'outbound');
  }

  /** Responde a las preguntas de cualificación hasta que KAI propone la llamada. */
  async qualifyUntilCallProposed(maxTurns = 12): Promise<{ results: SetterResult[]; proposal: SetterResult }> {
    const results: SetterResult[] = [];
    let r = await this.say('Hola! Vi tu anuncio');
    results.push(r);
    for (let i = 0; i < maxTurns && r.directive !== 'propose_call'; i++) {
      const key = (await this.detail()).conversation.state.lastAskedKey as string | undefined;
      r = await this.say((key && ANSWERS[key]) || 'Vale, te cuento lo que necesites');
      results.push(r);
    }
    expect(r.directive, `KAI no llegó a proponer la llamada: ${JSON.stringify(results.map((x) => x.directive))}`).toBe('propose_call');
    return { results, proposal: r };
  }
}

const localHm = (iso: string) => DateTime.fromISO(iso).setZone(TZ).toFormat('HH:mm');

async function jobsForBusiness() {
  return getDb().select().from(scheduledJobs).where(eq(scheduledJobs.businessId, T.businessId));
}

describe('flujo completo: saludo → cualificación → llamada → cita', () => {
  it('KAI se presenta, cualifica con una pregunta por mensaje, ofrece horarios reales y reserva “la primera”', async () => {
    const conv = await SimConversation.start('Marta');

    const { results, proposal } = await conv.qualifyUntilCallProposed();

    // 1) Saludo: se presenta como asistente virtual.
    const greeting = results[0];
    expect(greeting.status).toBe('sent');
    expect(greeting.directive).toBe('greet_and_ask');
    expect(greeting.text).toMatch(/asistente virtual/i);
    expect(greeting.text).toContain('KAI');
    expect(greeting.text).toContain('Marta');

    // 2) Cualificación: siempre una sola pregunta por mensaje, y sin repetirse.
    const qualifying = results.slice(1, -1);
    expect(qualifying.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.status).toBe('sent');
      expect(questionCount(r.text!), r.text).toBeLessThanOrEqual(1);
    }
    for (const r of qualifying) {
      expect(r.directive).toBe('ask_qualification');
      expect(questionCount(r.text!), r.text).toBe(1);
    }
    const texts = results.map((r) => r.text);
    expect(new Set(texts).size).toBe(texts.length);

    // 3) Propuesta de llamada, todavía sin horarios.
    expect(proposal.text).toMatch(/llamada/i);
    expect(proposal.text).not.toMatch(/\d{1,2}:\d{2}/);
    let detail = await conv.detail();
    expect(detail.lead.status).toBe('call_proposed');
    expect(detail.conversation.state.callProposedAt).toBeTruthy();
    expect(detail.lead.score).toBeGreaterThan(0);

    // 4) Acepta y pide una franja: KAI ofrece horarios REALES de la agenda.
    const offer = await conv.say('Sí, me encaja. Mejor mañana por la tarde');
    expect(offer.status).toBe('sent');
    expect(offer.directive).toBe('offer_slots');
    expect(questionCount(offer.text!)).toBe(1);
    detail = await conv.detail();
    const state = detail.conversation.state as { offeredSlots: OfferedSlot[]; lastOfferIds: string[] };
    const offered = state.lastOfferIds.map((id) => state.offeredSlots.find((s) => s.id === id)!);
    expect(offered.length).toBeGreaterThanOrEqual(1);
    expect(offered.length).toBeLessThanOrEqual(3);
    const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate();
    const free = (await T.client.get('/api/agenda/slots')).json().slots as { id: string; start: string }[];
    for (const s of offered) {
      expect(free.map((f) => f.id), `El horario ofrecido ${s.label} no existe en la agenda real`).toContain(s.id);
      expect(DateTime.fromISO(s.start).setZone(TZ).toISODate()).toBe(tomorrow);
      expect(DateTime.fromISO(s.start).setZone(TZ).hour).toBeGreaterThanOrEqual(14);
      expect(offer.text).toContain(localHm(s.start));
    }
    expect(offer.text).toMatch(/mañana/);

    // 5) “La primera” → cita creada en ese horario exacto.
    const booking = await conv.say('La primera');
    expect(booking.status).toBe('sent');
    expect(booking.directive).toBe('book_slot');
    expect(booking.text).toContain(localHm(offered[0].start));
    expect(questionCount(booking.text!)).toBeLessThanOrEqual(1);

    const appts = (await T.client.get('/api/agenda/appointments', { query: wideRange() })).json().appointments as {
      appointment: { id: string; startsAt: string; status: string; bookedBy: string; leadId: string; conversationId: string };
      lead: { id: string; status: string };
    }[];
    const mine = appts.filter((x) => x.lead.id === conv.leadId);
    expect(mine).toHaveLength(1);
    const appt = mine[0].appointment;
    expect(new Date(appt.startsAt).toISOString()).toBe(new Date(offered[0].start).toISOString());
    expect(appt.status).toBe('scheduled');
    expect(appt.bookedBy).toBe('kai');
    expect(appt.conversationId).toBe(conv.id);
    expect(mine[0].lead.status).toBe('call_booked');

    detail = await conv.detail();
    expect(detail.lead.status).toBe('call_booked');
    expect(detail.events.map((e) => e.type)).toContain('call_booked');
    // El hueco reservado ya no se ofrece a nadie más.
    const freeAfter = (await T.client.get('/api/agenda/slots')).json().slots as { id: string }[];
    expect(freeAfter.map((f) => f.id)).not.toContain(offered[0].id);

    // 6) Automatizaciones: recordatorio 1 h antes y aviso post-llamada; sin seguimientos pendientes.
    const jobs = (await jobsForBusiness()).filter((j) => (j.payload as { appointmentId?: string }).appointmentId === appt.id);
    const pending = jobs.filter((j) => j.status === 'pending');
    expect(pending.map((j) => j.dedupeKey)).toEqual(expect.arrayContaining([`appt:${appt.id}:r1`, `appt:${appt.id}:post`]));
    const reminder = pending.find((j) => j.dedupeKey === `appt:${appt.id}:r1`)!;
    expect(reminder.type).toBe('appointment_reminder');
    expect(reminder.runAt.getTime()).toBe(new Date(appt.startsAt).getTime() - 3600_000);
    expect(pending.find((j) => j.dedupeKey === `appt:${appt.id}:post`)!.type).toBe('post_call');
    // KAI ya confirmó la cita en su mensaje: no se manda otra confirmación.
    expect(jobs.some((j) => j.type === 'appointment_confirmation')).toBe(false);

    expect(detail.pendingFollowUps).toHaveLength(0);
    const leadFollowUpJobs = (await jobsForBusiness()).filter((j) => j.type === 'followup' && (j.payload as { leadId?: string }).leadId === conv.leadId);
    expect(leadFollowUpJobs.length).toBeGreaterThan(0);
    expect(leadFollowUpJobs.every((j) => j.status !== 'pending')).toBe(true);

    // Ningún mensaje de KAI en toda la conversación hace más de una pregunta.
    for (const m of await conv.outbound()) expect(questionCount(m.content), m.content).toBeLessThanOrEqual(1);
  });

  it('una vez agendada, un “gracias” recibe una respuesta breve sin volver a cualificar', async () => {
    const conv = await SimConversation.start('Nuria');
    await conv.qualifyUntilCallProposed();
    await conv.say('Sí, me encaja. Mejor mañana por la tarde');
    await conv.say('La primera');
    const r = await conv.say('Genial, gracias');
    expect(r.status).toBe('sent');
    expect(r.directive).toBe('post_booking');
    expect(questionCount(r.text!)).toBe(0);
  });
});

describe('naturalidad', () => {
  /**
   * BUG (src/ai/setter/agents.ts → RuleBasedSetterAgent.respond, cálculo de `eventAck`):
   * cada mensaje del lead que menciona “boda” (o vacaciones/hijos) hace que KAI empiece su respuesta
   * con la misma felicitación, sin mirar si ya la dio. Entrada: el lead menciona su boda en tres
   * mensajes seguidos. Resultado: “¡Enhorabuena por la boda! 🎉” tres veces seguidas.
   * Esperado: felicitar una sola vez y, después, usar otro reconocimiento (“Entiendo”, “Vale”…).
   * Afecta al modo simulación y al motor de reglas que se usa como último recurso si la IA falla.
   */
  it('no repite la misma felicitación en mensajes seguidos', async () => {
    const conv = await SimConversation.start('Marta');
    await conv.say('Hola!');
    await conv.say('Quiero perder 10 kilos para mi boda en junio');
    await conv.say('Ahora mismo no entreno nada, con los preparativos de la boda no paro');
    await conv.say('Pues que con la boda no tengo tiempo');
    const congrats = (await conv.outbound()).filter((m) => /enhorabuena por la boda/i.test(m.content));
    expect(congrats.length).toBeLessThanOrEqual(1);
  });
});

describe('precio', () => {
  it('la primera vez contextualiza; si insiste, da el precio REAL configurado', async () => {
    const conv = await SimConversation.start('Pedro');
    const first = await conv.say('Hola, ¿cuánto cuesta?');
    expect(first.status).toBe('sent');
    expect(first.directive).toBe('price_contextualize');
    expect(first.text).toMatch(/asistente virtual/i); // primer mensaje: se presenta
    expect(first.text).not.toMatch(/€|\d+\s?euros?/i);
    expect(questionCount(first.text!)).toBe(1);

    const second = await conv.say('Ya, pero dime el precio, ¿cuánto es?');
    expect(second.status).toBe('sent');
    expect(second.directive).toBe('share_price');
    expect(second.text).toContain(SERVICE.name);
    expect(second.text).toMatch(/149\s?€/);
    expect(second.text).toMatch(/al mes/);
    expect(questionCount(second.text!)).toBe(1);
    // Ningún otro importe que no sea el configurado.
    const amounts = [...second.text!.matchAll(/(\d+(?:[.,]\d+)?)\s?€/g)].map((m) => m[1]);
    expect(amounts.every((x) => x === '149')).toBe(true);

    const detail = await conv.detail();
    expect(detail.conversation.state.priceShared).toBe(true);
    expect(detail.conversation.state.priceAskedCount).toBe(2);

    // Si vuelve a preguntar, recuerda el mismo importe sin repetir el mensaje anterior.
    const third = await conv.say('¿Cuánto era el precio?');
    expect(third.directive).toBe('share_price');
    expect(third.text).toMatch(/149\s?€/);
    expect(third.text).not.toBe(second.text);
  });
});

describe('seguridad y escalado', () => {
  it('petición de hablar con una persona → mensaje de traspaso y KAI deja de responder', async () => {
    const conv = await SimConversation.start('Luis');
    await conv.say('Hola');
    const r = await conv.say('Quiero hablar con una persona real');
    expect(r.status).toBe('handoff');
    expect(r.reason).toBe('human_request');
    expect(r.text).toContain('Laura Gómez');

    const detail = await conv.detail();
    expect(detail.conversation.handoffActive).toBe(true);
    expect(detail.conversation.handoffReason).toBe('human_request');
    expect(detail.events.map((e) => e.type)).toContain('handoff');
    const last = detail.messages[detail.messages.length - 1];
    expect(last.direction).toBe('outbound');
    expect(last.metadata.purpose).toBe('handoff');

    const before = (await conv.outbound()).length;
    const after = await conv.say('¿Hola? ¿Sigues ahí?');
    expect(after.status).toBe('skipped');
    expect(after.reason).toBe('handoff_active');
    expect((await conv.outbound()).length).toBe(before);
  });

  it('tema médico → mensaje seguro exacto y traspaso al entrenador', async () => {
    const conv = await SimConversation.start('Elena');
    await conv.say('Hola');
    const r = await conv.say('Tengo diabetes y me pincho insulina, ¿puedo entrenar igualmente?');
    expect(r.status).toBe('handoff');
    expect(r.reason).toBe('medical');
    expect(r.text).toBe(MEDICAL_MESSAGE);

    const detail = await conv.detail();
    const last = detail.messages[detail.messages.length - 1];
    expect(last.direction).toBe('outbound');
    expect(last.content).toBe(MEDICAL_MESSAGE);
    expect(last.metadata.kind).toBe('medical_redirect');
    expect(detail.conversation.handoffActive).toBe(true);
    expect(detail.conversation.handoffReason).toBe('medical');
    expect(detail.conversation.state.medicalFlag).toBe(true);

    const after = await conv.say('¿Entonces qué hago?');
    expect(after.status).toBe('skipped');
    expect((await conv.outbound()).at(-1)!.content).toBe(MEDICAL_MESSAGE);
  });

  it('baja → confirma, marca optedOut, cancela seguimientos y no vuelve a responder', async () => {
    const conv = await SimConversation.start('Sergio');
    await conv.say('Hola');
    expect((await conv.detail()).pendingFollowUps.length).toBe(1);

    const r = await conv.say('No me escribas más, por favor');
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('opted_out');
    expect(r.text).toMatch(/no te escribiremos más/i);

    const detail = await conv.detail();
    expect(detail.lead.optedOut).toBe(true);
    expect(detail.conversation.aiEnabled).toBe(false);
    expect(detail.pendingFollowUps).toHaveLength(0);
    const pendingForLead = (await jobsForBusiness()).filter((j) => j.status === 'pending' && (j.payload as { leadId?: string }).leadId === conv.leadId);
    expect(pendingForLead).toHaveLength(0);

    const before = (await conv.outbound()).length;
    for (const text of ['¿Hola?', 'Oye, al final sí me interesa']) {
      const again = await conv.say(text);
      expect(again.status).toBe('skipped');
    }
    expect((await conv.outbound()).length).toBe(before);
    // Ni siquiera forzando un seguimiento.
    const fu = await T.client.post(`/api/simulator/conversations/${conv.id}/follow-up`);
    expect(fu.statusCode).toBe(400);
    expect((await conv.outbound()).length).toBe(before);
  });
});

describe('objeciones', () => {
  it('tras proponer la llamada, “me lo tengo que pensar” se trata como objeción sin presionar', async () => {
    const conv = await SimConversation.start('Irene');
    await conv.qualifyUntilCallProposed();
    const r = await conv.say('Uf, no sé, me lo tengo que pensar');
    expect(r.status).toBe('sent');
    expect(r.directive).toBe('handle_objection');
    expect(questionCount(r.text!)).toBeLessThanOrEqual(1);
    expect(r.text).not.toMatch(/\d{1,2}:\d{2}/); // no ofrece horarios
    expect(r.text).not.toMatch(/€/); // no saca el precio
    expect(r.text).not.toMatch(/última oportunidad|solo hoy|plazas limitadas/i);

    const detail = await conv.detail();
    expect(detail.conversation.state.objectionsHandled).toContain('think_about_it');
    expect(detail.lead.status).toBe('call_proposed');
    expect((await T.client.get('/api/agenda/appointments', { query: wideRange() })).json().appointments.filter((a: { lead: { id: string } }) => a.lead.id === conv.leadId)).toHaveLength(0);
  });
});

describe('lead de formulario y seguimientos', () => {
  it('KAI escribe primero al lead del formulario y el seguimiento forzado usa su contexto', async () => {
    const res = await T.client.post('/api/simulator/form-lead', { name: 'Carlos Pérez', goal: 'ganar músculo' });
    expect(res.statusCode).toBe(200);
    const { conversationId, leadId, result } = res.json() as { conversationId: string; leadId: string; result: SetterResult };
    expect(result.status).toBe('sent');
    expect(result.directive).toBe('first_contact');
    expect(result.text).toContain('Carlos');
    expect(result.text).toMatch(/asistente virtual/i);
    expect(result.text).toMatch(/ganar músculo/);
    expect(questionCount(result.text!)).toBe(1);

    const [lead] = await getDb().select().from(leads).where(eq(leads.id, leadId));
    expect(lead.isTest).toBe(true);
    expect(lead.source).toBe('simulator');
    expect(lead.goalSummary).toBe('ganar músculo');

    // El primer contacto no se duplica desde la cola.
    const firstContactJobs = (await jobsForBusiness()).filter((j) => j.dedupeKey === `first_contact:${leadId}`);
    expect(firstContactJobs.every((j) => j.status === 'cancelled')).toBe(true);

    const conv = new SimConversation(conversationId, leadId);
    let detail = await conv.detail();
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].metadata.purpose).toBe('first_contact');
    expect(detail.pendingFollowUps).toHaveLength(1);
    expect(detail.pendingFollowUps[0].step).toBe(1);

    // Forzar el seguimiento ahora.
    const fu = await T.client.post(`/api/simulator/conversations/${conversationId}/follow-up`);
    expect(fu.statusCode, fu.body).toBe(200);
    detail = await conv.detail();
    const out = detail.messages.filter((m) => m.direction === 'outbound');
    expect(out).toHaveLength(2);
    const followUp = out[1];
    expect(followUp.metadata.purpose).toBe('follow_up');
    expect(followUp.content).not.toMatch(GENERIC_FOLLOW_UP);
    expect(followUp.content).not.toBe(out[0].content);
    // Usa algo concreto del lead: su nombre y su objetivo.
    expect(followUp.content).toContain('Carlos');
    expect(followUp.content).toMatch(/ganar músculo/);
    expect(questionCount(followUp.content)).toBeLessThanOrEqual(1);

    const [sentFu] = await getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, leadId), eq(followUps.status, 'sent')));
    expect(sentFu.step).toBe(1);
    expect(sentFu.messageId).toBe(followUp.id);
    // Queda programado el siguiente paso.
    expect(detail.pendingFollowUps).toHaveLength(1);
    expect(detail.pendingFollowUps[0].step).toBe(2);
    expect(detail.lead.status).toBe('follow_up');
  });

  it('si el lead responde, el seguimiento pendiente se cancela', async () => {
    const conv = await SimConversation.start('Raúl');
    await conv.say('Hola');
    const pending = (await conv.detail()).pendingFollowUps;
    expect(pending).toHaveLength(1);
    await conv.say('Quiero ganar músculo');
    const [old] = await getDb().select().from(followUps).where(eq(followUps.id, pending[0].id));
    expect(old.status).toBe('cancelled');
    const [oldJob] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.id, pending[0].jobId));
    expect(oldJob.status).toBe('cancelled');
  });
});

describe('reglas del simulador', () => {
  it('no permite usar el simulador con conversaciones de leads reales', async () => {
    const lead = (await T.client.post('/api/leads', { name: 'Lead Real' })).json().lead;
    const conv = (await T.client.post(`/api/leads/${lead.id}/start-test-conversation`)).json();
    const res = await T.client.post(`/api/simulator/conversations/${conv.conversationId}/messages`, { text: 'Hola' });
    expect(res.statusCode).toBe(400);
    expect((await T.client.delete(`/api/simulator/conversations/${conv.conversationId}`)).statusCode).toBe(400);
    expect((await T.client.get(`/api/leads/${lead.id}`)).statusCode).toBe(200);
  });

  it('los leads del simulador no aparecen en los listados normales', async () => {
    const sim = await SimConversation.start('Lead Simulado');
    const list = (await T.client.get('/api/leads')).json().leads as { id: string }[];
    expect(list.map((l) => l.id)).not.toContain(sim.leadId);
    const withTest = (await T.client.get('/api/leads?includeTest=true')).json().leads as { id: string }[];
    expect(withTest.map((l) => l.id)).toContain(sim.leadId);
    // Se puede borrar desde el simulador.
    expect((await T.client.delete(`/api/simulator/conversations/${sim.id}`)).statusCode).toBe(200);
    expect((await T.client.get(`/api/leads/${sim.leadId}`)).statusCode).toBe(404);
  });
});
