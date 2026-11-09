/**
 * Ronda 5 (integración final), con base de datos PGlite y la app real:
 * - Agendar a mano: el servidor dice si KAI avisará al lead (willNotify) y, si no tiene conversación, el worker deja
 *   un aviso «Mensaje no enviado» en vez de no hacer nada.
 * - Leads dados de baja fuera de «Calientes» y «No respondieron» en la Bandeja.
 * - Sin seguimientos para el lead que no encaja (y se cancelan los pendientes al saberse).
 * - Simulador sin IA: un día descartado no se vuelve a ofrecer, «a las 10» busca huecos a esa hora y desistir de mover
 *   la llamada olvida la oferta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, automations, conversations, followUps, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { runJob } from '../../src/automation/worker.js';
import { scheduleNoReplyFollowUp } from '../../src/automation/followups.js';
import { mergeQualification } from '../../src/crm/leads.service.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
const ANSWERS: Record<string, string> = {
  goal: 'Quiero perder unos 10 kilos, sobre todo la barriga',
  current_situation: 'Trabajo en oficina, ahora mismo no entreno y como bastante mal',
  problem: 'Me cuesta ser constante, lo dejo a las dos semanas',
  motivation: 'Por salud, tengo dos hijos pequeños y quiero estar bien',
  previous_attempts: 'He probado dietas y el gimnasio por mi cuenta',
  frustration: 'Que siempre recupero el peso y me desanimo',
  urgency: 'Quiero empezar ya, cuanto antes',
  commitment: 'Sí, estoy dispuesto, voy en serio',
  budget: 'Sí, puedo invertir si merece la pena',
};

let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Álex Romero', businessName: 'Álex Fit' });
  await openAgenda(T.client);
  const svc = await T.client.put('/api/settings/primary-service', { name: 'Programa Recomposición', priceCents: 14900, billingPeriod: 'monthly' });
  expect(svc.statusCode).toBe(200);
});

afterAll(async () => {
  await teardownTestApp(app);
});

async function newLead(name: string, withConversation: boolean) {
  const res = await T.client.post('/api/leads', { name });
  expect(res.statusCode, res.body).toBe(200);
  const leadId = res.json().lead.id as string;
  if (!withConversation) return { leadId, conversationId: null };
  const conv = await T.client.post(`/api/leads/${leadId}/start-test-conversation`);
  expect(conv.statusCode, conv.body).toBe(200);
  return { leadId, conversationId: conv.json().conversationId as string };
}

async function runJobNow(jobId: string) {
  const [job] = await getDb()
    .update(scheduledJobs)
    .set({ status: 'running', attempts: sql`${scheduledJobs.attempts} + 1`, lockedAt: new Date() })
    .where(eq(scheduledJobs.id, jobId))
    .returning();
  await runJob(job);
}

describe('Agendar a mano: ¿avisará KAI al lead?', () => {
  it('willNotify según tenga conversación o esté de baja, y aviso si no hay por dónde escribirle', async () => {
    const withConv = await newLead('Lucía Con Chat', true);
    const ok = await T.client.post('/api/agenda/appointments', { leadId: withConv.leadId, start: futureLocal(3, 10).toISOString(), conversationId: withConv.conversationId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().willNotify).toBe(true);

    const optedOut = await newLead('Marta De Baja', true);
    await getDb().update(leads).set({ optedOut: true }).where(eq(leads.id, optedOut.leadId));
    const off = await T.client.post('/api/agenda/appointments', { leadId: optedOut.leadId, start: futureLocal(3, 12).toISOString() });
    expect(off.json().willNotify).toBe(false);

    const noConv = await newLead('Nuria Sin Chat', false);
    const res = await T.client.post('/api/agenda/appointments', { leadId: noConv.leadId, start: futureLocal(3, 16).toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().willNotify).toBe(false);
    const apptId = res.json().appointment.id as string;

    // La confirmación (y después cada recordatorio) no puede salir: un solo aviso para el entrenador.
    const [confirm] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `appt:${apptId}:confirm`));
    await runJobNow(confirm.id);
    const [r24] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `appt:${apptId}:r24`));
    await runJobNow(r24.id);
    const open = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.businessId, T.businessId), eq(alerts.appointmentId, apptId), eq(alerts.status, 'open')));
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('Mensaje no enviado');
    expect(open[0].body).toMatch(/Nuria/);
    expect(open[0].body).toMatch(/no tiene ninguna conversación con KAI/);
    expect(open[0].body).toMatch(/Avísale tú/);
  });
});

describe('Bandeja: los leads dados de baja no son «Calientes» ni «No respondieron»', () => {
  it('filtros hot y no_reply', async () => {
    const a = await newLead('Óscar Caliente', true);
    const b = await newLead('Pablo Caliente De Baja', true);
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const [l, optedOut] of [
      [a, false],
      [b, true],
    ] as const)
      await getDb().update(leads).set({ temperature: 'caliente', optedOut, status: 'interested', lastOutboundAt: old, lastInboundAt: null }).where(eq(leads.id, l.leadId));
    for (const filter of ['hot', 'no_reply']) {
      const res = await T.client.get('/api/inbox', { query: { filter } });
      expect(res.statusCode).toBe(200);
      const ids = (res.json().items as { lead: { id: string } }[]).map((i) => i.lead.id);
      expect(ids, filter).toContain(a.leadId);
      expect(ids, filter).not.toContain(b.leadId);
    }
  });
});

describe('Seguimientos para el lead que no encaja', () => {
  it('no se programan, y los pendientes se cancelan al saberse', async () => {
    const a = await newLead('Quique Menor', true);
    await getDb().update(leads).set({ status: 'conversing' }).where(eq(leads.id, a.leadId));
    const fu = await scheduleNoReplyFollowUp(T.businessId, a.leadId, a.conversationId!);
    expect(fu?.status).toBe('scheduled');
    await mergeQualification(T.businessId, a.leadId, {}, { fit: 'no' });
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu!.id));
    expect(after.status).toBe('cancelled');
    expect(await scheduleNoReplyFollowUp(T.businessId, a.leadId, a.conversationId!)).toBeNull();
  });
});

class Sim {
  constructor(
    readonly id: string,
    readonly leadId: string,
  ) {}
  static async start(leadName: string) {
    const res = await T.client.post('/api/simulator/conversations', { leadName });
    expect(res.statusCode).toBe(200);
    return new Sim(res.json().conversationId, res.json().leadId);
  }
  async say(text: string) {
    const res = await T.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result as { status: string; text?: string; directive?: string };
  }
  async state() {
    const [c] = await getDb().select().from(conversations).where(eq(conversations.id, this.id));
    return c.state as SetterState;
  }
  async offeredDays() {
    const st = await this.state();
    return (st.lastOfferIds ?? []).map((id) => DateTime.fromISO(st.offeredSlots!.find((s) => s.id === id)!.start).setZone(TZ));
  }
  async qualify() {
    let r = await this.say('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) r = await this.say(ANSWERS[(await this.state()).lastAskedKey ?? 'goal'] ?? 'Vale');
    expect(r.directive).toBe('propose_call');
  }
}

/** Cómo diría el lead ese día (“hoy”, “mañana” o “el jueves”). */
function dayWord(d: DateTime): string {
  const diff = Math.round(d.startOf('day').diff(DateTime.now().setZone(TZ).startOf('day'), 'days').days);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  return `el ${d.setLocale('es').toFormat('cccc')}`;
}

