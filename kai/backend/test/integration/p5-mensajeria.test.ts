/**
 * Revisión nº5 — grupo «mensajería»: bajas y mensajes de cortesía, reacciones de WhatsApp, alta tras una baja,
 * plantillas sin nombre, eco de Instagram y orden de los mensajes que se cruzan con un envío.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, conversations, followUps, leadEvents, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { handleMetaWebhook } from '../../src/webhooks/meta.webhook.js';
import { receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation, insertMessage } from '../../src/crm/conversations.service.js';
import { createAlert } from '../../src/crm/alerts.service.js';
import { scheduleAppointmentJobs } from '../../src/automation/reminders.js';
import { scheduleNoReplyFollowUp } from '../../src/automation/followups.js';
import { json, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await setupTestApp();
});
afterAll(async () => {
  await teardownTestApp(app);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────── Utilidades ─────────────

type InboxItem = { conversation: { id: string }; needsHumanReply: boolean };
async function inboxPending(T: Trainer) {
  const body = json(await T.client.get('/api/inbox', { query: { filter: 'pending', limit: '200' } }));
  return { ids: (body.items as InboxItem[]).map((i) => i.conversation.id), count: body.counts.pending as number };
}

const openAlerts = (businessId: string, leadId: string, type?: 'client_message' | 'new_lead_manual' | 'handoff') =>
  getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.businessId, businessId), eq(alerts.leadId, leadId), eq(alerts.status, 'open'), ...(type ? [eq(alerts.type, type)] : [])));

const conversationMessages = (conversationId: string) =>
  getDb().select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));

const pendingJobs = (prefix: string) =>
  getDb()
    .select()
    .from(scheduledJobs)
    .where(and(like(scheduledJobs.dedupeKey, `${prefix}%`), eq(scheduledJobs.status, 'pending')));

async function whatsappConnection(T: Trainer, phoneNumberId: string, config: Record<string, unknown> = {}) {
  const res = await T.client.post('/api/integrations/channels', {
    channel: 'whatsapp',
    externalAccountId: phoneNumberId,
    accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
    skipVerification: true,
    config,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().connection.id as string;
}

/** Aviso de WhatsApp con un mensaje entrante (`timestamp` en segundos, como lo manda Meta). */
function waInbound(phoneNumberId: string, from: string, msg: Record<string, unknown>, name = 'Óscar Lead') {
  return handleMetaWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
            },
          },
        ],
      },
    ],
  });
}

/** Simula la API de WhatsApp: responde al envío con `wamid` y, mientras «envía», ejecuta `during` (si se da). */
function mockWhatsAppSend(wamid: string, during?: () => Promise<void>) {
  const bodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'graph.facebook.com') throw new Error(`Red no permitida en tests: ${url}`);
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    if (during) await during();
    return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return bodies;
}

// ───────────── 1) Lead dado de baja que solo da las gracias ─────────────

