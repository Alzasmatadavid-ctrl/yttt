/**
 * Revisión nº 3 · Copilot y analítica (con base de datos PGlite y la app real, Copilot en modo reglas salvo
 * donde se inyecta un proveedor falso):
 * - «Escribe un seguimiento para este lead» usa el lead abierto detrás del panel (`context`), solo del propio negocio.
 * - «Reactivar a KAI» desde Copilot cierra también el escalado y su aviso (igual que «Devolver a KAI»).
 * - «¿A quién debería responder ahora?» nombra a los leads escalados aunque KAI ya les haya respondido.
 * - La nota del ROI no dice «frente a el coste de KAI».
 * - En «Hoy», un recordatorio automático no da por contestado el mensaje del lead (igual que «Pendientes»).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, businesses, conversations, pendingActions, plans } from '../../src/database/schema.js';
import { createPendingAction } from '../../src/ai/copilot/copilot-actions.js';
import { setLLMProvider } from '../../src/ai/providers/index.js';
import type { ChatRequest, LLMProvider } from '../../src/ai/providers/types.js';
import { getRoi } from '../../src/analytics/analytics.service.js';
import { insertMessage } from '../../src/crm/conversations.service.js';
import { triggerHandoff } from '../../src/crm/handoff.service.js';
import type { TenantContext } from '../../src/auth/guards.js';
import { ROLE_PERMISSIONS } from '../../src/lib/domain.js';
import { registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  setLLMProvider(undefined);
});

const ctxOf = (t: Trainer): TenantContext => ({ businessId: t.businessId, userId: t.userId, role: 'trainer', permissions: ROLE_PERMISSIONS.trainer });

/** Lead real con su conversación (chat web) y un primer mensaje suyo. */
async function newLead(t: Trainer, name: string, firstMessage: string | null = 'Hola, quiero perder grasa antes del verano') {
  const res = await t.client.post('/api/leads', { name });
  expect(res.statusCode, res.body).toBe(200);
  const leadId = res.json().lead.id as string;
  const conv = await t.client.post(`/api/leads/${leadId}/start-test-conversation`);
  expect(conv.statusCode, conv.body).toBe(200);
  const conversationId = conv.json().conversationId as string;
  if (firstMessage) await insertMessage({ businessId: t.businessId, conversationId, leadId, direction: 'inbound', senderType: 'lead', content: firstMessage });
  return { leadId, conversationId };
}

const ask = (t: Trainer, question: string, context?: Record<string, unknown>) => t.client.post('/api/copilot/ask', context ? { question, context } : { question });

const pendingOf = (t: Trainer) =>
  getDb()
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.businessId, t.businessId), eq(pendingActions.status, 'pending')));

// ───────────── «Este lead» ─────────────

