import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, leads, messages } from '../../src/database/schema.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await setupTestApp(); });
afterAll(async () => { await teardownTestApp(app); });

describe('repro', () => {
  it('modo sin IA', async () => {
    const t = await registerTrainer(app);
    await openAgenda(t.client);
    const res = await t.client.post('/api/simulator/conversations', { leadName: 'Marta' });
    const { conversationId, leadId } = res.json();
    for (const text of ['Hola! Vi tu reel, quiero perder unos 8 kilos', 'Trabajo muchas horas y como fatal entre semana', 'Me caso en junio y quiero verme bien']) {
      const r = await t.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text });
      console.log('>>', text, '\n<<', JSON.stringify(r.json().result.text), r.json().result.directive);
      const [l] = await getDb().select().from(leads).where(eq(leads.id, leadId));
      const [c] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
      console.log(JSON.stringify(Object.fromEntries(Object.entries(l.qualification).map(([k, v]: any) => [k, v.value]))), JSON.stringify(l.signals), c.state.lastAskedKey);
    }
  });
});