describe('Lead dado de baja: un «Gracias» a la despedida no es «volver a escribir»', () => {
  it('la cortesía no sale en «Pendientes» ni crea aviso; un mensaje de verdad sí, y el entrenador puede darlo por visto', async () => {
    const T = await registerTrainer(app);
    const profile = { whatsappId: '34600705001', phone: '+34600705001', name: 'Pablo Gracias' };
    const first = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'No me escribáis más, dadme de baja', profile });
    if (first.duplicate) throw new Error('inesperado');
    const { lead, conversation } = first;
    expect((await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: true })).statusCode).toBe(200);

    // «Gracias, igualmente» y «👍» a la despedida: nada que atender.
    for (const text of ['Gracias, igualmente', '👍', 'Vale, un saludo!']) {
      await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text, profile });
      expect((await inboxPending(T)).ids).not.toContain(conversation.id);
      expect(await openAlerts(T.businessId, lead.id, 'client_message')).toHaveLength(0);
    }

    // Un mensaje de verdad: sale en «Pendientes» con su aviso (que explica las dos salidas).
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Oye, ¿al final cuánto costaba el plan?', profile });
    expect((await inboxPending(T)).ids).toContain(conversation.id);
    const [alert] = await openAlerts(T.businessId, lead.id, 'client_message');
    expect(alert.body).toMatch(/Volver a permitir mensajes/);
    expect(alert.body).toMatch(/descarta este aviso/);

    // Un «Gracias» después no lo tapa: lo anterior sigue sin atender.
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Gracias', profile });
    expect((await inboxPending(T)).ids).toContain(conversation.id);

    // Descartar el aviso = visto: sigue de baja y deja de estar pendiente.
    expect((await T.client.post(`/api/alerts/${alert.id}/resolve`, { status: 'dismissed' })).statusCode).toBe(200);
    expect((await inboxPending(T)).ids).not.toContain(conversation.id);
    const [after] = await getDb().select().from(leads).where(eq(leads.id, lead.id));
    expect(after.optedOut).toBe(true);
    const events = await getDb()
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.type, 'opted_out')));
    expect(events.some((e) => e.data.acknowledged === true && e.actorType === 'human')).toBe(true);
    expect(events.some((e) => e.data.courtesy === true)).toBe(true);

    // Vuelve a escribir algo: otra vez pendiente; «Marcar como atendido» también lo da por visto y cierra el aviso.
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Me lo estoy pensando otra vez', profile });
    expect((await inboxPending(T)).ids).toContain(conversation.id);
    expect(await openAlerts(T.businessId, lead.id, 'client_message')).toHaveLength(1);
    const attended = await T.client.post(`/api/conversations/${conversation.id}/handoff-attended`);
    expect(attended.statusCode).toBe(200);
    expect(attended.json().changed).toBe(true);
    expect((await inboxPending(T)).ids).not.toContain(conversation.id);
    expect(await openAlerts(T.businessId, lead.id, 'client_message')).toHaveLength(0);
    // Sin nada nuevo, no hay nada que marcar.
    expect((await T.client.post(`/api/conversations/${conversation.id}/handoff-attended`)).json().changed).toBe(false);

    // KAI no le contesta en ningún momento.
    expect(await pendingJobs(`reply:${conversation.id}`)).toHaveLength(0);
  });
});

// ───────────── 2) Reacciones de WhatsApp ─────────────

describe('WhatsApp: una reacción (👍) no es un mensaje del lead', () => {
  it('se guarda en el mensaje reaccionado; ni se contesta, ni cuenta como respuesta, ni avisa si está de baja', async () => {
    const T = await registerTrainer(app);
    const PN = '109000000005201';
    await whatsappConnection(T, PN);
    await waInbound(PN, '34600705201', { id: 'wamid.p5.in1', type: 'text', text: { body: 'Hola, quiero perder 10 kilos' } });
    const [lead] = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, '34600705201')));
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead.id));
    // KAI ya ha contestado (su mensaje tiene id de WhatsApp) y no queda ninguna respuesta pendiente.
    await insertMessage({ businessId: T.businessId, conversationId: conv.id, leadId: lead.id, direction: 'outbound', senderType: 'kai', content: '¡Hola! Soy KAI…', externalId: 'wamid.p5.out1' });
    await getDb().update(scheduledJobs).set({ status: 'cancelled' }).where(eq(scheduledJobs.dedupeKey, `reply:${conv.id}`));
    const before = await conversationMessages(conv.id);
    const [convBefore] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));

    expect((await waInbound(PN, '34600705201', { id: 'wamid.p5.react1', type: 'reaction', reaction: { message_id: 'wamid.p5.out1', emoji: '👍' } })).failed).toBe(0);
    let rows = await conversationMessages(conv.id);
    expect(rows).toHaveLength(before.length);
    expect(rows.some((m) => m.content.includes('no soportado'))).toBe(false);
    expect((rows.find((m) => m.externalId === 'wamid.p5.out1')!.metadata.reaction as { emoji: string }).emoji).toBe('👍');
    expect(await pendingJobs(`reply:${conv.id}`)).toHaveLength(0);
    const [convAfter] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    expect(convAfter.lastInboundAt?.getTime()).toBe(convBefore.lastInboundAt?.getTime());

    // Quitar la reacción (emoji vacío) la borra; los avisos del sistema se ignoran.
    await waInbound(PN, '34600705201', { id: 'wamid.p5.react2', type: 'reaction', reaction: { message_id: 'wamid.p5.out1', emoji: '' } });
    await waInbound(PN, '34600705201', { id: 'wamid.p5.sys', type: 'system', system: { body: 'El usuario ha cambiado de número' } });
    rows = await conversationMessages(conv.id);
    expect(rows).toHaveLength(before.length);
    expect(rows.find((m) => m.externalId === 'wamid.p5.out1')!.metadata.reaction).toBeUndefined();

    // Dado de baja: reaccionar a la despedida no genera el aviso de «te ha vuelto a escribir».
    expect((await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: true })).statusCode).toBe(200);
    await waInbound(PN, '34600705201', { id: 'wamid.p5.react3', type: 'reaction', reaction: { message_id: 'wamid.p5.out1', emoji: '🙏' } });
    expect(await openAlerts(T.businessId, lead.id, 'client_message')).toHaveLength(0);
    expect((await inboxPending(T)).ids).not.toContain(conv.id);
  });
});

