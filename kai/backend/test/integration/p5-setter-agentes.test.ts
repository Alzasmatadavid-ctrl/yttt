/**
 * Revisión nº5 (setter, motor de reglas) de extremo a extremo con el simulador en modo sin IA: los textos fijos que se
 * repetían (volver a pedir la llamada tras cancelarla, preguntar el precio una y otra vez, encadenar objeciones) ya no
 * hacen que el control de calidad escale la conversación sin responder al lead, y al reservar no se promete un
 * recordatorio.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations } from '../../src/database/schema.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

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

  /** Lo dice y comprueba que KAI le responde (no escala por el control de calidad). */
  async answered(text: string): Promise<SetterResult> {
    const r = await this.say(text);
    expect(r.reason, `«${text}» → ${r.status} (${r.directive ?? ''})`).not.toBe('quality_check_failed');
    expect(r.status, `«${text}» → ${r.status}/${r.reason ?? ''} (${r.directive ?? ''})`).toBe('sent');
    return r;
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
    let r = await this.answered('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await this.state()).lastAskedKey ?? 'goal';
      r = await this.answered(ANSWERS[key] ?? 'Vale, te cuento lo que necesites');
    }
    expect(r.directive).toBe('propose_call');
  }
}

describe('Motor de reglas: ningún texto fijo repetido deja al lead sin respuesta', () => {
  it('reservar, cancelar y volver a pedir la llamada: le ofrece horarios (y al reservar no promete recordatorios)', async () => {
    const c = await Sim.start('Hugo Martín');
    await c.qualify();
    expect((await c.answered('Sí')).directive).toBe('offer_slots');
    const booked = await c.answered('La primera');
    expect(booked.directive).toBe('book_slot');
    expect(booked.text).not.toMatch(/recordatorio/i);
    let r = await c.answered('Al final quiero cancelar la llamada, lo siento');
    if (r.directive === 'confirm_cancel') r = await c.answered('Cancélala');
    expect((await c.appointments()).map((a) => a.status)).toEqual(['cancelled']);
    await c.answered('Gracias');
    const again = await c.answered('Oye, al final sí quiero la llamada');
    expect(again.text).toBeTruthy();
  });

  it('preguntar el precio cinco veces seguidas', async () => {
    const c = await Sim.start('Sergio Blanco');
    for (const t of ['¿cuánto cuesta?', '¿Cuánto cuesta?', '¿Pero cuánto es?', '¿Cuánto vale entonces?', '¿Y el precio?']) await c.answered(t);
    // Y la conversación sigue: el siguiente mensaje también se contesta.
    await c.answered('Vale, lo pienso');
  });

  it('encadenar objeciones', async () => {
    const c = await Sim.start('Rubén Ortega');
    for (const t of ['Es muy caro para mí', 'Es muy caro para mí', 'Es muy caro para mí', 'Es muy caro para mí', 'Ahora mismo no tengo tiempo', 'No tengo tiempo']) await c.answered(t);
  });
});
