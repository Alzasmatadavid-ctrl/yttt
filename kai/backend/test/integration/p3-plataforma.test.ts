/**
 * Revisión nº3 — grupo «plataforma»: Bandeja («Pendientes»), seguimientos con el piloto automático en pausa,
 * reactivación de cuentas, eco de Instagram y formulario público.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, automations, conversations, followUps, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import { triggerHandoff } from '../../src/crm/handoff.service.js';
import { handleMetaWebhook } from '../../src/webhooks/meta.webhook.js';
import { receiveInboundForConversation, receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { scheduleJob } from '../../src/automation/jobs.js';
import { runJob } from '../../src/automation/worker.js';
import { ApiClient, json, makePlatformAdmin, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

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

/** Lead real con su conversación de chat web (sin canal externo). */
async function webLead(T: Trainer, name: string) {
  const { lead } = await createLead(T.businessId, { name, source: 'manual' }, { type: 'user', userId: T.userId });
  const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
  return { leadId: lead.id, conversationId: conv.id };
}

/** Ejecuta YA un trabajo concreto (como lo haría el worker al reclamarlo) y lo devuelve actualizado. */
async function runJobNow(jobId: string) {
  const db = getDb();
  const [job] = await db
    .update(scheduledJobs)
    .set({ status: 'running', attempts: sql`${scheduledJobs.attempts} + 1`, lockedAt: new Date() })
    .where(eq(scheduledJobs.id, jobId))
    .returning();
  await runJob(job);
  return (await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)))[0];
}

type InboxItem = { conversation: { id: string }; needsHumanReply: boolean };
async function inboxPending(T: Trainer) {
  const body = json(await T.client.get('/api/inbox', { query: { filter: 'pending', limit: '200' } }));
  return { ids: (body.items as InboxItem[]).map((i) => i.conversation.id), count: body.counts.pending as number };
}
async function needsHumanReply(T: Trainer, conversationId: string) {
  const items = json(await T.client.get('/api/inbox', { query: { limit: '200' } })).items as InboxItem[];
  return items.find((i) => i.conversation.id === conversationId)?.needsHumanReply;
}

const openAlerts = (businessId: string, leadId: string) =>
  getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.businessId, businessId), eq(alerts.leadId, leadId), eq(alerts.status, 'open')));

const outbound = (conversationId: string) =>
  getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));

// ───────────── 1) Lead dado de baja que vuelve a escribir ─────────────

describe('Un lead dado de baja que vuelve a escribir no se pierde', () => {
  it('sale en «Pendientes» con un aviso; la propia petición de baja (o repetirla) no', async () => {
    const T = await registerTrainer(app);
    const profile = { whatsappId: '34600700801', phone: '+34600700801', name: 'Pablo Baja' };
    const first = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Dame de baja', profile });
    if (first.duplicate) throw new Error('inesperado');
    const { lead, conversation } = first;
    expect((await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: true })).statusCode).toBe(200);
    // La petición de baja no espera respuesta.
    expect((await inboxPending(T)).ids).not.toContain(conversation.id);

    // Vuelve a pedir la baja: sigue sin ser algo que contestar, ni genera avisos.
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Que no me escribáis más, gracias', profile });
    expect((await inboxPending(T)).ids).not.toContain(conversation.id);
    expect((await openAlerts(T.businessId, lead.id)).filter((a) => a.type === 'client_message')).toHaveLength(0);

    // Cambia de idea: el mensaje sale en «Pendientes» y el entrenador recibe un aviso.
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Perdona, me lo he pensado: sí me interesa, ¿cuánto cuesta?', profile });
    const pending = await inboxPending(T);
    expect(pending.ids).toContain(conversation.id);
    expect(pending.count).toBeGreaterThanOrEqual(1);
    expect(await needsHumanReply(T, conversation.id)).toBe(true);
    const open = (await openAlerts(T.businessId, lead.id)).filter((a) => a.type === 'client_message');
    expect(open).toHaveLength(1);
    expect(open[0].body).toContain('me lo he pensado');
    expect(open[0].body).toMatch(/Volver a permitir mensajes/);
    // KAI no le contesta (sigue dado de baja hasta que el entrenador lo permita).
    const replies = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `reply:${conversation.id}`), eq(scheduledJobs.status, 'pending')));
    expect(replies).toHaveLength(0);
  });

  it('un lead dado de baja sin mensajes nuevos no sale en «Pendientes»', async () => {
    const T = await registerTrainer(app);
    const l = await webLead(T, 'Olga Baja');
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, l.conversationId));
    await receiveInboundForConversation(T.businessId, l.conversationId, '¿Hola?');
    expect((await inboxPending(T)).ids).toContain(l.conversationId);
    expect((await T.client.post(`/api/leads/${l.leadId}/opt-out`, { optedOut: true, reason: 'Lo pidió por teléfono' })).statusCode).toBe(200);
    expect((await inboxPending(T)).ids).not.toContain(l.conversationId);
  });
});

