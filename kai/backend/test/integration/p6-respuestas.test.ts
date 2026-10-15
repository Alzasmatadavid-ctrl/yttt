/**
 * p6-respuestas, de extremo a extremo con el simulador (motor de reglas, sin IA):
 *  - «Hola, ¿con quién hablo?» como primer mensaje: KAI se presenta una vez, sin «eso te lo concreta Álex»;
 *  - la misma objeción por tercera vez: tras «no quiero insistir», el estado lo recuerda, no se programa seguimiento
 *    y el siguiente «Vale» no vuelve a vender la llamada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, followUps } from '../../src/database/schema.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const ANSWERS: Record<string, string> = {
  goal: 'Quiero perder unos 12 kilos, sobre todo la barriga',
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
  status: string;
  text?: string;
  directive?: string;
}

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
  const say = async (text: string): Promise<SetterResult> => {
    const r = await T.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result as SetterResult;
  };
  const state = async () => ((await getDb().select().from(conversations).where(eq(conversations.id, conversationId)))[0].state ?? {}) as SetterState;
  const scheduledFollowUps = () =>
    getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, leadId), eq(followUps.status, 'scheduled')));
  return { say, state, scheduledFollowUps };
}

describe('p6-respuestas · simulador', () => {
  it('«Hola, ¿con quién hablo?»: se presenta una sola vez y no responde «eso te lo concreta Álex»', async () => {
    const sim = await start('Pedro Gil');
    const r = await sim.say('Hola, ¿con quién hablo?');
    expect(r.status).toBe('sent');
    expect(r.text).toMatch(/asistente virtual/);
    expect(r.text!.match(/asistente virtual/g)).toHaveLength(1);
    expect(r.text).not.toMatch(/prefiero no decirte nada inexacto|te lo puede concretar/);
  });

  it('la misma objeción por tercera vez: se recuerda en el estado, sin seguimiento y sin volver a vender la llamada', async () => {
    const sim = await start('Gabriel Ruiz');
    let r = await sim.say('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await sim.state()).lastAskedKey ?? 'goal';
      r = await sim.say(ANSWERS[key] ?? 'Vale, te cuento lo que necesites');
    }
    expect(r.directive).toBe('propose_call');
    const objections = [await sim.say('Es muy caro para mí'), await sim.say('Ya, pero es caro'), await sim.say('Sigue siendo caro')];
    expect(objections.map((o) => o.directive)).toEqual(['handle_objection', 'handle_objection', 'handle_objection']);
    const closing = objections[2];
    expect(closing.text).toMatch(/insistir|respeto/);
    expect(closing.text).not.toContain('?');
    expect((await sim.state()).callDeclinedAt).toBeTruthy();
    expect(await sim.scheduledFollowUps()).toHaveLength(0);
    const after = await sim.say('Vale');
    expect(['reassure_call', 'propose_call', 'offer_slots']).not.toContain(after.directive);
    expect(after.text).not.toMatch(/llamada de valoración/);
  });
});