// ───────────── 3) Alta tras una baja: vuelven los recordatorios ─────────────

describe('Dar de baja y volver a permitir mensajes', () => {
  it('reprograma los recordatorios de la llamada que sigue en pie (sin repetir la confirmación)', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Raúl Recordatorios', source: 'manual' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    const [appt] = await getDb()
      .insert(appointments)
      .values({ businessId: T.businessId, leadId: lead.id, conversationId: conv.id, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), bookedBy: 'human' })
      .returning();
    await scheduleAppointmentJobs(T.businessId, appt, { sendConfirmation: true });
    const keys = async () => (await pendingJobs(`appt:${appt.id}:`)).map((j) => j.dedupeKey!.split(':').pop()).sort();
    expect(await keys()).toEqual(['confirm', 'post', 'r1', 'r24']);

    expect((await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: true })).statusCode).toBe(200);
    expect(await keys()).toEqual(['post']);

    expect((await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: false })).statusCode).toBe(200);
    expect(await keys()).toEqual(['post', 'r1', 'r24']);
  });
});

// ───────────── 4) Plantillas de WhatsApp sin nombre ─────────────

describe('Plantillas de WhatsApp: lead sin nombre', () => {
  it('{{1}} no es «hola» (el lead leería «Hola hola, …»)', async () => {
    const T = await registerTrainer(app);
    const connId = await whatsappConnection(T, '109000000005401', { templates: { firstContact: { name: 'primer_contacto', language: 'es' } } });
    const send = async (name: string, wa: string, wamid: string) => {
      const { lead } = await createLead(T.businessId, { name, whatsappId: wa, phone: `+${wa}`, source: 'landing' }, { type: 'integration' });
      const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp', connId);
      const bodies = mockWhatsAppSend(wamid);
      const res = await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: 'Hola, soy KAI…', sender: { type: 'kai' }, purpose: 'first_contact' });
      vi.restoreAllMocks();
      expect(res.delivered).toBe(true);
      const params = (bodies[0].template as { components: { parameters: { text: string }[] }[] }).components[0].parameters;
      return { first: params[0].text, content: res.message.content };
    };
    const anonymous = await send('', '34600705401', 'wamid.p5.tpl1');
    expect(anonymous.first).toBe('👋');
    expect(anonymous.content).not.toMatch(/hola/i);
    expect((await send('Óscar Pérez', '34600705402', 'wamid.p5.tpl2')).first).toBe('Óscar');
  });
});

// ───────────── 5) Respuesta del entrenador desde la app de Instagram ─────────────