// ───────────── 2) Los mensajes automáticos no cuentan como respuesta ─────────────

describe('Un recordatorio o una confirmación no contestan al lead', () => {
  it('el mensaje del lead sigue en «Pendientes» hasta que alguien le responde de verdad', async () => {
    const T = await registerTrainer(app);
    const l = await webLead(T, 'Lucía Recordatorio');
    expect((await T.client.post(`/api/conversations/${l.conversationId}/take-over`)).statusCode).toBe(200);
    await receiveInboundForConversation(T.businessId, l.conversationId, 'Oye, al final hoy no llego, ¿podemos pasarla a mañana?');
    expect((await inboxPending(T)).ids).toContain(l.conversationId);

    for (const purpose of ['reminder', 'confirmation', 'no_show', 'follow_up'] as const) {
      const sent = await sendMessage({ businessId: T.businessId, conversationId: l.conversationId, text: `Mensaje automático (${purpose})`, sender: { type: 'kai' }, purpose });
      expect(sent.delivered).toBe(true);
      expect((await inboxPending(T)).ids).toContain(l.conversationId);
      expect(await needsHumanReply(T, l.conversationId)).toBe(true);
    }

    const res = await T.client.post(`/api/conversations/${l.conversationId}/messages`, { text: 'Claro, la movemos a mañana a la misma hora.' });
    expect(res.json().delivered).toBe(true);
    expect((await inboxPending(T)).ids).not.toContain(l.conversationId);
  });
});

// ───────────── 3) Piloto automático en pausa ─────────────

describe('Con el piloto automático en pausa, KAI no envía seguimientos', () => {
  it('el seguimiento programado se omite y no se encadena el siguiente', async () => {
    const T = await registerTrainer(app);
    await getDb()
      .update(automations)
      .set({ enabled: true, config: { steps: [{ delayHours: 4, angle: 'Retomar la conversación.' }, { delayHours: 24, angle: 'Aportar algo útil.' }] } })
      .where(and(eq(automations.businessId, T.businessId), eq(automations.type, 'followup_no_reply')));
    const l = await webLead(T, 'Pablo Pausa');
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date() })
      .returning();
    const job = await scheduleJob({ businessId: T.businessId, type: 'followup', runAt: new Date(), payload: { followUpId: fu.id, leadId: l.leadId } });
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);

    expect((await runJobNow(job.id)).status).toBe('done');
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after.status).toBe('skipped');
    expect(after.note).toMatch(/[Pp]iloto automático/);
    expect(await outbound(l.conversationId)).toHaveLength(0);
    const scheduled = await getDb()
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, l.leadId), eq(followUps.status, 'scheduled')));
    expect(scheduled).toHaveLength(0);
  });

  it('tampoco envía el mensaje de no-show', async () => {
    const T = await registerTrainer(app);
    const l = await webLead(T, 'Nacho NoShow');
    const startsAt = new Date(Date.now() - 2 * 3600_000);
    const [appt] = await getDb()
      .insert(appointments)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), bookedBy: 'human', status: 'no_show' })
      .returning();
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const job = await scheduleJob({ businessId: T.businessId, type: 'no_show_message', runAt: new Date(), payload: { appointmentId: appt.id, leadId: l.leadId } });
    expect((await runJobNow(job.id)).status).toBe('done');
    expect(await outbound(l.conversationId)).toHaveLength(0);
  });
});

// ───────────── 4) Reactivar una cuenta que ya estaba activa ─────────────

