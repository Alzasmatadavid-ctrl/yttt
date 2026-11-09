/*
 * Integración final de la revisión p4: lo que une el servidor y la web.
 *  - Bandeja: cada conversación dice si la respuesta al lead no se pudo enviar (`replyUnsent`), con el mismo criterio
 *    que `unsentReply` de la web; la lista muestra «Respuesta no enviada…» en vez de «Mensaje sin contestar…».
 *  - «Añadir negocio»: el panel usa los negocios de la cuenta (`accountBusinesses`), como el servidor.
 *  - Modo sin IA: preguntar si se puede hacer «sin hablar por teléfono» no es pedir la llamada (es no quererla), y
 *    «¿podemos pasarla a otro día?» no ofrece otra hora del mismo día.
 *  - Modo sin IA: pedir hablar con el entrenador o hablar de la llamada no se guarda como respuesta a la pregunta
 *    pendiente (la ficha mostraba «Objetivo: Prefiero hablar con David directamente» y «Encaje: sí»).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../src/database/client.js';
import { appointments, conversations, messages } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { runSetterReply } from '../../src/ai/setter/setter-engine.js';
import { receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from '../integration/helpers.js';
import { makeAnalysisInput } from './factories.js';

// La web importa '@shared' (alias de Vite a src/lib/domain.ts); aquí se resuelve igual.
vi.mock('@shared', async () => await import('../../src/lib/domain.js'));

type InboxItem = {
  conversation: { id: string; handoffActive: boolean; aiEnabled: boolean };
  lead: { name: string; status: string; nextAction: string | null; optedOut: boolean };
  needsHumanReply: boolean;
  replyUnsent: boolean;
};
type Conv = { handoffActive?: boolean; aiEnabled?: boolean; needsHumanReply?: boolean; replyUnsent?: boolean } | null;
type NextActionFor = (lead: { status: string; nextAction?: string | null; optedOut?: boolean }, conv?: Conv, upcoming?: { startsAt: string } | null, timeZone?: string, autopilotOn?: boolean) => string;
type Msg = { direction: 'inbound' | 'outbound'; senderType: 'lead' | 'kai' | 'human' | 'system'; status: string; error: string | null; metadata: Record<string, unknown> };
type UnsentReply = (messages: Msg[]) => { reason: string | null } | null;

// Se cargan por ruta: así la web no entra en la compilación del servidor (tsc) y vitest la transforma igual.
const here = path.dirname(fileURLToPath(import.meta.url));
const web = (file: string) => path.join(here, '../../../frontend/src', file);
let nextActionFor: NextActionFor;
let unsentReply: UnsentReply;

let app: FastifyInstance;
beforeAll(async () => {
  ({ nextActionFor } = (await import(web('lib/leads.ts'))) as { nextActionFor: NextActionFor });
  ({ unsentReply } = (await import(web('lib/messages.ts'))) as { unsentReply: UnsentReply });
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});

async function inbox(T: Trainer, filter = 'all') {
  const res = await T.client.get('/api/inbox', { query: { filter } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: InboxItem[] }).items;
}

async function detailMessages(T: Trainer, conversationId: string) {
  const res = await T.client.get(`/api/conversations/${conversationId}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { messages: Msg[] }).messages;
}

describe('Bandeja: «Respuesta no enviada» también en la lista (replyUnsent)', () => {
  it('KAI contestó pero no había WhatsApp conectado: replyUnsent y el texto de la lista lo dicen', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Sergio Navarro', source: 'manual', phone: '+34600111222' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    await receiveInboundForConversation(T.businessId, conv.id, 'Hola, quiero perder 8 kilos antes del verano. ¿Cómo funciona?');
    await runSetterReply(T.businessId, conv.id);

    const [item] = (await inbox(T, 'pending')).filter((i) => i.conversation.id === conv.id);
    expect(item.needsHumanReply).toBe(true);
    expect(item.replyUnsent).toBe(true);
    // El mismo veredicto que la web saca de los mensajes del detalle.
    expect(Boolean(unsentReply(await detailMessages(T, conv.id)))).toBe(true);
    expect(nextActionFor(item.lead, { ...item.conversation, needsHumanReply: item.needsHumanReply, replyUnsent: item.replyUnsent })).toBe(
      'Respuesta no enviada: revisa el motivo en la conversación',
    );

    // Una respuesta posterior que sí sale (p. ej. tras conectar WhatsApp) cierra el asunto.
    await getDb()
      .insert(messages)
      .values({ businessId: T.businessId, conversationId: conv.id, leadId: lead.id, direction: 'outbound', senderType: 'human', senderUserId: T.userId, content: 'Te cuento ahora mismo.', status: 'sent' });
    const after = (await inbox(T)).find((i) => i.conversation.id === conv.id)!;
    expect(after.needsHumanReply).toBe(false);
    expect(after.replyUnsent).toBe(false);
  });

  it('nadie ha intentado contestar (conversación en tus manos): pendiente, pero no «no enviada»', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Daniel Pérez', source: 'manual', phone: '+34600111333' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, conv.id));
    await receiveInboundForConversation(T.businessId, conv.id, '¿Cuánto cuesta el programa?');

    const item = (await inbox(T, 'pending')).find((i) => i.conversation.id === conv.id)!;
    expect(item.needsHumanReply).toBe(true);
    expect(item.replyUnsent).toBe(false);
    expect(unsentReply(await detailMessages(T, conv.id))).toBeNull();
    expect(nextActionFor(item.lead, { ...item.conversation, needsHumanReply: item.needsHumanReply, replyUnsent: item.replyUnsent })).not.toMatch(/no enviada/);
  });

  it('un recordatorio o un seguimiento que no salió no es la respuesta al lead', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Luis Domínguez', source: 'manual', phone: '+34600111444' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, conv.id));
    await receiveInboundForConversation(T.businessId, conv.id, 'Vale, hablamos la semana que viene');
    await getDb().insert(messages).values({
      businessId: T.businessId,
      conversationId: conv.id,
      leadId: lead.id,
      direction: 'outbound',
      senderType: 'kai',
      content: 'Te recuerdo tu llamada de mañana.',
      status: 'skipped',
      error: 'WhatsApp no está conectado.',
      metadata: { purpose: 'reminder' },
    });

    const item = (await inbox(T, 'pending')).find((i) => i.conversation.id === conv.id)!;
    expect(item.needsHumanReply).toBe(true);
    expect(item.replyUnsent).toBe(false);
    expect(unsentReply(await detailMessages(T, conv.id))).toBeNull();
  });
});

describe('«Añadir negocio» en el panel: se cuenta por cuenta, como en el servidor', () => {
  it('AppLayout y Ajustes → Plan usan accountBusinesses (no los negocios en los que eres Entrenador)', () => {
    const layout = readFileSync(web('layouts/AppLayout.tsx'), 'utf8');
    expect(layout).toMatch(/activeBusiness\.accountBusinesses/);
    expect(layout).not.toMatch(/filter\(\(b\) => b\.role === 'trainer'\)/);
    const planTab = readFileSync(web('pages/settings/PlanTab.tsx'), 'utf8');
    expect(planTab).toMatch(/activeBusiness\?\.accountBusinesses/);
    expect(planTab).not.toMatch(/filter\(\(b\) => b\.role === 'trainer'\)/);
    expect(readFileSync(web('lib/types.ts'), 'utf8')).toMatch(/accountBusinesses: number/);
  });
});

describe('Modo sin IA: «sin hablar por teléfono» no es pedir la llamada', () => {
  const flagsOf = (text: string) => analyzeHeuristically(makeAnalysisInput(text)).flags;
  it.each(['¿Se puede hacer todo sin hablar por teléfono?', 'Me gustaría empezar sin hablar por teléfono', '¿Se puede hacer sin hacer la llamada?'])('«%s»', (text) => {
    expect(flagsOf(text).wantsCall).toBe(false);
    expect(flagsOf(text).declinesCall).toBe(true);
  });
  it('«Prefiero hablar por teléfono» sigue siendo pedirla', () => {
    expect(flagsOf('Prefiero hablar por teléfono').wantsCall).toBe(true);
  });
});

describe('Modo sin IA: mover la llamada «a otro día»', () => {
  it('ofrece horarios a partir del día siguiente al de la llamada, no otra hora del mismo día', async () => {
    const T = await registerTrainer(app);
    await openAgenda(T.client);
    const sim = await T.client.post('/api/simulator/conversations', { leadName: 'Iván' });
    expect(sim.statusCode, sim.body).toBe(200);
    const { conversationId, leadId } = sim.json() as { conversationId: string; leadId: string };
    const start = futureLocal(1, 10);
    const booked = await T.client.post('/api/agenda/appointments', { leadId, start: start.toISOString() });
    expect(booked.statusCode, booked.body).toBe(200);

    const res = await T.client.post(`/api/simulator/conversations/${conversationId}/messages`, { text: 'Me ha surgido algo, ¿podemos cambiar la llamada a otro día?' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.directive).toBe('reschedule');
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    const state = conv.state as { lastOfferIds?: string[]; offeredSlots?: { id: string; start: string }[] };
    const offered = (state.lastOfferIds ?? []).map((id) => state.offeredSlots?.find((x) => x.id === id)?.start);
    expect(offered.length).toBeGreaterThan(0);
    const day = (iso: string | Date) => DateTime.fromJSDate(new Date(iso)).setZone('Europe/Madrid').toISODate()!;
    for (const o of offered) expect(day(o!) > day(start)).toBe(true);
    // La llamada sigue en pie hasta que elija otra hora.
    const [appt] = await getDb().select().from(appointments).where(and(eq(appointments.leadId, leadId), eq(appointments.status, 'scheduled')));
    expect(appt.startsAt.toISOString()).toBe(start.toISOString());
  });
});

describe('Modo sin IA: lo que no responde a la pregunta pendiente no se guarda como respuesta', () => {
  const analyze = (text: string, lastAskedKey: string) => analyzeHeuristically(makeAnalysisInput(text, { state: { lastAskedKey } as never }));
  it.each([
    ['Prefiero hablar con Álex directamente', 'goal'],
    ['Quiero hablar con una persona real', 'goal'],
    ['Hola, ¿eres un bot o una persona?', 'goal'],
    ['No quiero hacer la llamada, prefiero seguir por aquí', 'commitment'],
    ['Prefiero hablar por teléfono la verdad', 'current_situation'],
  ])('«%s» (pregunta pendiente: %s)', (text, key) => {
    const a = analyze(text, key);
    expect(a.qualification[key]).toBeUndefined();
    expect(a.qualification.fit).toBeUndefined();
    expect(a.goalSummary).toBeNull();
  });
  it('una respuesta de verdad se sigue guardando', () => {
    expect(analyze('Trabajo en oficina y no entreno nada', 'current_situation').qualification.current_situation?.value).toBe('Trabajo en oficina y no entreno nada');
    expect(analyze('Quiero sentirme bien conmigo mismo', 'motivation').qualification.motivation?.value).toBe('Quiero sentirme bien conmigo mismo');
  });
});