describe('Instagram: contestar desde la app cierra los avisos como contestar desde KAI', () => {
  async function igLead(T: Trainer, igAccount: string, igsid: string) {
    const conn = await T.client.post('/api/integrations/channels', {
      channel: 'instagram',
      externalAccountId: igAccount,
      accessToken: 'IGQ-token-de-prueba-0123456789abcdef',
      skipVerification: true,
    });
    expect(conn.statusCode, conn.body).toBe(200);
    const r = await receiveInboundMessage({
      businessId: T.businessId,
      channel: 'instagram',
      channelConnectionId: conn.json().connection.id,
      externalMessageId: `mid.p5.in.${igsid}`,
      text: 'Hola, ya soy cliente: ¿mañana entrenamos?',
      profile: { instagramUserId: igsid, name: 'Íñigo Insta' },
    });
    if (r.duplicate) throw new Error('inesperado');
    await createAlert({ businessId: T.businessId, type: 'client_message', title: 'Tu cliente te ha escrito', leadId: r.lead.id, conversationId: r.conversation.id });
    await createAlert({ businessId: T.businessId, type: 'new_lead_manual', title: 'Nuevo lead: contacto manual', leadId: r.lead.id, conversationId: r.conversation.id });
    return { conversationId: r.conversation.id, leadId: r.lead.id };
  }
  const echo = (igAccount: string, igsid: string, mid: string, timestamp: number, text = 'Sí, mañana a las 9') =>
    handleMetaWebhook({
      object: 'instagram',
      entry: [{ id: igAccount, messaging: [{ sender: { id: igAccount }, recipient: { id: igsid }, timestamp, message: { mid, text, is_echo: true } }] }],
    });

  it('el eco del entrenador resuelve «Tu cliente te ha escrito» y «contacto manual» y cancela el seguimiento', async () => {
    const T = await registerTrainer(app);
    const { conversationId, leadId } = await igLead(T, '178414000000501', '9005001');
    expect(await scheduleNoReplyFollowUp(T.businessId, leadId, conversationId)).toBeTruthy();
    // Un eco de hace un par de minutos: no hay que esperar a ver si era de KAI.
    await echo('178414000000501', '9005001', 'mid.p5.echo.human', Date.now() - 120_000);
    const [row] = await getDb().select().from(messages).where(eq(messages.externalId, 'mid.p5.echo.human'));
    expect(row.senderType).toBe('human');
    expect(await openAlerts(T.businessId, leadId, 'client_message')).toHaveLength(0);
    expect(await openAlerts(T.businessId, leadId, 'new_lead_manual')).toHaveLength(0);
    const fu = await getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, leadId), eq(followUps.reason, 'no_reply'), eq(followUps.status, 'scheduled')));
    expect(fu).toHaveLength(0);
  });

  it('si el «eco» era un envío de KAI que tardó en confirmarse, los avisos se vuelven a abrir', async () => {
    const T = await registerTrainer(app);
    const { conversationId, leadId } = await igLead(T, '178414000000502', '9005002');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'graph.instagram.com') throw new Error(`Red no permitida en tests: ${url}`);
      // Meta avisa del eco mientras KAI aún espera la respuesta del envío.
      await echo('178414000000502', '9005002', 'mid.p5.echo.kai', Date.now(), 'Íñigo, mañana es la llamada.');
      return new Response(JSON.stringify({ recipient_id: '9005002', message_id: 'mid.p5.echo.kai' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await sendMessage({ businessId: T.businessId, conversationId, text: 'Íñigo, mañana es la llamada.', sender: { type: 'kai' }, purpose: 'reminder' });
    expect(res.delivered).toBe(true);
    const rows = await getDb().select().from(messages).where(eq(messages.externalId, 'mid.p5.echo.kai'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.message.id, senderType: 'kai', status: 'sent' });
    expect(await openAlerts(T.businessId, leadId, 'client_message')).toHaveLength(1);
    expect(await openAlerts(T.businessId, leadId, 'new_lead_manual')).toHaveLength(1);
  }, 15_000);
});

// ───────────── 6) Mensajes del lead que se cruzan con un envío ─────────────

