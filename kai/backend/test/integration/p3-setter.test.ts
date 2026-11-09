/**
 * Revisión nº3 (setter), de extremo a extremo con el simulador en modo sin IA (análisis heurístico + motor de reglas):
 * «¿la cancelo o la movemos?», rechazos de la llamada, mover la cita con frases naturales, mensajes compuestos que
 * superaban el máximo, precio repetido de un lead que no encaja y «¿cuánto costaría?».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations } from '../../src/database/schema.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';
const SERVICE = {
  name: 'Programa Recomposición',
  priceCents: 14900,
  billingPeriod: 'monthly',
  description: 'Entrenamiento y nutrición online con seguimiento.',
  includes: ['Plan de entrenamiento personalizado', 'Pautas de nutrición flexibles', 'Seguimiento semanal por WhatsApp'],
};

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
  const svc = await T.client.put('/api/settings/primary-service', SERVICE);
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

  /** Cualifica, acepta la llamada y reserva el primer horario. */
  async book() {
    await this.qualify();
    expect((await this.say('Sí')).directive).toBe('offer_slots');
    expect((await this.say('La primera')).directive).toBe('book_slot');
    expect((await this.appointments()).filter((a) => a.status === 'scheduled')).toHaveLength(1);
  }
}

describe('«¿Quieres que cancele la llamada o prefieres que la movamos?»', () => {
  it.each(['Cancélala', 'Sí, cancélala por favor', 'Cancelar', 'Sí'])('«%s» → la cancela de verdad', async (answer) => {
    const c = await Sim.start('Carlos Martín');
    await c.book();
    expect((await c.say('No quiero la llamada')).directive).toBe('confirm_cancel');
    const r = await c.say(answer);
    expect(r.directive).toBe('cancel_booking');
    expect(r.text).toMatch(/he cancelado/);
    expect((await c.appointments()).map((a) => a.status)).toEqual(['cancelled']);
    expect((await c.state()).callDeclinedAt).toBeTruthy();
  });

  it('«Muévela al jueves» → ofrece horarios del jueves y, al elegir, mueve la cita', async () => {
    const c = await Sim.start('Gonzalo Rey');
    await c.book();
    await c.say('No quiero la llamada');
    const r = await c.say('Muévela al jueves');
    expect(r.directive).toBe('reschedule');
    expect(r.text).toMatch(/^Sin problema, lo movemos\./);
    expect(r.text).not.toMatch(/sigue en pie/);
    const offered = (await c.state()).lastOfferIds ?? [];
    expect(offered.length).toBeGreaterThan(0);
    expect((await c.say('La primera')).directive).toBe('book_slot');
    const scheduled = (await c.appointments()).filter((a) => a.status === 'scheduled');
    expect(scheduled).toHaveLength(1);
    expect(DateTime.fromJSDate(scheduled[0].startsAt).setZone(TZ).weekday).toBe(4);
  });

  it.each(['Mejor muévela', 'A otro día'])('«%s» → busca otro horario', async (answer) => {
    const c = await Sim.start('Rubén Díaz');
    await c.book();
    await c.say('No quiero la llamada');
    const r = await c.say(answer);
    expect(r.directive).toBe('reschedule');
    expect((await c.appointments()).filter((a) => a.status === 'scheduled')).toHaveLength(1);
  });

  it('«No, déjala como está» → sigue en pie y no queda como llamada rechazada', async () => {
    const c = await Sim.start('Iván Torres');
    await c.book();
    await c.say('No quiero la llamada');
    const r = await c.say('No, déjala como está');
    expect(r.directive).toBe('post_booking');
    expect((await c.appointments()).map((a) => a.status)).toEqual(['scheduled']);
    expect((await c.state()).callDeclinedAt).toBeUndefined();
    // Si más adelante vuelve a decir que no la quiere, se le pregunta otra vez (sin repetir el mismo mensaje).
    const again = await c.say('Bueno, al final no quiero la llamada');
    expect(again.status).toBe('sent');
    expect(again.directive).toBe('confirm_cancel');
  });
});