describe('Copilot entiende «este lead» (contexto de pantalla)', () => {
  let T: Trainer;
  let carlos: { leadId: string; conversationId: string };
  beforeAll(async () => {
    T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Contexto' });
    carlos = await newLead(T, 'Carlos Pérez');
  });

  it('desde la ficha del lead: prepara el seguimiento para ese lead', async () => {
    const res = await ask(T, 'Escribe un seguimiento para este lead', { leadId: carlos.leadId });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.text).toContain('Carlos Pérez');
    expect(body.text).not.toMatch(/Dime el nombre/);
    expect(body.data.draft?.leadId).toBe(carlos.leadId);
    expect(body.data.actions).toHaveLength(1);
    const [action] = (await pendingOf(T)).filter((a) => a.id === body.data.actions[0].id);
    expect(action.payload.leadId).toBe(carlos.leadId);
  });

  it('desde la conversación: «escríbele un mensaje de seguimiento» también usa ese lead', async () => {
    const res = await ask(T, 'Escríbele un mensaje de seguimiento', { conversationId: carlos.conversationId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.draft?.leadId).toBe(carlos.leadId);
  });

  it('dos leads con el mismo nombre: con la conversación de uno abierta, es ese (sin bucle «abre su conversación»)', async () => {
    const otro = await newLead(T, 'Marta Ruiz');
    const segunda = await newLead(T, 'Marta Ruiz', 'Buenas, ¿cómo funciona lo de los entrenamientos?');
    const res = await ask(T, 'Escribe un seguimiento para Marta Ruiz', { conversationId: segunda.conversationId });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.text).not.toMatch(/varios leads/);
    expect(body.data.draft?.leadId).toBe(segunda.leadId);
    expect(body.data.draft?.leadId).not.toBe(otro.leadId);

    // Sin contexto se sigue pidiendo que lo aclare (mejor preguntar que escribir a otra persona).
    const sin = (await ask(T, 'Escribe un seguimiento para Marta Ruiz')).json();
    expect(sin.text).toMatch(/varios leads/);
    expect(sin.data.actions).toBeUndefined();
  });

  it('si nombra a otro lead que existe, se usa ese aunque haya otro abierto', async () => {
    const sergio = await newLead(T, 'Sergio Navarro');
    const res = (await ask(T, 'Escribe un seguimiento para Sergio', { leadId: carlos.leadId })).json();
    expect(res.data.draft?.leadId).toBe(sergio.leadId);
  });

  it('si nombra a alguien que no es un lead, no prepara nada para el lead abierto', async () => {
    const before = (await pendingOf(T)).length;
    const res = (await ask(T, 'Escribe un seguimiento para Bartolomé', { leadId: carlos.leadId })).json();
    expect(res.text).toMatch(/No encuentro a ningún lead con ese nombre/);
    expect(res.text).toContain('Carlos Pérez');
    expect(res.data.actions).toBeUndefined();
    expect((await pendingOf(T)).length).toBe(before);
  });

  it('un lead o una conversación de OTRO negocio se ignoran (ni se usan ni se muestran)', async () => {
    const B = await registerTrainer(app, { name: 'Pablo Ortiz', businessName: 'Pablo Training' });
    for (const context of [{ leadId: carlos.leadId }, { conversationId: carlos.conversationId }]) {
      const res = await ask(B, 'Escribe un seguimiento para este lead', context);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('Carlos');
      expect(res.json().text).toMatch(/Dime el nombre del lead/);
      expect(res.json().data.actions).toBeUndefined();
    }
    expect(await pendingOf(B)).toHaveLength(0);
  });

  it('un identificador mal formado en el contexto no bloquea la pregunta', async () => {
    const res = await ask(T, '¿Qué leads están más calientes?', { leadId: 'no-es-un-uuid', conversationId: 42 });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('con IA: el prompt de sistema indica qué lead tiene abierto el entrenador', async () => {
    const systems: string[] = [];
    const provider: LLMProvider = {
      id: 'fake',
      describe: () => ({ provider: 'fake', mainModel: 'fake', fastModel: 'fake' }),
      chat: async (req: ChatRequest) => {
        systems.push(req.system.map((s) => s.text).join('\n'));
        return { blocks: [{ type: 'text', text: 'De acuerdo.' }], stopReason: 'end_turn', raw: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, model: 'fake' };
      },
      structured: (async () => {
        throw new Error('no se usa');
      }) as LLMProvider['structured'],
    };
    setLLMProvider(provider);
    const res = await ask(T, 'Escribe un seguimiento para este lead', { conversationId: carlos.conversationId });
    expect(res.statusCode, res.body).toBe(200);
    expect(systems.at(-1)).toContain('“Carlos Pérez”');
    expect(systems.at(-1)).toContain(`lead_id: ${carlos.leadId}`);

    await ask(T, '¿Qué leads están más calientes?');
    expect(systems.at(-1)).not.toContain('tiene abierta');
  });
});

// ───────────── Reactivar a KAI ─────────────

describe('Copilot «Reactivar a KAI» cierra el escalado', () => {
  it('quita el escalado, su motivo y el aviso «KAI necesita tu intervención» (también en Hoy)', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Reactivar' });
    const l = await newLead(T, 'Raúl Iglesias');
    await triggerHandoff(T.businessId, l.conversationId, 'human_request');
    const openHandoffs = () =>
      getDb()
        .select()
        .from(alerts)
        .where(and(eq(alerts.leadId, l.leadId), eq(alerts.type, 'handoff'), eq(alerts.status, 'open')));
    expect(await openHandoffs()).toHaveLength(1);

    const action = await createPendingAction(ctxOf(T), 'toggle_kai_conversation', { leadId: l.leadId, enabled: true });
    expect(action.summary).toMatch(/^Reactivar a KAI/);
    const res = await T.client.post(`/api/copilot/actions/${action.id}/confirm`);
    expect(res.statusCode, res.body).toBe(200);

    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, l.conversationId));
    expect(conv).toMatchObject({ aiEnabled: true, handoffActive: false, handoffReason: null });
    expect(await openHandoffs()).toHaveLength(0);
    const dash = (await T.client.get('/api/dashboard')).json();
    expect(dash.attention.alerts.map((a: { alert: { type: string } }) => a.alert.type)).not.toContain('handoff');
  });

  it('pausar a KAI sigue funcionando y no toca los avisos', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Pausar' });
    const l = await newLead(T, 'Óscar Pausa');
    await triggerHandoff(T.businessId, l.conversationId, 'medical');
    const action = await createPendingAction(ctxOf(T), 'toggle_kai_conversation', { leadId: l.leadId, enabled: false });
    expect((await T.client.post(`/api/copilot/actions/${action.id}/confirm`)).statusCode).toBe(200);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, l.conversationId));
    expect(conv).toMatchObject({ aiEnabled: false, handoffActive: true });
    expect(await getDb().select().from(alerts).where(and(eq(alerts.leadId, l.leadId), eq(alerts.status, 'open')))).toHaveLength(1);
  });
});

