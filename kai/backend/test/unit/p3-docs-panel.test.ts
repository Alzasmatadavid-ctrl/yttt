/*
 * Pantalla «Hoy» → «Necesita tu atención»: cada asunto se pinta una sola vez y el contador cuenta lo que se pinta.
 * La lógica vive en la web (frontend/src/lib/attention.ts); aquí se prueba con datos sueltos y con el panel real.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, leads, messages } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { runSetterReply } from '../../src/ai/setter/setter-engine.js';
import { receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';
import { registerTrainer, setupTestApp, teardownTestApp } from '../integration/helpers.js';

type AlertRow = { alert: { type: string; leadId: string | null; conversationId: string | null } };
type WaitingRow = { conversationId: string; leadId: string };
type RiskRow = { id: string };
type AttentionItems = <A extends AlertRow, W extends WaitingRow, R extends RiskRow>(attention: {
  alerts: A[];
  waiting: W[];
  atRisk: R[];
}) => { handoffs: A[]; waiting: W[]; atRisk: R[]; otherAlerts: A[]; count: number };

// Se carga por ruta: así la web no entra en la compilación del servidor (tsc) y vitest la transforma igual.
const here = path.dirname(fileURLToPath(import.meta.url));
const attentionFile = path.join(here, '../../../frontend/src/lib/attention.ts');
let attentionItems: AttentionItems;

let app: FastifyInstance;
beforeAll(async () => {
  ({ attentionItems } = (await import(attentionFile)) as { attentionItems: AttentionItems });
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

const alert = (type: string, leadId: string | null, conversationId: string | null): AlertRow => ({ alert: { type, leadId, conversationId } });

describe('attentionItems (datos sueltos)', () => {
  it('un cliente que escribe sale una vez (como aviso), no también como «espera tu respuesta»', () => {
    const r = attentionItems({ alerts: [alert('client_message', 'L1', 'C1')], waiting: [{ conversationId: 'C1', leadId: 'L1' }], atRisk: [] });
    expect(r.waiting).toHaveLength(0);
    expect(r.otherAlerts).toHaveLength(1);
    expect(r.count).toBe(1);
  });

  it('el aviso de contacto manual y el escalado también absorben la conversación en espera', () => {
    const r = attentionItems({
      alerts: [alert('new_lead_manual', 'L1', 'C1'), alert('handoff', 'L2', 'C2')],
      waiting: [
        { conversationId: 'C1', leadId: 'L1' },
        { conversationId: 'C2', leadId: 'L2' },
      ],
      atRisk: [],
    });
    expect(r.waiting).toHaveLength(0);
    expect(r.count).toBe(2);
  });

  it('un lead que espera tu respuesta (o con escalado) no sale además como «a punto de perderse»', () => {
    const r = attentionItems({
      alerts: [alert('handoff', 'L2', 'C2')],
      waiting: [{ conversationId: 'C1', leadId: 'L1' }],
      atRisk: [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }],
    });
    expect(r.atRisk.map((l) => l.id)).toEqual(['L3']);
    expect(r.count).toBe(3);
  });

  it('los avisos que no se atienden contestando no quitan nada (p. ej. «no hay huecos libres»)', () => {
    const r = attentionItems({
      alerts: [alert('no_availability', 'L1', 'C1'), alert('integration_error', null, null)],
      waiting: [{ conversationId: 'C1', leadId: 'L1' }],
      atRisk: [{ id: 'L1' }],
    });
    expect(r.waiting).toHaveLength(1);
    // El lead ya sale como «espera tu respuesta»: no se repite como «a punto de perderse».
    expect(r.atRisk).toHaveLength(0);
    expect(r.otherAlerts).toHaveLength(2);
    expect(r.count).toBe(3);
  });

  it('asuntos distintos se cuentan todos', () => {
    const r = attentionItems({
      alerts: [alert('handoff', 'L1', 'C1'), alert('client_message', 'L2', 'C2')],
      waiting: [{ conversationId: 'C3', leadId: 'L3' }],
      atRisk: [{ id: 'L4' }],
    });
    expect(r.count).toBe(4);
  });
});

describe('Panel «Hoy» real: el mismo asunto no se cuenta dos veces', () => {
  it('escribe un cliente → 1 cosa (antes: aviso + «espera tu respuesta» = 2)', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Carlos Cliente', source: 'manual' }, { type: 'user', userId: T.userId });
    await getDb().update(leads).set({ status: 'client' }).where(eq(leads.id, lead.id));
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    await receiveInboundForConversation(T.businessId, conv.id, 'Esta semana no puedo ir el jueves');
    expect(await runSetterReply(T.businessId, conv.id)).toMatchObject({ status: 'skipped', reason: 'already_client' });

    const d = await getDashboard(T.businessId);
    // El servidor lo devuelve por las dos vías…
    expect(d.attention.alerts.map((a) => a.alert.type)).toEqual(['client_message']);
    expect(d.attention.waiting.map((w) => w.conversationId)).toEqual([conv.id]);
    // …y la pantalla lo pinta una sola vez.
    const r = attentionItems(d.attention);
    expect(r.count).toBe(1);
    expect(r.otherAlerts.map((a) => a.alert.conversationId)).toEqual([conv.id]);
  });

  it('piloto apagado y lead interesado sin contestar hace 3 días → 1 cosa (antes: «espera tu respuesta» + «a punto de perderse»)', async () => {
    const T = await registerTrainer(app);
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const { lead } = await createLead(T.businessId, { name: 'Irene Interesada', source: 'manual' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    const { message } = await receiveInboundForConversation(T.businessId, conv.id, 'Me interesa, ¿cuánto cuesta?');
    const old = new Date(Date.now() - 3 * 86_400_000);
    await getDb().update(messages).set({ createdAt: old }).where(eq(messages.id, message.id));
    await getDb().update(conversations).set({ lastInboundAt: old, lastMessageAt: old }).where(eq(conversations.id, conv.id));
    await getDb().update(leads).set({ score: 70, status: 'interested', createdAt: old, lastInboundAt: old }).where(eq(leads.id, lead.id));

    const d = await getDashboard(T.businessId);
    expect(d.attention.waiting.map((w) => w.leadId)).toEqual([lead.id]);
    // El servidor ya no lo repite como «a punto de perderse» (así Copilot dice lo mismo que la pantalla)…
    expect(d.attention.atRisk).toHaveLength(0);
    // …y la pantalla tampoco lo pintaría dos veces aunque llegara por las dos vías.
    expect(attentionItems({ ...d.attention, atRisk: [{ id: lead.id }] }).count).toBe(1);
    const r = attentionItems(d.attention);
    expect(r.count).toBe(1);
    expect(r.waiting.map((w) => w.leadId)).toEqual([lead.id]);
    expect(r.atRisk).toHaveLength(0);
  });
});
