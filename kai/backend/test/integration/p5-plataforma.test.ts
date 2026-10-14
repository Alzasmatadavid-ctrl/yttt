/**
 * Revisión nº5 — grupo «plataforma» (con base de datos PGlite y la app real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { leads } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';
import { registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

/** Lead cualificado y caliente con conversación web, que no contesta desde hace 3 días (candidato a «a punto de perderse»). */
async function quietHotLead(T: Trainer, name: string) {
  const { lead } = await createLead(T.businessId, { name, source: 'manual' }, { type: 'user', userId: T.userId });
  await getOrCreateConversation(T.businessId, lead.id, 'web');
  const old = new Date(Date.now() - 5 * 86_400_000);
  await getDb()
    .update(leads)
    .set({
      score: 74,
      status: 'qualified',
      temperature: 'caliente',
      createdAt: old,
      lastInboundAt: new Date(Date.now() - 4 * 86_400_000),
      lastOutboundAt: new Date(Date.now() - 3 * 86_400_000),
    })
    .where(eq(leads.id, lead.id));
  return lead.id;
}

describe('«Hoy» y Copilot no proponen a un lead que pidió la baja', () => {
  it('no sale como «a punto de perderse» ni cuenta como caliente o sin respuesta; el que no la pidió, sí', async () => {
    const T = await registerTrainer(app);
    const optedOut = await quietHotLead(T, 'Olga Baja');
    const active = await quietHotLead(T, 'Pablo Activo');
    expect((await T.client.post(`/api/leads/${optedOut}/opt-out`, { optedOut: true })).statusCode).toBe(200);

    const d = await getDashboard(T.businessId);
    expect(d.attention.atRisk.map((l) => l.id)).toEqual([active]);
    expect(d.leads.hot).toBe(1);
    expect(d.activity.leadsWithoutReply).toBe(1);

    const res = await T.client.post('/api/copilot/ask', { question: '¿A quién debería responder ahora?' });
    expect(res.statusCode, res.body).toBe(200);
    const text = res.json().text as string;
    expect(text).toContain('A punto de perderse: Pablo Activo.');
    expect(text).not.toContain('Olga Baja');

    // Si vuelve a permitir mensajes, vuelve a contar.
    expect((await T.client.post(`/api/leads/${optedOut}/opt-in`, {})).statusCode).toBe(200);
    const after = await getDashboard(T.businessId);
    expect(after.attention.atRisk.map((l) => l.id).sort()).toEqual([optedOut, active].sort());
    expect(after.leads.hot).toBe(2);
    expect(after.activity.leadsWithoutReply).toBe(2);
  });
});