// ───────────── ¿A quién debería responder ahora? ─────────────

describe('Copilot «¿A quién debería responder ahora?»', () => {
  it('nombra al lead escalado aunque KAI ya le haya respondido (no dice que nadie espera)', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Atención' });
    const l = await newLead(T, 'Andrés Vidal', 'Tengo una lesión de rodilla. ¿Qué ejercicios puedo hacer?');
    // KAI contesta con el mensaje de salud y escala: ya no sale en «esperando respuesta», sino como aviso.
    await insertMessage({ businessId: T.businessId, conversationId: l.conversationId, leadId: l.leadId, direction: 'outbound', senderType: 'kai', content: 'Gracias por contármelo, Andrés. Se lo paso a Laura para que te responda ella.', metadata: { purpose: 'handoff' } });
    await triggerHandoff(T.businessId, l.conversationId, 'medical', 'Lesión de rodilla');
    const dash = (await T.client.get('/api/dashboard')).json();
    expect(dash.attention.waiting).toHaveLength(0);

    const res = await ask(T, '¿A quién debería responder ahora?');
    expect(res.statusCode, res.body).toBe(200);
    const text = res.json().text as string;
    expect(text).toContain('Te necesitan: Andrés Vidal (KAI necesita tu intervención)');
    expect(text).not.toMatch(/Ningún lead está esperando/);
  });

  it('sin nadie pendiente lo dice claramente, y los avisos generales se cuentan con concordancia', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Tranquila' });
    const none = (await ask(T, '¿A quién debería responder ahora?')).json();
    expect(none.text).toMatch(/^Ningún lead está esperando respuesta humana ahora mismo\./);

    await getDb().insert(alerts).values({ businessId: T.businessId, type: 'integration_error', severity: 'warning', title: 'Error al enviar por WhatsApp', body: 'Revisa la conexión.' });
    const one = (await ask(T, '¿A quién debería responder ahora?')).json();
    expect(one.text).toContain('Tienes un aviso general en Hoy (“Error al enviar por WhatsApp”)');
    expect(one.text).not.toMatch(/aviso\(s\)/);
  });
});