describe('Panel de administración: reactivar una cuenta', () => {
  it('no vuelve a pedir el resultado de una llamada que ya se pidió (aunque se pulse «activar» sobre una cuenta activa o se suspenda y reactive)', async () => {
    const admin = await registerTrainer(app, { businessName: 'Plataforma P3' });
    await makePlatformAdmin(admin.userId);
    const T = await registerTrainer(app, { businessName: 'Negocio Activo P3' });
    const l = await webLead(T, 'Rafa Resultado');
    const startsAt = new Date(Date.now() - 3 * 3600_000);
    const [appt] = await getDb()
      .insert(appointments)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), bookedBy: 'human' })
      .returning();
    const post = await scheduleJob({ businessId: T.businessId, type: 'post_call', runAt: new Date(), payload: { appointmentId: appt.id, leadId: l.leadId }, dedupeKey: `appt:${appt.id}:post` });
    expect((await runJobNow(post.id)).status).toBe('done');
    const [outcome] = (await openAlerts(T.businessId, l.leadId)).filter((a) => a.type === 'call_outcome');
    expect(outcome).toBeDefined();
    expect((await T.client.post(`/api/alerts/${outcome.id}/resolve`, { status: 'dismissed' })).statusCode).toBe(200);

    const pendingPost = () =>
      getDb()
        .select()
        .from(scheduledJobs)
        .where(and(like(scheduledJobs.dedupeKey, `appt:${appt.id}:%`), eq(scheduledJobs.status, 'pending')));

    // «Activar» una cuenta que ya está activa no reprograma nada.
    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'active' })).statusCode).toBe(200);
    expect(await pendingPost()).toHaveLength(0);

    // Suspender y reactivar: el aviso post-llamada que ya se hizo tampoco se repite.
    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'active' })).statusCode).toBe(200);
    expect(await pendingPost()).toHaveLength(0);
    expect((await openAlerts(T.businessId, l.leadId)).filter((a) => a.type === 'call_outcome')).toHaveLength(0);
  });

  it('al reactivar una cuenta suspendida, el aviso post-llamada que se canceló sí se vuelve a programar', async () => {
    const admin = await registerTrainer(app, { businessName: 'Plataforma P3 bis' });
    await makePlatformAdmin(admin.userId);
    const T = await registerTrainer(app, { businessName: 'Negocio Suspendido P3' });
    const l = await webLead(T, 'Sara Suspendida');
    const startsAt = new Date(Date.now() - 3 * 3600_000);
    const [appt] = await getDb()
      .insert(appointments)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), bookedBy: 'human' })
      .returning();
    await scheduleJob({ businessId: T.businessId, type: 'post_call', runAt: new Date(Date.now() + 3600_000), payload: { appointmentId: appt.id, leadId: l.leadId }, dedupeKey: `appt:${appt.id}:post` });
    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'active' })).statusCode).toBe(200);
    const pending = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `appt:${appt.id}:post`), eq(scheduledJobs.status, 'pending')));
    expect(pending).toHaveLength(1);
  });
});

// ───────────── 5) Eco de Instagram ─────────────

