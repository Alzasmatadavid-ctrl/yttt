/**
 * Ronda 5 (setter: análisis y estrategia) de extremo a extremo con el simulador en modo sin IA:
 * un “sí” a otra pregunta no abre la agenda tras un “no”, mover la llamada con naturalidad, rechazar los horarios
 * ofrecidos, desistir de moverla, confirmar la cita o el recordatorio y clientes que escriben desde otro número.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations, leads } from '../../src/database/schema.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
/** Respuestas del lead según la variable que KAI le acaba de preguntar. */
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
const SLOT_DIRECTIVES = ['offer_slots', 'clarify_slot', 'reschedule', 'book_slot'];

interface SetterResult {
  status: 'sent' | 'skipped' | 'handoff' | 'blocked' | 'failed';
  reason?: string;
  text?: string;
  directive?: string;
}

let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Álex Romero', businessName: 'Álex Fit' });
  await openAgenda(T.client);
  const svc = await T.client.put('/api/settings/primary-service', {
    name: 'Programa Recomposición',
    priceCents: 14900,
    billingPeriod: 'monthly',
    description: 'Entrenamiento y nutrición online con seguimiento.',
    includes: ['Plan de entrenamiento personalizado'],
  });
  expect(svc.statusCode).toBe(200);
});

afterAll(async () => {
  await teardownTestApp(app);
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

  async say(text: string): Promise<SetterResult> {
    const res = await T.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result as SetterResult;
  }

  async state(): Promise<SetterState> {
    const [c] = await getDb().select().from(conversations).where(eq(conversations.id, this.id));
    return c.state as SetterState;
  }

  async appointments() {
    return getDb().select().from(appointments).where(eq(appointments.leadId, this.leadId));
  }

  /** Responde a lo que KAI pregunte hasta que proponga la llamada. */
  async qualify() {
    let r = await this.say('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await this.state()).lastAskedKey ?? 'goal';
      r = await this.say(ANSWERS[key] ?? 'Vale, te cuento lo que necesites');
    }
    expect(r.directive).toBe('propose_call');
  }

  /** Cualifica, acepta la llamada y elige el primer horario. */
  async book() {
    await this.qualify();
    expect((await this.say('Sí')).directive).toBe('offer_slots');
    expect((await this.say('La primera')).directive).toBe('book_slot');
    const [appt] = await this.appointments();
    expect(appt.status).toBe('scheduled');
    return appt;
  }
}

/** Cómo diría el lead el día de su llamada (“hoy”, “mañana” o “el jueves”). */
function dayWord(d: Date): string {
  const day = DateTime.fromJSDate(d).setZone(TZ).startOf('day');
  const today = DateTime.now().setZone(TZ).startOf('day');
  const diff = Math.round(day.diff(today, 'days').days);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  return `el ${day.setLocale('es').toFormat('cccc').normalize('NFD').replace(/[̀-ͯ]/g, '')}`;
}

describe('Tras un “no” a la llamada, un “sí” a otra pregunta no abre la agenda', () => {
  it('«No» → «No, gracias» → «Sí, claro»: nunca ofrece horarios', async () => {
    const c = await Sim.start('Andrés Uno');
    await c.qualify();
    const no = await c.say('No');
    expect(no.directive).toBe('continue_without_call');
    expect((await c.state()).callDeclinedAt).toBeTruthy();
    for (const t of ['No, gracias', 'Sí, claro']) expect(SLOT_DIRECTIVES, t).not.toContain((await c.say(t)).directive);
    expect((await c.state()).lastOfferIds ?? []).toHaveLength(0);
  });

  it('«no tengo dinero» → «Vale, gracias» y «no tengo tiempo para llamadas» → «vale»: sin horarios', async () => {
    const a = await Sim.start('Bruno Dos');
    await a.qualify();
    await a.say('Ahora mismo no tengo dinero para esto');
    expect(SLOT_DIRECTIVES).not.toContain((await a.say('Vale, gracias')).directive);
    const b = await Sim.start('Carlos Tres');
    await b.qualify();
    await b.say('Ahora mismo no tengo tiempo para llamadas, ando muy liado');
    expect(SLOT_DIRECTIVES).not.toContain((await b.say('vale')).directive);
  });
});

describe('Rechazar los horarios ofrecidos', () => {
  it('«Ninguna me va bien» y «¿No tienes otro día?» buscan otros horarios en vez de repetir la pregunta', async () => {
    const c = await Sim.start('Diego Cuatro');
    await c.qualify();
    expect((await c.say('Sí')).directive).toBe('offer_slots');
    for (const t of ['Ninguna me va bien', '¿No tienes otro día?']) {
      const r = await c.say(t);
      expect(r.status, t).toBe('sent');
      expect(r.directive, t).toBe('offer_slots');
    }
  });
});

describe('Con la llamada agendada', () => {
  it.each(['¿La podemos mover?', 'Una cosa, al final ¿me podéis llamar a las 9 de la mañana?', '¿Me puedes llamar el martes?'])(
    '«%s» ofrece moverla',
    async (text) => {
      const c = await Sim.start('Eduardo Cinco');
      await c.book();
      const r = await c.say(text);
      expect(r.directive).toBe('reschedule');
    },
  );

  it('pedir moverla y después desistir: la cita sigue igual y no se repite la oferta', async () => {
    const c = await Sim.start('Fernando Seis');
    const appt = await c.book();
    expect((await c.say('¿Podemos cambiar la llamada a otro día?')).directive).toBe('reschedule');
    for (const t of ['Bueno, mejor la dejamos como estaba, gracias', 'No, no, déjala como está', 'Gracias']) {
      const r = await c.say(t);
      expect(r.directive, t).toBe('post_booking');
    }
    const [after] = await c.appointments();
    expect(after.startsAt.toISOString()).toBe(appt.startsAt.toISOString());
    expect(after.status).toBe('scheduled');
  });

  it('confirmar el día de la cita («Vale, hoy/mañana/el jueves») no ofrece moverla', async () => {
    const c = await Sim.start('Gonzalo Siete');
    const appt = await c.book();
    const r = await c.say(`Vale, ${dayWord(appt.startsAt)}`);
    expect(r.directive).toBe('post_booking');
    expect((await c.appointments())[0].startsAt.toISOString()).toBe(appt.startsAt.toISOString());
  });

  it('responder al recordatorio «No se me olvida 😉» o «No faltaré, gracias» no ofrece moverla; «No, tengo médico» sí', async () => {
    const c = await Sim.start('Héctor Ocho');
    await c.book();
    const remind = (kind: string) =>
      sendMessage({ businessId: T.businessId, conversationId: c.id, text: 'Te recuerdo que tienes la llamada de valoración. ¿Todo bien?', sender: { type: 'kai' }, purpose: 'reminder', metadata: { kind } });
    await remind('reminder_24h');
    expect((await c.say('No se me olvida 😉')).directive).toBe('post_booking');
    await remind('reminder_1h');
    expect((await c.say('No faltaré, gracias')).directive).toBe('post_booking');
    await remind('reminder_1h');
    expect((await c.say('No, tengo médico')).directive).toBe('reschedule');
  });
});

describe('Cliente que escribe desde otro número', () => {
  it('se pasa al entrenador sin cualificar ni guardar su mensaje como objetivo', async () => {
    const c = await Sim.start('Pablo Nueve');
    const r = await c.say('Hola Álex, soy Pablo, ya entreno contigo. ¿Me pasas la rutina de esta semana?');
    expect(r.status).toBe('handoff');
    expect(r.reason).toBe('out_of_scope');
    expect(r.text).toMatch(/Álex/);
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, c.leadId));
    expect(lead.qualification.goal).toBeUndefined();
    expect(lead.signals.fit).toBeUndefined();
  });
});
