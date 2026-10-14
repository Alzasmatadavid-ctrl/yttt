import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, leads } from '../../src/database/schema.js';
import { loadBusinessContext, loadConversationContext, loadLeadContext } from '../../src/ai/context/context.js';
import { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import { ensureDirectiveAction } from '../../src/ai/setter/setter-engine.js';
import { openAgenda, registerTrainer, setupTestApp, teardownTestApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

describe('Modo sin IA: cualificación en su sitio', () => {
  it('capta el objetivo del primer mensaje, no lo vuelve a preguntar y guarda lo siguiente como problema', async () => {
    const t = await registerTrainer(app);
    await openAgenda(t.client);
    const { conversationId, leadId } = (await t.client.post('/api/simulator/conversations', { leadName: 'Marta' })).json();

    const r1 = (await t.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text: 'Hola! Vi tu reel, quiero perder unos 8 kilos' })).json();
    let [lead] = await getDb().select().from(leads).where(eq(leads.id, leadId));
    expect(lead.qualification.goal?.value).toMatch(/perder unos 8 kilos/);
    // KAI no pregunta otra vez por el objetivo.
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.state.lastAskedKey).not.toBe('goal');
    expect(r1.result.text).toBeTruthy();

    await t.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text: 'Trabajo muchas horas y como fatal entre semana' });
    [lead] = await getDb().select().from(leads).where(eq(leads.id, leadId));
    expect(lead.qualification.goal?.value).toMatch(/perder unos 8 kilos/);
    expect(lead.qualification.problem?.value).toMatch(/como fatal/);
  });
});

describe('La reserva anunciada se hace de verdad', () => {
  it('si la IA no llamó a la herramienta, se reserva igualmente (y solo una vez)', async () => {
    const t = await registerTrainer(app);
    await openAgenda(t.client);
    const { conversationId, leadId } = (await t.client.post('/api/simulator/conversations', { leadName: 'Bea' })).json();
    const biz = await loadBusinessContext(t.businessId);
    const leadCtx = await loadLeadContext(t.businessId, leadId);
    const convCtx = await loadConversationContext(t.businessId, conversationId);

    // Oferta real de horarios (como haría la IA en el turno anterior).
    const offerBox = new SetterToolbox(biz, leadCtx, convCtx.conversation);
    const offer = JSON.parse((await offerBox.run('get_available_slots', { date: null, part_of_day: 'any' })).content) as { slots: { slot_id: string }[] };
    expect(offer.slots.length).toBeGreaterThan(0);

    // Turno siguiente: la directiva es reservar, pero la IA “solo escribió” sin usar book_call.
    const conv = (await loadConversationContext(t.businessId, conversationId)).conversation;
    const toolbox = new SetterToolbox(biz, leadCtx, conv);
    const directive = { kind: 'book_slot' as const, slotId: offer.slots[0].slot_id, instruction: '' };
    expect(await ensureDirectiveAction(directive, toolbox, leadCtx)).toBe(true);
    expect(toolbox.booked).not.toBeNull();
    // Ya hecha: no se repite.
    expect(await ensureDirectiveAction(directive, toolbox, leadCtx)).toBe(false);
    const appts = (await t.client.get('/api/agenda/appointments', { query: { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date(Date.now() + 40 * 86400_000).toISOString() } })).json();
    const list = (appts.appointments ?? appts.items ?? []) as { appointment?: { leadId: string }; leadId?: string }[];
    expect(list.filter((a) => (a.appointment?.leadId ?? a.leadId) === leadId)).toHaveLength(1);
  });
});