describe('Instagram: el eco de un envío de KAI no cambia quién lleva la conversación', () => {
  async function igLead(igAccount: string, igsid: string) {
    const T = await registerTrainer(app);
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
      externalMessageId: `mid.in.${igsid}`,
      text: 'Hola, quiero info',
      profile: { instagramUserId: igsid, name: 'Íñigo Insta' },
    });
    if (r.duplicate) throw new Error('inesperado');
    return { T, conversationId: r.conversation.id, leadId: r.lead.id };
  }
  /** Meta avisa del eco mientras KAI aún espera la respuesta del envío. */
  function echoBeforeGraphAnswers(igAccount: string, igsid: string, mid: string) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'graph.instagram.com') throw new Error(`Red no permitida en tests: ${url}`);
      await handleMetaWebhook({
        object: 'instagram',
        entry: [{ id: igAccount, messaging: [{ sender: { id: igAccount }, recipient: { id: igsid }, timestamp: Date.now(), message: { mid, text: 'Mensaje', is_echo: true } }] }],
      });
      return new Response(JSON.stringify({ recipient_id: igsid, message_id: mid }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  }

  it('con el entrenador al mando, un recordatorio de KAI no reactiva a KAI', async () => {
    const { T, conversationId } = await igLead('178414000000401', '9002001');
    expect((await T.client.post(`/api/conversations/${conversationId}/take-over`)).statusCode).toBe(200);
    echoBeforeGraphAnswers('178414000000401', '9002001', 'mid.echo.p3.takeover');
    const res = await sendMessage({ businessId: T.businessId, conversationId, text: 'Íñigo, en una hora es la llamada.', sender: { type: 'kai' }, purpose: 'reminder', metadata: { kind: 'reminder_1h' } });
    expect(res.delivered).toBe(true);
    const rows = await getDb().select().from(messages).where(eq(messages.externalId, 'mid.echo.p3.takeover'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderType: 'kai', content: 'Íñigo, en una hora es la llamada.' });
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.aiEnabled).toBe(false);
  }, 15_000);

  it('con un escalado abierto, el eco de un recordatorio de KAI no lo da por atendido', async () => {
    const { T, conversationId, leadId } = await igLead('178414000000402', '9002002');
    await triggerHandoff(T.businessId, conversationId, 'human_request');
    echoBeforeGraphAnswers('178414000000402', '9002002', 'mid.echo.p3.handoff');
    const res = await sendMessage({ businessId: T.businessId, conversationId, text: 'Íñigo, mañana es la llamada.', sender: { type: 'kai' }, purpose: 'reminder', metadata: { kind: 'reminder_24h' } });
    expect(res.delivered).toBe(true);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ handoffActive: true, handoffReason: 'human_request' });
    expect((await openAlerts(T.businessId, leadId)).map((a) => a.type)).toContain('handoff');
  }, 15_000);

  it('con KAI activo, el eco de su propio envío no lo pausa', async () => {
    const { T, conversationId } = await igLead('178414000000403', '9002003');
    echoBeforeGraphAnswers('178414000000403', '9002003', 'mid.echo.p3.active');
    const res = await sendMessage({ businessId: T.businessId, conversationId, text: '¡Hola! Soy el asistente virtual.', sender: { type: 'kai' }, purpose: 'reply' });
    expect(res.delivered).toBe(true);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.aiEnabled).toBe(true);
  }, 15_000);
});

// ───────────── 6) Mensajes recibidos con KAI en pausa ─────────────

describe('Al reactivar a KAI, los mensajes recibidos en pausa no desaparecen de «Pendientes»', () => {
  it('piloto automático: siguen pendientes hasta que alguien responda (o KAI tenga una respuesta en marcha)', async () => {
    const T = await registerTrainer(app);
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const l = await webLead(T, 'Tomás Pausa');
    await receiveInboundForConversation(T.businessId, l.conversationId, 'Hola, ¿cuánto cuesta?');
    expect((await inboxPending(T)).ids).toContain(l.conversationId);

    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: true })).statusCode).toBe(200);
    expect((await inboxPending(T)).ids).toContain(l.conversationId);
    expect(await needsHumanReply(T, l.conversationId)).toBe(true);

    // Con una respuesta de KAI programada (o en marcha), KAI se encarga: deja de estar pendiente.
    const job = await scheduleJob({ businessId: T.businessId, type: 'kai_reply', runAt: new Date(Date.now() + 60_000), payload: { conversationId: l.conversationId }, dedupeKey: `reply:${l.conversationId}` });
    expect((await inboxPending(T)).ids).not.toContain(l.conversationId);
    await getDb().update(scheduledJobs).set({ status: 'running' }).where(eq(scheduledJobs.id, job.id));
    expect((await inboxPending(T)).ids).not.toContain(l.conversationId);
    await getDb().update(scheduledJobs).set({ status: 'failed' }).where(eq(scheduledJobs.id, job.id));
    expect((await inboxPending(T)).ids).toContain(l.conversationId);
  });

  it('«Devolver a KAI» sin pedirle que responda: el mensaje sigue pendiente; «Que KAI responda ahora» lo deja en sus manos', async () => {
    const T = await registerTrainer(app);
    const l = await webLead(T, 'Ulises Devuelto');
    expect((await T.client.post(`/api/conversations/${l.conversationId}/take-over`)).statusCode).toBe(200);
    await receiveInboundForConversation(T.businessId, l.conversationId, '¿Y cuánto dura el programa?');
    expect((await inboxPending(T)).ids).toContain(l.conversationId);

    expect((await T.client.post(`/api/conversations/${l.conversationId}/release`, { replyNow: false })).statusCode).toBe(200);
    expect((await inboxPending(T)).ids).toContain(l.conversationId);
    expect(await needsHumanReply(T, l.conversationId)).toBe(true);

    expect((await T.client.post(`/api/conversations/${l.conversationId}/release`, { replyNow: true })).statusCode).toBe(200);
    expect((await inboxPending(T)).ids).not.toContain(l.conversationId);
  });

  it('con KAI activo, un mensaje que acaba de llegar no sale en «Pendientes» (KAI lo va a contestar)', async () => {
    const T = await registerTrainer(app);
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Hola, vi tu anuncio', profile: { whatsappId: '34600700802', phone: '+34600700802', name: 'Vicente Activo' } });
    if (r.duplicate) throw new Error('inesperado');
    expect((await inboxPending(T)).ids).not.toContain(r.conversation.id);
    expect(await needsHumanReply(T, r.conversation.id)).toBe(false);
  });
});