describe('Simulador: seguimiento forzado', () => {
  it('se envía aunque sea horario de descanso (un lead real lo recibiría al terminar)', async () => {
    // Horario de descanso que empieza hace una hora y termina dentro de otra: ahora mismo es «de noche».
    const now = DateTime.now().setZone(TZ);
    const quietHours = { start: now.minus({ hours: 1 }).toFormat('HH:mm'), end: now.plus({ hours: 1 }).toFormat('HH:mm') };
    const [auto] = await getDb()
      .select()
      .from(automations)
      .where(and(eq(automations.businessId, T.businessId), eq(automations.type, 'followup_no_reply')));
    await getDb().update(automations).set({ config: { ...auto.config, quietHours } }).where(eq(automations.id, auto.id));
    const c = await Sim.start('Tino Noche');
    await c.say('Hola, quiero perder unos 6 kilos');
    const before = await getDb().select().from(messages).where(and(eq(messages.conversationId, c.id), eq(messages.direction, 'outbound')));
    const res = await T.client.post(`/api/simulator/conversations/${c.id}/follow-up`, {});
    expect(res.statusCode, res.body).toBe(200);
    const after = await getDb().select().from(messages).where(and(eq(messages.conversationId, c.id), eq(messages.direction, 'outbound')));
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)!.metadata.purpose).toBe('follow_up');
    await getDb().update(automations).set({ config: auto.config }).where(eq(automations.id, auto.id));
  });
});

describe('Simulador sin IA', () => {
  it('«<día> no puedo»: se ofrecen otros días, sin «Perfecto»', async () => {
    const c = await Sim.start('Raúl Rechaza');
    await c.qualify();
    expect((await c.say('Sí')).directive).toBe('offer_slots');
    const [first] = await c.offeredDays();
    const r = await c.say(`${dayWord(first)} no puedo`);
    expect(r.directive).toBe('offer_slots');
    expect(r.text).not.toMatch(/^(Perfecto|Genial)/);
    for (const d of await c.offeredDays()) expect(d.toISODate()).not.toBe(first.toISODate());
  });

  it('con la llamada agendada, «¿me podéis llamar a las 10?» ofrece huecos a las 10 y desistir olvida la oferta', async () => {
    const c = await Sim.start('Sara Diez');
    await c.qualify();
    await c.say('Sí');
    expect((await c.say('La primera')).directive).toBe('book_slot');
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.leadId, c.leadId));
    const r = await c.say('¿Me podéis llamar mejor a las 10?');
    expect(r.directive).toBe('reschedule');
    expect((await c.offeredDays()).map((d) => d.toFormat('HH:mm'))).toEqual(['10:00', '10:00']);
    const keep = await c.say('Bueno, mejor la dejamos como estaba');
    expect(keep.directive).toBe('post_booking');
    expect((await c.state()).lastOfferIds ?? []).toHaveLength(0);
    expect((await c.say('Vale')).directive).toBe('post_booking');
    const [after] = await getDb().select().from(appointments).where(eq(appointments.leadId, c.leadId));
    expect(after.startsAt.toISOString()).toBe(appt.startsAt.toISOString());
  });
});
