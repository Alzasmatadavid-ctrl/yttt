import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations } from '../../src/database/schema.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

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
  await T.client.put('/api/settings/primary-service', { name: 'Programa', priceCents: 14900, billingPeriod: 'monthly', description: 'x', includes: ['Plan'] });
});
afterAll(async () => { await teardownTestApp(app); });
class Sim {
  log: string[] = [];
  constructor(readonly id: string, readonly leadId: string) {}
  static async start(leadName: string) {
    const res = await T.client.post('/api/simulator/conversations', { leadName });
    return new Sim(res.json().conversationId, res.json().leadId);
  }
  async say(text: string) {
    const res = await T.client.post(`/api/simulator/conversations/${this.id}/messages`, { text });
    const r = res.json().result;
    this.log.push(`> ${text}\n  [${r.directive ?? r.status}] ${r.text}`);
    return r;
  }
  async state() { const [c] = await getDb().select().from(conversations).where(eq(conversations.id, this.id)); return c.state as SetterState; }
  async appts() { return getDb().select().from(appointments).where(eq(appointments.leadId, this.leadId)); }
  async qualify() {
    let r = await this.say('Hola, vi tu anuncio en Instagram');
    for (let i = 0; i < 12 && r.directive !== 'propose_call'; i++) {
      const key = (await this.state()).lastAskedKey ?? 'goal';
      r = await this.say(ANSWERS[key] ?? 'Vale, te cuento lo que necesites');
    }
  }
  async book() { await this.qualify(); await this.say('Sí'); await this.say('La primera'); }
  print(title: string) { appendFileSync("/tmp/claude-0/-home-user-yttt/e7335306-cd41-5849-8557-941f93f7facb/scratchpad/p5sa/log.txt", `\n=== ${title}\n${this.log.join("\n")}\n`); }
}
describe('scratch', () => {
  it('f1a', async () => { const c = await Sim.start('A Uno'); await c.qualify(); c.log = []; await c.say('No'); await c.say('No, gracias'); await c.say('Sí, claro'); c.print('f1a'); });
  it('f1b', async () => { const c = await Sim.start('B Uno'); await c.qualify(); c.log = []; await c.say('Ahora mismo no tengo dinero para esto'); await c.say('Vale, gracias'); c.print('f1b'); });
  it('f1c', async () => { const c = await Sim.start('C Uno'); await c.qualify(); c.log = []; await c.say('Ahora mismo no tengo tiempo para llamadas, ando muy liado'); await c.say('vale'); c.print('f1c'); });
  it('f2', async () => { for (const t of ['¿La podemos mover?', 'Una cosa, al final ¿me podéis llamar a las 9 de la mañana?', '¿Me puedes llamar el martes?']) { const c = await Sim.start('D Dos'); await c.book(); c.log = []; await c.say(t); c.print('f2 ' + t); } });
  it('f3', async () => { const c = await Sim.start('E Tres'); await c.qualify(); c.log = []; await c.say('Sí'); const st = await c.state(); c.log.push("offer " + JSON.stringify(st.offeredSlots?.map(s=>s.label))); await c.say('El lunes no puedo, trabajo todo el día'); await c.say('¿No tienes otro día?'); await c.say('Ninguna me va bien'); await c.say('Que ninguna de las dos'); c.print('f3'); });
  it('f4', async () => { const c = await Sim.start('F Cuatro'); await c.book(); c.log = []; await c.say('¿Podemos cambiar la llamada a otro día?'); await c.say('Bueno, mejor la dejamos como estaba, gracias'); await c.say('No, no, déjala como está'); await c.say('Gracias'); c.print('f4'); });
  it('f5', async () => { const c = await Sim.start('G Cinco'); await c.book(); c.log = []; const a = (await c.appts())[0]; c.log.push("appt " + a.startsAt.toISOString()); await c.say('Vale, el lunes'); c.print('f5'); });
});