// ───────────── 7) Formulario público y datos de un lead existente ─────────────

describe('Formulario público: no se pueden cambiar los datos de contacto de un lead que ya existe', () => {
  let T: Trainer;
  let publicKey = '';
  const postForm = (payload: unknown) => new ApiClient(app).post(`/api/public/forms/${publicKey}`, payload, { csrf: false });

  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Formulario P3' });
    publicKey = json(await T.client.get('/api/integrations')).endpoints.publicKey;
    const wa = await T.client.post('/api/integrations/channels', {
      channel: 'whatsapp',
      externalAccountId: '106540352200301',
      accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
      skipVerification: true,
    });
    expect(wa.statusCode, wa.body).toBe(200);
  });

  it('con el email de otra persona no se le añade otro teléfono ni WhatsApp (y se avisa al entrenador)', async () => {
    const { lead: victim } = await createLead(T.businessId, { name: 'Ana Víctima', email: 'ana.victima@example.com', source: 'manual' }, { type: 'user', userId: T.userId });
    const res = await postForm({ email: 'ANA.victima@example.com', phone: '+34 699 000 111', contact_via_whatsapp: true });
    expect(res.statusCode).toBe(200);
    const [after] = await getDb().select().from(leads).where(eq(leads.id, victim.id));
    expect(after).toMatchObject({ phone: null, whatsappId: null, email: 'ana.victima@example.com' });
    const open = await openAlerts(T.businessId, victim.id);
    expect(open).toHaveLength(1);
    expect(open[0].body).toContain('+34699000111');

    // El número del formulario escribe por WhatsApp: es OTRO lead, sin nada de Ana.
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: '¿A qué hora era mi llamada?', profile: { whatsappId: '34699000111', phone: '+34699000111', name: 'Desconocido' } });
    if (r.duplicate) throw new Error('inesperado');
    expect(r.lead.id).not.toBe(victim.id);
  });

  it('a un lead con teléfono no se le pone el WhatsApp de otro número', async () => {
    const { lead: bea } = await createLead(T.businessId, { name: 'Bea', email: 'bea.p3@example.com', phone: '+34611222333', source: 'manual' }, { type: 'user', userId: T.userId });
    expect((await postForm({ email: 'bea.p3@example.com', phone: '+34 699 000 222', contact_via_whatsapp: true })).statusCode).toBe(200);
    const [after] = await getDb().select().from(leads).where(eq(leads.id, bea.id));
    expect(after).toMatchObject({ phone: '+34611222333', whatsappId: null });
  });

  it('si los datos coinciden con la ficha, no hay nada que avisar', async () => {
    const { lead } = await createLead(T.businessId, { name: 'Carla Coincide', email: 'carla.p3@example.com', phone: '+34611222444', source: 'manual' }, { type: 'user', userId: T.userId });
    expect((await postForm({ email: 'carla.p3@example.com', phone: '611 222 444' })).statusCode).toBe(200);
    expect(await openAlerts(T.businessId, lead.id)).toHaveLength(0);
  });

  it('los mensajes reales de WhatsApp sí completan la ficha (dato verificado por Meta)', async () => {
    const { lead } = await createLead(T.businessId, { name: 'Diego Directo', phone: '+34611222555', source: 'manual' }, { type: 'user', userId: T.userId });
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Hola', profile: { whatsappId: '34611222555', phone: '+34611222555', name: 'Diego' } });
    if (r.duplicate) throw new Error('inesperado');
    expect(r.lead.id).toBe(lead.id);
    const [after] = await getDb().select().from(leads).where(eq(leads.id, lead.id));
    expect(after.whatsappId).toBe('34611222555');
  });
});