describe('Un mensaje del lead que llega mientras se le envía una respuesta no se da por contestado', () => {
  it('el entrenador contesta y, mientras se envía, el lead escribe (WhatsApp lo fecha antes): sigue en «Pendientes»', async () => {
    const T = await registerTrainer(app);
    const PN = '109000000005601';
    await whatsappConnection(T, PN);
    await waInbound(PN, '34600705601', { id: 'wamid.p5.o1', type: 'text', text: { body: 'Hola, quiero perder 10 kilos' } });
    const [lead] = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, '34600705601')));
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead.id));

    let queuedWhileSending: string[] = [];
    mockWhatsAppSend('wamid.p5.out.o1', async () => {
      // El mensaje del entrenador ya está guardado (en cola) mientras se envía.
      queuedWhileSending = (await conversationMessages(conv.id)).filter((m) => m.status === 'queued').map((m) => m.content);
      // WhatsApp da la hora en segundos: el mensaje del lead llega fechado ANTES de la respuesta.
      await handleMetaWebhook({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: PN },
                  messages: [{ id: 'wamid.p5.o2', from: '34600705601', timestamp: String(Math.floor((Date.now() - 2000) / 1000)), type: 'text', text: { body: '¿Y cuánto cuesta?' } }],
                },
              },
            ],
          },
        ],
      });
    });
    const res = await T.client.post(`/api/conversations/${conv.id}/messages`, { text: 'Hola Óscar, ¡claro que te ayudo!' });
    expect(res.json().delivered).toBe(true);
    expect(queuedWhileSending).toEqual(['Hola Óscar, ¡claro que te ayudo!']);

    const rows = await conversationMessages(conv.id);
    expect(rows.map((m) => m.content)).toEqual(['Hola, quiero perder 10 kilos', 'Hola Óscar, ¡claro que te ayudo!', '¿Y cuánto cuesta?']);
    const late = rows[2];
    expect(late.createdAt.getTime()).toBeGreaterThan(rows[1].createdAt.getTime());
    expect(typeof late.metadata.sentAt).toBe('string');
    expect(rows[1].status).toBe('sent');
    expect((await inboxPending(T)).ids).toContain(conv.id);
    // La vista previa de la Bandeja sigue siendo el último mensaje (el del lead).
    const [after] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.lastMessagePreview).toBe('¿Y cuánto cuesta?');
  });

  it('un mensaje fechado (en segundos) justo antes de la respuesta ya guardada queda después de ella', async () => {
    const T = await registerTrainer(app);
    const PN = '109000000005602';
    await whatsappConnection(T, PN);
    await waInbound(PN, '34600705602', { id: 'wamid.p5.r1', type: 'text', text: { body: 'Hola' } });
    const [lead] = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, '34600705602')));
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead.id));
    mockWhatsAppSend('wamid.p5.out.r1');
    const reply = await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: '¡Hola! ¿Qué te gustaría conseguir?', sender: { type: 'kai' }, purpose: 'reply' });
    expect(reply.delivered).toBe(true);
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, conv.id));

    const sentAt = Math.floor((reply.message.createdAt.getTime() - 300) / 1000);
    await handleMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PN }, messages: [{ id: 'wamid.p5.r2', from: '34600705602', timestamp: String(sentAt), type: 'text', text: { body: 'Perder grasa' } }] } }] }],
    });
    const [late] = await getDb().select().from(messages).where(eq(messages.externalId, 'wamid.p5.r2'));
    expect(late.createdAt.getTime()).toBeGreaterThan(reply.message.createdAt.getTime());
    expect(late.metadata.sentAt).toBe(new Date(sentAt * 1000).toISOString());
    expect((await inboxPending(T)).ids).toContain(conv.id);
  });

  it('un envío que falla deja un solo mensaje «no enviado» (sin quedarse en cola) y no cambia la vista previa', async () => {
    const T = await registerTrainer(app);
    const PN = '109000000005603';
    await whatsappConnection(T, PN);
    await waInbound(PN, '34600705603', { id: 'wamid.p5.f1', type: 'text', text: { body: 'Hola, ¿info?' } });
    const [lead] = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, '34600705603')));
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead.id));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const res = await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: 'Te cuento…', sender: { type: 'kai' }, purpose: 'reply' });
    expect(res.delivered).toBe(false);
    const outs = (await conversationMessages(conv.id)).filter((m) => m.direction === 'outbound');
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({ id: res.message.id, status: 'failed' });
    expect(outs[0].error).toBeTruthy();
    const [after] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after.lastMessagePreview).toBe('Hola, ¿info?');
  });
});
