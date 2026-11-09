/**
 * Revisión nº3 — integración final (con base de datos PGlite y la app real):
 * - La conversación abierta en la Bandeja dice si el último mensaje del lead está sin contestar (para ofrecer
 *   «Que KAI responda ahora» también fuera de un escalado).
 * - «Hoy» no repite como «a punto de perderse» a quien ya espera respuesta de una persona (escalado o mensaje
 *   sin contestar), así Copilot y la pantalla cuentan lo mismo.
 * - Copilot «¿A quién debería responder ahora?» distingue a dos leads con el mismo nombre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, leads, messages } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { triggerHandoff } from '../../src/crm/handoff.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';
import { receiveInboundForConversation, receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { json, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

/** Lead real con su conversación de chat web (sin canal externo). */
async function webLead(T: Trainer, name: string) {
  const { lead } = await createLead(T.businessId, { name, source: 'manual' }, { type: 'user', userId: T.userId });
  const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
  return { leadId: lead.id, conversationId: conv.id };
}

/** Deja al lead «interesado» y con su último mensaje de hace 3 días (candidato a «a punto de perderse»). */
async function makeItOld(l: { leadId: string; conversationId: string }, messageId?: string) {
  const old = new Date(Date.now() - 3 * 86_400_000);
  if (messageId) await getDb().update(messages).set({ createdAt: old }).where(eq(messages.id, messageId));
  await getDb().update(conversations).set({ lastInboundAt: messageId ? old : null, lastMessageAt: old }).where(eq(conversations.id, l.conversationId));
  await getDb().update(leads).set({ score: 70, status: 'interested', createdAt: old, lastInboundAt: messageId ? old : null }).where(eq(leads.id, l.leadId));
}

const detail = async (T: Trainer, conversationId: string) => json<{ needsHumanReply: boolean }>(await T.client.get(`/api/conversations/${conversationId}`));

describe('La conversación abierta dice si el mensaje del lead sigue sin contestar', () => {
  it('KAI en pausa → sí; con «Que KAI responda ahora» → no; con KAI activo y un mensaje recién llegado → no', async () => {
    const T = await registerTrainer(app);
    const l = await webLead(T, 'Óliver Pausa');
    expect((await T.client.post(`/api/conversations/${l.conversationId}/take-over`)).statusCode).toBe(200);
    await receiveInboundForConversation(T.businessId, l.conversationId, '¿Y cuánto dura el programa?');
    expect((await detail(T, l.conversationId)).needsHumanReply).toBe(true);

    // «Devolver a KAI» sin pedirle que responda: KAI contestará a lo nuevo, pero este mensaje sigue esperando.
    expect((await T.client.post(`/api/conversations/${l.conversationId}/release`, { replyNow: false })).statusCode).toBe(200);
    expect((await detail(T, l.conversationId)).needsHumanReply).toBe(true);

    expect((await T.client.post(`/api/conversations/${l.conversationId}/release`, { replyNow: true })).statusCode).toBe(200);
    expect((await detail(T, l.conversationId)).needsHumanReply).toBe(false);

    // Mensaje real (programa la respuesta de KAI): KAI se encarga, no hace falta ofrecer nada.
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Hola, vi tu anuncio', profile: { whatsappId: '34600700901', phone: '+34600700901', name: 'Pilar Activa' } });
    if (r.duplicate) throw new Error('inesperado');
    expect((await detail(T, r.conversation.id)).needsHumanReply).toBe(false);
  });
});

describe('«Hoy»: quien ya espera a una persona no sale además como «a punto de perderse»', () => {
  it('escalado → solo como aviso; sin escalado ni mensaje pendiente → sí está a punto de perderse', async () => {
    const T = await registerTrainer(app);
    const escalated = await webLead(T, 'Elena Escalada');
    await makeItOld(escalated);
    await triggerHandoff(T.businessId, escalated.conversationId, 'human_request', 'Quiere hablar con el entrenador');
    const quiet = await webLead(T, 'Quique Callado');
    await makeItOld(quiet);

    const d = await getDashboard(T.businessId);
    expect(d.attention.atRisk.map((l) => l.id)).toEqual([quiet.leadId]);
    expect(d.attention.alerts.some((a) => a.alert.type === 'handoff' && a.alert.leadId === escalated.leadId)).toBe(true);
  });

  it('piloto apagado y mensaje sin contestar de hace 3 días → solo en «Esperan tu respuesta»', async () => {
    const T = await registerTrainer(app);
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const l = await webLead(T, 'Irene Interesada');
    const { message } = await receiveInboundForConversation(T.businessId, l.conversationId, 'Me interesa, ¿cuánto cuesta?');
    await makeItOld(l, message.id);

    const d = await getDashboard(T.businessId);
    expect(d.attention.waiting.map((w) => w.leadId)).toEqual([l.leadId]);
    expect(d.attention.atRisk).toHaveLength(0);
  });
});

describe('Copilot «¿A quién debería responder ahora?» con dos leads que se llaman igual', () => {
  it('nombra a los dos: el del aviso y el que espera respuesta', async () => {
    const T = await registerTrainer(app);
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const a = await webLead(T, 'Ana López');
    await triggerHandoff(T.businessId, a.conversationId, 'human_request', 'Quiere hablar con el entrenador');
    const b = await webLead(T, 'Ana López');
    await receiveInboundForConversation(T.businessId, b.conversationId, '¿Tenéis plan para principiantes?');

    const res = await T.client.post('/api/copilot/ask', { question: '¿A quién debería responder ahora?' });
    expect(res.statusCode, res.body).toBe(200);
    const text = res.json().text as string;
    expect(text).toContain('Te necesitan: Ana López (KAI necesita tu intervención)');
    // Antes se comparaba por nombre y la segunda Ana desaparecía de la respuesta.
    expect(text).toContain('También esperan tu respuesta: Ana López');
  });
});
