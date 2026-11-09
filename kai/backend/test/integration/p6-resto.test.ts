/**
 * Revisión de regresiones de la ronda 3 — grupo «resto» (con base de datos PGlite y la app real):
 * - Volver a conectar Google con otra cuenta no cancela las llamadas ya agendadas (un 404 no es un borrado).
 * - Un envío que se corta a medias (reinicio, despliegue…) no se queda «en cola» para siempre.
 * - Un seguimiento colocado justo antes del descanso que se ejecuta con un poco de retraso no se pierde.
 * - Un lead dado de baja que vuelve con «Buenas tardes» avisa al entrenador.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, automations, businesses, conversations, followUps, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { bookAppointment } from '../../src/calendar/calendar.service.js';
import { saveCalendarConnection } from '../../src/calendar/connections.js';
import { receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { scheduleJob } from '../../src/automation/jobs.js';
import { runDueJobs, runJob } from '../../src/automation/worker.js';
import type { AutomationConfig } from '../../src/lib/domain.js';
import { futureLocal, json, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ───────────── Utilidades ─────────────

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);

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

const outbound = (conversationId: string) =>
  getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));

const openAlerts = (businessId: string) =>
  getDb()
    .select()
    .from(alerts)
    .where(and(eq(alerts.businessId, businessId), eq(alerts.status, 'open')));

type InboxItem = { conversation: { id: string } };
async function inboxPending(T: Trainer) {
  const body = json(await T.client.get('/api/inbox', { query: { filter: 'pending', limit: '200' } }));
  return (body.items as InboxItem[]).map((i) => i.conversation.id);
}

async function timezoneOf(businessId: string) {
  const [biz] = await getDb().select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return biz.timezone;
}

async function setAutomation(businessId: string, type: 'appointment_reminders' | 'followup_no_reply', patch: { enabled?: boolean; config?: AutomationConfig }) {
  await getDb()
    .update(automations)
    .set(patch)
    .where(and(eq(automations.businessId, businessId), eq(automations.type, type)));
}

// ───────────── 1. Google Calendar conectado con otra cuenta ─────────────

describe('Google Calendar: volver a conectar con otra cuenta', () => {
  it('las llamadas ya agendadas (cuyo evento sigue en la cuenta anterior) no se cancelan y los recordatorios salen', async () => {
    const G = await registerTrainer(app, { name: 'Germán Google', businessName: 'Germán Coach' });
    await openAgenda(G.client);
    await setAutomation(G.businessId, 'appointment_reminders', { enabled: true, config: { confirmation: true, reminder24h: true, reminder1h: true } });
    await saveCalendarConnection(G.businessId, G.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-cuenta-A', refreshToken: 'refresh-A', expiresAt: Date.now() + 24 * 3600_000 },
      accountEmail: 'personal@gmail.com',
      calendarId: 'primary',
    });

    // Cada cuenta de Google solo ve sus propios eventos (por el token con el que se pide).
    const eventsByToken = new Map<string, Map<string, 'confirmed' | 'cancelled' | 'gone'>>();
    let counter = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        const method = init?.method ?? 'GET';
        const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '');
        const events = eventsByToken.get(token) ?? new Map();
        eventsByToken.set(token, events);
        if (url.includes('/freeBusy')) return jsonResponse(200, { calendars: { primary: { busy: [] } } });
        if (method === 'POST' && url.includes('/events')) {
          const id = `ev_cuenta_${++counter}`;
          events.set(id, 'confirmed');
          return jsonResponse(200, { id });
        }
        const id = decodeURIComponent(url.split('/events/')[1]?.split('?')[0] ?? '');
        const state = events.get(id);
        if (method === 'GET' && state === 'confirmed') return jsonResponse(200, { id, status: 'confirmed' });
        if (method === 'GET' && state === 'cancelled') return jsonResponse(200, { id, status: 'cancelled' });
        if (method === 'GET' && state === 'gone') return jsonResponse(410, { error: { message: 'Resource has been deleted' } });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse(404, { error: { message: 'Not Found' } });
      }),
    );

    async function book(name: string, daysAhead: number) {
      const lead = json(await G.client.post('/api/leads', { name })).lead as { id: string };
      const conv = json(await G.client.post(`/api/leads/${lead.id}/start-test-conversation`)) as { conversationId: string };
      const appt = await bookAppointment({
        businessId: G.businessId,
        leadId: lead.id,
        conversationId: conv.conversationId,
        start: futureLocal(daysAhead, 10),
        bookedBy: 'human',
        actor: { type: 'user', userId: G.userId },
        confirmationAlreadySent: true,
      });
      expect(appt.externalEventId).toMatch(/^ev_cuenta_/);
      const [r24] = await getDb()
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.dedupeKey, `appt:${appt.id}:r24`), eq(scheduledJobs.status, 'pending')));
      return { appt, r24, conversationId: conv.conversationId, leadId: lead.id };
    }

    const a = await book('Álvaro Antes', 3);
    // El entrenador pulsa «Volver a conectar» y elige otra cuenta de Google (misma fila de conexión).
    await saveCalendarConnection(G.businessId, G.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-cuenta-B', refreshToken: 'refresh-B', expiresAt: Date.now() + 24 * 3600_000 },
      accountEmail: 'trabajo@empresa.com',
      calendarId: 'primary',
    });

    expect((await runJobNow(a.r24.id)).status).toBe('done');
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, a.appt.id));
    expect(row.status).toBe('scheduled');
    expect((await outbound(a.conversationId)).filter((m) => m.metadata.kind === 'reminder_24h')).toHaveLength(1);
    expect((await openAlerts(G.businessId)).filter((x) => x.title === 'Llamada borrada en tu Google Calendar')).toHaveLength(0);
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, a.leadId));
    expect(lead.status).not.toBe('follow_up');

    // Borrada de verdad en la cuenta conectada (Google la devuelve «cancelled», o 410 si ya no la guarda): se cancela.
    for (const [i, state] of (['cancelled', 'gone'] as const).entries()) {
      const b = await book(`Beatriz Borrada ${i}`, 4 + i);
      eventsByToken.get('token-cuenta-B')!.set(b.appt.externalEventId!, state);
      expect((await runJobNow(b.r24.id)).status).toBe('done');
      const [cancelled] = await getDb().select().from(appointments).where(eq(appointments.id, b.appt.id));
      expect(cancelled.status).toBe('cancelled');
      expect(await outbound(b.conversationId)).toHaveLength(0);
      expect((await openAlerts(G.businessId)).filter((x) => x.appointmentId === b.appt.id).map((x) => x.title)).toEqual(['Llamada borrada en tu Google Calendar']);
    }
  });
});

// ───────────── 2. Envío cortado por un reinicio ─────────────

describe('Envío interrumpido (el proceso se para mientras se llama al canal)', () => {
  it('la respuesta que se quedó «en cola» pasa a «no enviado» y la conversación vuelve a «Pendientes»', async () => {
    const T = await registerTrainer(app);
    const profile = { whatsappId: '34600706001', phone: '+34600706001', name: 'Rubén Reinicio' };
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: '¿Cuánto cuesta el plan online?', profile });
    if (r.duplicate) throw new Error('inesperado');
    const db = getDb();
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    // El entrenador lleva la conversación (KAI en pausa) y su respuesta se cortó a medias hace 5 minutos.
    await db.update(conversations).set({ aiEnabled: false, lastInboundAt: tenMinAgo }).where(eq(conversations.id, r.conversation.id));
    await db.update(messages).set({ createdAt: tenMinAgo }).where(eq(messages.conversationId, r.conversation.id));
    const [stuck] = await db
      .insert(messages)
      .values({
        businessId: T.businessId,
        conversationId: r.conversation.id,
        leadId: r.lead.id,
        direction: 'outbound',
        senderType: 'human',
        content: 'Son 79 € al mes',
        status: 'queued',
        metadata: { purpose: 'manual' },
        createdAt: new Date(Date.now() - 5 * 60_000),
      })
      .returning();
    // Otro envío que sigue en marcha ahora mismo (hace unos segundos): no se toca.
    const other = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Hola', profile: { whatsappId: '34600706002', name: 'Elena Enviando' } });
    if (other.duplicate) throw new Error('inesperado');
    const [inFlight] = await db
      .insert(messages)
      .values({
        businessId: T.businessId,
        conversationId: other.conversation.id,
        leadId: other.lead.id,
        direction: 'outbound',
        senderType: 'kai',
        content: '¡Hola, Elena!',
        status: 'queued',
        metadata: { purpose: 'reply' },
        createdAt: new Date(Date.now() - 10_000),
      })
      .returning();

    // Mientras sigue «en cola» cuenta como contestada: no sale en «Pendientes».
    expect(await inboxPending(T)).not.toContain(r.conversation.id);

    await runDueJobs(0, { forceHousekeeping: true });

    const [after] = await db.select().from(messages).where(eq(messages.id, stuck.id));
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/Envío interrumpido/);
    expect((await db.select().from(messages).where(eq(messages.id, inFlight.id)))[0].status).toBe('queued');
    expect(await inboxPending(T)).toContain(r.conversation.id);
  });
});

// ───────────── 3. Seguimiento colocado justo antes del descanso ─────────────

describe('Seguimiento de Instagram colocado justo antes del descanso', () => {
  /** Lead de Instagram cuyo último mensaje fue hace 23 h 10 min (la ventana de 24 h se cierra dentro de 50 min). */
  async function igLeadNearWindowEnd(T: Trainer, igAccount: string, igsid: string) {
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
      externalMessageId: `mid.p6.in.${igsid}`,
      text: 'Hola, quiero perder grasa',
      profile: { instagramUserId: igsid, name: 'Iván Insta' },
    });
    if (r.duplicate) throw new Error('inesperado');
    const lastInbound = new Date(Date.now() - (23 * 60 + 10) * 60_000);
    const db = getDb();
    await db.update(conversations).set({ lastInboundAt: lastInbound }).where(eq(conversations.id, r.conversation.id));
    await db.update(leads).set({ lastInboundAt: lastInbound }).where(eq(leads.id, r.lead.id));
    await db.update(messages).set({ createdAt: lastInbound }).where(eq(messages.conversationId, r.conversation.id));
    // La respuesta de KAI al mensaje ya no hace falta en esta prueba.
    await db.update(scheduledJobs).set({ status: 'cancelled' }).where(eq(scheduledJobs.dedupeKey, `reply:${r.conversation.id}`));
    return { leadId: r.lead.id, conversationId: r.conversation.id };
  }

  /** Descanso que empezó hace `minutesAgo` minutos y acaba dentro de 3 h. */
  async function quietStartedAgo(T: Trainer, minutesAgo: number) {
    const tz = await timezoneOf(T.businessId);
    const now = DateTime.now().setZone(tz);
    const quietHours = { start: now.minus({ minutes: minutesAgo }).toFormat('HH:mm'), end: now.plus({ hours: 3 }).toFormat('HH:mm') };
    const [auto] = await getDb()
      .select()
      .from(automations)
      .where(and(eq(automations.businessId, T.businessId), eq(automations.type, 'followup_no_reply')));
    await setAutomation(T.businessId, 'followup_no_reply', { enabled: true, config: { ...auto.config, quietHours } });
  }

  async function followUpJob(T: Trainer, l: { leadId: string; conversationId: string }) {
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date() })
      .returning();
    const job = await scheduleJob({ businessId: T.businessId, type: 'followup', runAt: new Date(), payload: { followUpId: fu.id, leadId: l.leadId }, dedupeKey: `followup:${fu.id}` });
    await getDb().update(followUps).set({ jobId: job.id }).where(eq(followUps.id, fu.id));
    return { fu, job };
  }

  function mockInstagramSend() {
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'graph.instagram.com' && url.hostname !== 'graph.facebook.com') throw new Error(`Red no permitida en tests: ${url}`);
      sent.push(String(url));
      return new Response(JSON.stringify({ recipient_id: 'x', message_id: `mid.p6.out.${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return sent;
  }

  it('con unos minutos de retraso (el descanso acaba de empezar) sale ya en vez de aplazarse y perderse', async () => {
    const T = await registerTrainer(app);
    const l = await igLeadNearWindowEnd(T, '178414000000601', '9006001');
    await quietStartedAgo(T, 5);
    const sent = mockInstagramSend();
    const { fu, job } = await followUpJob(T, l);

    expect((await runJobNow(job.id)).status).toBe('done');
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after.status, after.note ?? '').toBe('sent');
    expect(sent.length).toBeGreaterThan(0);
    expect((await outbound(l.conversationId)).filter((m) => m.metadata.followUpId === fu.id && m.status === 'sent')).toHaveLength(1);
  });

  it('si el descanso empezó hace rato, no se aplaza a cuando la ventana ya esté cerrada: se marca como no enviado con el motivo', async () => {
    const T = await registerTrainer(app);
    const l = await igLeadNearWindowEnd(T, '178414000000602', '9006002');
    await quietStartedAgo(T, 60);
    mockInstagramSend();
    const { fu, job } = await followUpJob(T, l);

    expect((await runJobNow(job.id)).status).toBe('done');
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after.status).toBe('skipped');
    expect(after.note).toMatch(/ventana de 24 h/);
    expect(await outbound(l.conversationId)).toHaveLength(0);
    const pending = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `followup:${fu.id}`), eq(scheduledJobs.status, 'pending')));
    expect(pending).toHaveLength(0);
  });
});

// ───────────── 4. Lead dado de baja que vuelve a saludar ─────────────

describe('Lead dado de baja que vuelve semanas después con un saludo', () => {
  it('«Buenas tardes» avisa al entrenador y sale en «Pendientes» (como un «Hola»)', async () => {
    const T = await registerTrainer(app);
    const profile = { whatsappId: '34600706401', phone: '+34600706401', name: 'Sergio Saludo' };
    const first = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Dadme de baja, por favor', profile });
    if (first.duplicate) throw new Error('inesperado');
    expect((await T.client.post(`/api/leads/${first.lead.id}/opt-out`, { optedOut: true })).statusCode).toBe(200);
    // «Gracias» a la despedida: cortesía, nada que atender.
    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Gracias, buenas noches', profile });
    expect(await inboxPending(T)).not.toContain(first.conversation.id);

    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', text: 'Buenas tardes', profile });
    expect(await inboxPending(T)).toContain(first.conversation.id);
    const alertsNow = (await openAlerts(T.businessId)).filter((a) => a.leadId === first.lead.id && a.type === 'client_message');
    expect(alertsNow.map((a) => a.title)).toEqual(['Un lead dado de baja te ha vuelto a escribir']);
  });
});