describe('Rechazar la llamada con frases habituales', () => {
  it.each(['No quiero hacer la llamada', 'No me apetece hacer ninguna llamada', 'Prefiero no hacer llamadas, gracias', 'Paso de llamadas, prefiero por aquí', 'No me gustan nada las llamadas'])(
    '«%s» → no le ofrece horarios (ni ahora ni con un «Ok» después)',
    async (text) => {
      const c = await Sim.start('Raúl Serrano');
      await c.qualify();
      const r = await c.say(text);
      expect(r.directive).toBe('continue_without_call');
      expect((await c.state()).callDeclinedAt).toBeTruthy();
      const ok = await c.say('Ok');
      expect(['offer_slots', 'clarify_slot', 'reassure_call', 'propose_call']).not.toContain(ok.directive);
      expect((await c.state()).lastOfferIds ?? []).toHaveLength(0);
    },
  );
});

describe('Con la llamada agendada, pedir otro día u hora la mueve', () => {
  it.each(['¿Puede ser una hora más tarde?', 'Mejor el miércoles', 'El jueves a las 18:00 me iría mejor'])('«%s» → reprogramar', async (text) => {
    const c = await Sim.start('Mario Castro');
    await c.book();
    const r = await c.say(text);
    expect(r.directive).toBe('reschedule');
    expect(r.text).not.toMatch(/sigue en pie/);
    expect(((await c.state()).lastOfferIds ?? []).length).toBeGreaterThan(0);
  });
});

describe('Mensajes compuestos del motor de reglas: no se escala por largo', () => {
  it('primer mensaje «Hola, ¿eres un bot? ¿Cuánto cuesta?»', async () => {
    const c = await Sim.start('Luis Gil');
    const r = await c.say('Hola, ¿eres un bot? ¿Cuánto cuesta?');
    expect(r.status).toBe('sent');
    expect(r.text).toMatch(/asistente automatizado/);
    expect(r.text!.length).toBeLessThanOrEqual(320);
  });

  it('primer mensaje largo con el precio', async () => {
    const c = await Sim.start('Daniel Herrera');
    const r = await c.say('Hola! Me llamo Daniel, tengo 38 años. Quiero perder 15 kilos antes del verano. Trabajo en oficina y no tengo tiempo. ¿Cuánto cuesta?');
    expect(r.status).toBe('sent');
    expect(r.text!.length).toBeLessThanOrEqual(320);
  });

  it('«Espera, ¿eres un bot?» tras proponer la llamada', async () => {
    const c = await Sim.start('Toni Vidal');
    await c.qualify();
    const r = await c.say('Espera, ¿eres un bot?');
    expect(r.status).toBe('sent');
    expect(r.text).toMatch(/asistente automatizado/);
  });
});

describe('Precio repetido de un lead que no encaja', () => {
  it('un menor que insiste en el precio recibe respuesta cada vez (sin escalar)', async () => {
    const c = await Sim.start('Hugo');
    await c.say('Hola, tengo 16 años y quiero perder grasa');
    await c.say('¿Cuánto cuesta?');
    const texts: string[] = [];
    for (const q of ['Pero dime el precio', '¿Cuánto vale al mes?', '¿Y cuánto costaba?']) {
      const r = await c.say(q);
      expect(r.status, `${q} → ${r.reason}`).toBe('sent');
      expect(r.directive).toBe('share_price');
      expect(r.text).toMatch(/149\s?€/);
      texts.push(r.text!);
    }
    expect(new Set(texts).size).toBe(3);
    const r = await c.say('¿Y si me lo pagan mis padres?');
    expect(r.status).toBe('sent');
  });
});

describe('Otras formas de preguntar el precio', () => {
  it('«Antes, ¿cuánto costaría el programa?» tras proponer la llamada → da el precio', async () => {
    const c = await Sim.start('Pablo Ruiz');
    await c.qualify();
    const r = await c.say('Antes, ¿cuánto costaría el programa?');
    expect(r.directive).toBe('share_price');
    expect(r.text).toMatch(/149\s?€/);
  });

  it('tras cancelar la llamada, «¿y cuánto costaba?» → da el precio', async () => {
    const c = await Sim.start('Fran Gil');
    await c.book();
    expect((await c.say('Al final cancela la llamada, lo siento')).directive).toBe('cancel_booking');
    await c.say('Gracias');
    const r = await c.say('Oye, ¿y cuánto costaba?');
    expect(r.directive).toBe('share_price');
    expect(r.text).toMatch(/149\s?€/);
  });
});