// ───────────── ROI ─────────────

describe('nota del ROI', () => {
  it('dice «frente al coste de KAI y a la inversión en anuncios», nunca «frente a el»', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit ROI' });
    const [biz] = await getDb().select({ planId: businesses.planId }).from(businesses).where(eq(businesses.id, T.businessId));
    const [plan] = await getDb().select().from(plans).where(eq(plans.id, biz.planId!));
    expect(plan.priceMonthlyCents).toBeGreaterThan(0);
    expect(plan.currency.toUpperCase()).toBe('EUR');
    const range = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date() };

    const soloPlan = await getRoi(T.businessId, range, 0, 'EUR');
    expect(soloPlan.note).toBe('Estimación: ingresos de clientes cerrados en el periodo frente al coste de KAI.');

    await getDb().update(businesses).set({ monthlyAdSpendCents: 30_000 }).where(eq(businesses.id, T.businessId));
    const ambos = await getRoi(T.businessId, range, 0, 'EUR');
    expect(ambos.note).toBe('Estimación: ingresos de clientes cerrados en el periodo frente al coste de KAI y a la inversión en anuncios indicada.');

    const dash = (await T.client.get('/api/dashboard')).json();
    const analytics = (await T.client.get('/api/analytics?period=30d')).json();
    for (const note of [dash.value.roi30d.note, analytics.roi.note] as string[]) {
      expect(note).not.toMatch(/\ba el\b/);
      expect(note).toContain('frente al coste de KAI');
    }

    // Solo anuncios (el plan se cobra en otra moneda): «frente a la inversión…».
    await getDb().update(plans).set({ currency: 'USD' }).where(eq(plans.id, plan.id));
    const soloAnuncios = await getRoi(T.businessId, range, 0, 'EUR').finally(() => getDb().update(plans).set({ currency: plan.currency }).where(eq(plans.id, plan.id)));
    expect(soloAnuncios.note).toMatch(/^Estimación: ingresos de clientes cerrados en el periodo frente a la inversión en anuncios indicada\. No incluye el coste de KAI/);
  });
});

// ───────────── Hoy: «Esperan tu respuesta» ─────────────

describe('Hoy: un recordatorio automático no contesta al lead', () => {
  it('el lead escribió, el entrenador lleva la conversación y solo salió un recordatorio: sigue esperando respuesta', async () => {
    const T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit Hoy' });
    const l = await newLead(T, 'Iván Recordatorio', 'Oye, ¿la llamada de mañana sigue en pie?');
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, l.conversationId));
    await insertMessage({
      businessId: T.businessId,
      conversationId: l.conversationId,
      leadId: l.leadId,
      direction: 'outbound',
      senderType: 'kai',
      content: 'Te recuerdo que mañana tenemos la llamada de valoración a las 18:00.',
      metadata: { purpose: 'reminder' },
      createdAt: new Date(Date.now() + 1000),
    });
    const waiting = async () => ((await T.client.get('/api/dashboard')).json().attention.waiting as { leadId: string }[]).map((w) => w.leadId);
    expect(await waiting()).toContain(l.leadId);
    const pending = (await T.client.get('/api/inbox', { query: { filter: 'pending' } })).json();
    expect(JSON.stringify(pending)).toContain(l.conversationId);

    // En cuanto el entrenador contesta, deja de esperar.
    await insertMessage({
      businessId: T.businessId,
      conversationId: l.conversationId,
      leadId: l.leadId,
      direction: 'outbound',
      senderType: 'human',
      senderUserId: T.userId,
      content: 'Sí, Iván, mañana a las 18:00 hablamos.',
      createdAt: new Date(Date.now() + 2000),
    });
    expect(await waiting()).not.toContain(l.leadId);
  });
});
