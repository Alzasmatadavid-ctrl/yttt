/**
 * Verificación final · agenda y automatizaciones (con base de datos PGlite y la app real):
 * - Calendario conectado que falla: aviso al entrenador, y se cierra solo cuando vuelve a funcionar.
 * - Calendly: solo se registra la llamada de KAI (no las sesiones u otros tipos de evento del entrenador).
 * - Activar los recordatorios (o el aviso post-llamada) también vale para las llamadas ya reservadas.
 * - Cancelar en KAI una llamada de Calendly la cancela también en Calendly (o avisa para hacerlo a mano).
 * - Llamada movida o borrada en Google Calendar: no se recuerda la hora antigua.
 * - Horas de descanso también al enviar seguimientos y mensajes de no-show.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, automations, businesses, calendarConnections, followUps, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { bookAppointment } from '../../src/calendar/calendar.service.js';
import { CALENDAR_DOWN_ALERT_TITLE, saveCalendarConnection } from '../../src/calendar/connections.js';
import { handleCalendlyEvent } from '../../src/webhooks/calendly.webhook.js';
import { scheduleJob } from '../../src/automation/jobs.js';
import { runJob } from '../../src/automation/worker.js';
import type { AutomationConfig, AutomationType } from '../../src/lib/domain.js';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const userActor = (t: Trainer) => ({ type: 'user' as const, userId: t.userId });

/** Lead real con su conversación (chat web, sin canal externo). */
async function newLead(t: Trainer, name: string, email?: string) {
  const res = await t.client.post('/api/leads', { name, ...(email ? { email } : {}) });
  expect(res.statusCode, res.body).toBe(200);
  const leadId = res.json().lead.id as string;
  const conv = await t.client.post(`/api/leads/${leadId}/start-test-conversation`);
  expect(conv.statusCode, conv.body).toBe(200);
  return { leadId, conversationId: conv.json().conversationId as string };
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

const jobsByKey = (dedupeKey: string) => getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, dedupeKey));
const pendingByKey = async (dedupeKey: string) => (await jobsByKey(dedupeKey)).filter((j) => j.status === 'pending');

async function setAutomation(businessId: string, type: AutomationType, patch: { enabled?: boolean; config?: AutomationConfig }) {
  await getDb()
    .update(automations)
    .set(patch)
    .where(and(eq(automations.businessId, businessId), eq(automations.type, type)));
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);

async function timezoneOf(businessId: string) {
  const [biz] = await getDb().select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return biz.timezone;
}

async function connectGoogle(t: Trainer) {
  await saveCalendarConnection(t.businessId, t.userId, {
    provider: 'google',
    credentials: { accessToken: 'token-de-prueba', refreshToken: 'refresh-de-prueba', expiresAt: Date.now() + 24 * 3600_000 },
    calendarId: 'primary',
  });
}

const CALENDLY_TOKEN = 'calendly-token-PRUEBA-0123456789abcdef';
const ET_LLAMADA = 'https://api.calendly.com/event_types/LLAMADA_VALORACION';
const ET_SESION = 'https://api.calendly.com/event_types/SESION_ENTRENO';

async function connectCalendly(t: Trainer, calendarId: string | null = ET_LLAMADA) {
  return saveCalendarConnection(t.businessId, t.userId, {
    provider: 'calendly',
    credentials: { token: CALENDLY_TOKEN, signingKey: 'clave-de-firma', webhookUri: 'https://api.calendly.com/webhook_subscriptions/W1' },
    calendarId,
    schedulingUrl: 'https://calendly.com/coach/llamada',
  });
}

// ───────────── 1. Calendario que no responde ─────────────

describe('calendario conectado que falla', () => {
  it('Google caído: aviso crítico (uno solo) que se cierra cuando vuelve a funcionar; también si falla al crear el evento', async () => {
    const G = await registerTrainer(app, { name: 'Gonzalo Google', businessName: 'Gonzalo Coach' });
    await openAgenda(G.client);
    await connectGoogle(G);
    let mode: 'down' | 'ok' | 'create_fails' = 'down';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        const method = init?.method ?? 'GET';
        if (mode === 'down') return jsonResponse(401, { error: { code: 401, message: 'Invalid Credentials' } });
        if (url.includes('/freeBusy')) return jsonResponse(200, { calendars: { primary: { busy: [] } } });
        if (method === 'POST' && url.includes('/events')) {
          return mode === 'create_fails' ? jsonResponse(500, { error: { message: 'Backend Error' } }) : jsonResponse(200, { id: 'ev_ok_1' });
        }
        return jsonResponse(404, { error: { message: 'no simulado' } });
      }),
    );

    const calendarAlerts = async () => (await openAlerts(G.businessId)).filter((a) => a.title === CALENDAR_DOWN_ALERT_TITLE);
    expect((await G.client.get('/api/agenda/slots')).statusCode).toBe(503);
    expect((await G.client.get('/api/agenda/slots')).statusCode).toBe(503);
    const down = await calendarAlerts();
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ type: 'integration_error', severity: 'critical', leadId: null, conversationId: null });
    expect(down[0].body).toContain('Google Calendar');
    expect(down[0].body).toContain('Integraciones');
    const [conn] = await getDb().select().from(calendarConnections).where(and(eq(calendarConnections.businessId, G.businessId), eq(calendarConnections.provider, 'google')));
    expect(conn.status).toBe('error');

    // Vuelve a responder: la conexión deja de estar en error y el aviso se cierra solo.
    mode = 'ok';
    expect((await G.client.get('/api/agenda/slots')).statusCode).toBe(200);
    const [healthy] = await getDb().select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(healthy).toMatchObject({ status: 'connected', lastError: null });
    expect(await calendarAlerts()).toHaveLength(0);

    // Falla al crear el evento de una reserva: también avisa (y el entrenador lo arregla reconectando).
    mode = 'create_fails';
    const l = await newLead(G, 'Pablo Ruiz');
    await expect(bookAppointment({ businessId: G.businessId, leadId: l.leadId, start: futureLocal(3, 10), bookedBy: 'human', actor: userActor(G) })).rejects.toMatchObject({ statusCode: 503 });
    expect(await calendarAlerts()).toHaveLength(1);
    await connectGoogle(G);
    expect(await calendarAlerts()).toHaveLength(0);
  });

  it('Calendly caído: el aviso nombra Calendly', async () => {
    const C = await registerTrainer(app, { businessName: 'Coach Calendly Caído' });
    await openAgenda(C.client);
    await connectCalendly(C);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { title: 'Unauthenticated', message: 'The access token is invalid' })));
    expect((await C.client.get('/api/agenda/slots')).statusCode).toBe(503);
    const down = (await openAlerts(C.businessId)).filter((a) => a.title === CALENDAR_DOWN_ALERT_TITLE);
    expect(down).toHaveLength(1);
    expect(down[0].body).toContain('Calendly');
  });
});

// ───────────── 2. Calendly: otros tipos de evento ─────────────

describe('webhook de Calendly con varios tipos de evento', () => {
  const event = (input: { uri: string; eventType?: string; email: string; name: string; tracking?: { utm_source?: string; utm_content?: string } }) => {
    const start = DateTime.now().plus({ days: 3 }).startOf('hour');
    return {
      event: 'invitee.created',
      payload: {
        uri: `${input.uri}/invitees/I1`,
        email: input.email,
        name: input.name,
        tracking: input.tracking ?? {},
        scheduled_event: {
          uri: input.uri,
          ...(input.eventType ? { event_type: input.eventType } : {}),
          start_time: start.toISO()!,
          end_time: start.plus({ minutes: 30 }).toISO()!,
        },
      },
    };
  };

  it('una sesión de otro tipo de evento se ignora: ni cita, ni lead nuevo, ni cambio de etapa', async () => {
    const C = await registerTrainer(app, { businessName: 'Coach Varios Eventos' });
    const conn = await connectCalendly(C);
    const sara = await newLead(C, 'Sara Cliente', 'sara.cliente@example.com');
    const leadsBefore = await getDb().select().from(leads).where(eq(leads.businessId, C.businessId));

    const session = await handleCalendlyEvent(C.businessId, conn.id, event({ uri: 'https://api.calendly.com/scheduled_events/SES1', eventType: ET_SESION, email: 'sara.cliente@example.com', name: 'Sara Cliente' }));
    expect(session).toEqual({ ignored: true, reason: 'other_event_type' });
    const other = await handleCalendlyEvent(C.businessId, conn.id, event({ uri: 'https://api.calendly.com/scheduled_events/SES2', eventType: ET_SESION, email: 'nuevo.alumno@example.com', name: 'Alumno Nuevo' }));
    expect(other).toMatchObject({ ignored: true });
    expect(await getDb().select().from(appointments).where(eq(appointments.businessId, C.businessId))).toHaveLength(0);
    expect(await getDb().select().from(leads).where(eq(leads.businessId, C.businessId))).toHaveLength(leadsBefore.length);
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, sara.leadId));
    expect(lead.status).not.toBe('call_booked');

    // La llamada de valoración (el tipo de evento elegido) sí se registra.
    const call = await handleCalendlyEvent(C.businessId, conn.id, event({ uri: 'https://api.calendly.com/scheduled_events/CALL1', eventType: ET_LLAMADA, email: 'otra.persona@example.com', name: 'Otra Persona' }));
    expect(call).toMatchObject({ booked: true });

    // Reservada desde un enlace de KAI aunque el tipo de evento ya no sea el elegido (el entrenador lo cambió después).
    const fromKai = await handleCalendlyEvent(
      C.businessId,
      conn.id,
      event({ uri: 'https://api.calendly.com/scheduled_events/CALL2', eventType: ET_SESION, email: 'sara.cliente@example.com', name: 'Sara Cliente', tracking: { utm_source: 'kai', utm_content: sara.leadId } }),
    );
    expect(fromKai).toMatchObject({ booked: true });
    const [booked] = await getDb().select().from(appointments).where(eq(appointments.id, (fromKai as { appointmentId: string }).appointmentId));
    expect(booked.leadId).toBe(sara.leadId);
  });
});

// ───────────── 3. Activar recordatorios después de reservar ─────────────

describe('recordatorios activados después de reservar', () => {
  it('las llamadas ya agendadas reciben el recordatorio y el aviso de resultado al reactivarlos', async () => {
    const R = await registerTrainer(app, { name: 'Rosa Recordatorios', businessName: 'Rosa Fit' });
    await openAgenda(R.client);
    const [reminders] = await getDb().select().from(automations).where(and(eq(automations.businessId, R.businessId), eq(automations.type, 'appointment_reminders')));
    const [post] = await getDb().select().from(automations).where(and(eq(automations.businessId, R.businessId), eq(automations.type, 'post_call')));
    const put = (type: AutomationType, enabled: boolean, config: AutomationConfig) => R.client.put(`/api/settings/automations/${type}`, { enabled, config });
    expect((await put('appointment_reminders', false, reminders.config)).statusCode).toBe(200);
    expect((await put('post_call', false, post.config)).statusCode).toBe(200);

    const l = await newLead(R, 'Marta Reserva');
    const appt = await bookAppointment({ businessId: R.businessId, leadId: l.leadId, conversationId: l.conversationId, start: futureLocal(3, 10), bookedBy: 'human', actor: userActor(R) });
    // Desactivados: no se manda la confirmación, pero los recordatorios y el aviso quedan programados.
    expect(await jobsByKey(`appt:${appt.id}:confirm`)).toHaveLength(0);
    for (const kind of ['r24', 'r1', 'post']) expect(await pendingByKey(`appt:${appt.id}:${kind}`)).toHaveLength(1);

    // Si se ejecutan mientras siguen desactivados, no se envía nada.
    const [r1] = await pendingByKey(`appt:${appt.id}:r1`);
    expect((await runJobNow(r1.id)).status).toBe('done');
    expect((await outbound(l.conversationId)).filter((m) => m.metadata.kind === 'reminder_1h')).toHaveLength(0);

    // El entrenador los activa: el recordatorio de 24 h y el aviso post-llamada de esa llamada ya salen.
    expect((await put('appointment_reminders', true, reminders.config)).statusCode).toBe(200);
    expect((await put('post_call', true, post.config)).statusCode).toBe(200);
    const [r24] = await pendingByKey(`appt:${appt.id}:r24`);
    expect((await runJobNow(r24.id)).status).toBe('done');
    expect((await outbound(l.conversationId)).filter((m) => m.metadata.kind === 'reminder_24h')).toHaveLength(1);
    const [postJob] = await pendingByKey(`appt:${appt.id}:post`);
    expect((await runJobNow(postJob.id)).status).toBe('done');
    const outcome = (await openAlerts(R.businessId)).filter((a) => a.type === 'call_outcome' && a.appointmentId === appt.id);
    expect(outcome).toHaveLength(1);
  });
});

// ───────────── 4. Cancelar una llamada de Calendly ─────────────

describe('cancelar una llamada reservada por Calendly', () => {
  async function calendlyAppointment(t: Trainer, connectionId: string, eventUri: string) {
    const l = await newLead(t, 'Carla Calendly');
    const startsAt = futureLocal(4, 11);
    const [appt] = await getDb()
      .insert(appointments)
      .values({
        businessId: t.businessId,
        leadId: l.leadId,
        conversationId: l.conversationId,
        title: 'Llamada de valoración · Carla Calendly',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        calendarProvider: 'calendly',
        calendarConnectionId: connectionId,
        externalEventId: eventUri,
        bookedBy: 'lead',
      })
      .returning();
    return appt;
  }

  it('se cancela también en Calendly; si Calendly falla, se avisa al entrenador para que lo haga él', async () => {
    const C = await registerTrainer(app, { businessName: 'Coach Cancela Calendly' });
    const conn = await connectCalendly(C);
    const calls: { method: string; url: string; auth: string | null }[] = [];
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ method: init?.method ?? 'GET', url, auth: new Headers(init?.headers).get('authorization') });
        if (fail) return jsonResponse(403, { title: 'Permission Denied', message: 'No puedes cancelar este evento' });
        return jsonResponse(201, { resource: { canceled_by: 'Coach', reason: null } });
      }),
    );

    const ok = await calendlyAppointment(C, conn.id, 'https://api.calendly.com/scheduled_events/EV1');
    const res = await C.client.post(`/api/agenda/appointments/${ok.id}/cancel`, { reason: 'Cancelada por el equipo' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().appointment.status).toBe('cancelled');
    expect(calls).toEqual([{ method: 'POST', url: 'https://api.calendly.com/scheduled_events/EV1/cancellation', auth: `Bearer ${CALENDLY_TOKEN}` }]);
    expect((await openAlerts(C.businessId)).filter((a) => a.appointmentId === ok.id)).toHaveLength(0);

    fail = true;
    const ko = await calendlyAppointment(C, conn.id, 'https://api.calendly.com/scheduled_events/EV2');
    const res2 = await C.client.post(`/api/agenda/appointments/${ko.id}/cancel`, { reason: '' });
    expect(res2.statusCode, res2.body).toBe(200);
    expect(res2.json().appointment.status).toBe('cancelled');
    const manual = (await openAlerts(C.businessId)).filter((a) => a.appointmentId === ko.id);
    expect(manual).toHaveLength(1);
    expect(manual[0].title).toBe('Cancela también la llamada en Calendly');
    expect(manual[0].body).toContain('Carla Calendly');

    // Una URI que no es de la API de Calendly no recibe el token del entrenador.
    calls.length = 0;
    fail = false;
    const weird = await calendlyAppointment(C, conn.id, 'https://example.com/scheduled_events/EV3');
    expect((await C.client.post(`/api/agenda/appointments/${weird.id}/cancel`, {})).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await openAlerts(C.businessId)).filter((a) => a.appointmentId === weird.id)).toHaveLength(1);
  });
});

// ───────────── 5. Llamada movida o borrada en Google Calendar ─────────────

describe('cambios hechos en Google Calendar', () => {
  let G: Trainer;
  let eventCounter = 0;
  const calls: { method: string; url: string }[] = [];
  /** Lo que devuelve Google al leer cada evento: 'deleted' (404), 'down' (500) o la hora que tiene ahora. */
  const remote = new Map<string, 'deleted' | 'down' | { start: Date; end: Date }>();

  beforeAll(async () => {
    G = await registerTrainer(app, { name: 'Gema Google', businessName: 'Gema Coach' });
    await openAgenda(G.client);
    await connectGoogle(G);
    await setAutomation(G.businessId, 'appointment_reminders', { enabled: true, config: { confirmation: true, reminder24h: true, reminder1h: true } });
  });

  function stubGoogle() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        if (url.includes('/freeBusy')) return jsonResponse(200, { calendars: { primary: { busy: [] } } });
        if (method === 'POST' && url.includes('/events')) {
          const body = JSON.parse(String(init?.body)) as { start: { dateTime: string }; end: { dateTime: string } };
          const id = `ev_sync_${++eventCounter}`;
          remote.set(id, { start: new Date(body.start.dateTime), end: new Date(body.end.dateTime) });
          return jsonResponse(200, { id });
        }
        const id = decodeURIComponent(url.split('/events/')[1]?.split('?')[0] ?? '');
        if (method === 'GET' && remote.has(id)) {
          const state = remote.get(id)!;
          if (state === 'deleted') return jsonResponse(404, { error: { message: 'Not Found' } });
          if (state === 'down') return jsonResponse(500, { error: { message: 'Backend Error' } });
          return jsonResponse(200, { id, status: 'confirmed', start: { dateTime: state.start.toISOString() }, end: { dateTime: state.end.toISOString() } });
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse(404, { error: { message: 'no simulado' } });
      }),
    );
  }

  let booked = 0;
  async function bookWithGoogle(name: string) {
    const l = await newLead(G, name);
    // Cada llamada en un día distinto (sin solaparse con las demás).
    const start = futureLocal(3 + booked++, 10);
    const appt = await bookAppointment({ businessId: G.businessId, leadId: l.leadId, conversationId: l.conversationId, start, bookedBy: 'human', actor: userActor(G), confirmationAlreadySent: true });
    expect(appt.externalEventId).toMatch(/^ev_sync_/);
    const [r24] = await pendingByKey(`appt:${appt.id}:r24`);
    return { ...l, appt, r24 };
  }

  it('sin cambios (o con Google caído): el recordatorio sale con la hora de KAI', async () => {
    stubGoogle();
    const a = await bookWithGoogle('Andrés Igual');
    expect((await runJobNow(a.r24.id)).status).toBe('done');
    expect((await outbound(a.conversationId)).filter((m) => m.metadata.kind === 'reminder_24h')).toHaveLength(1);

    const b = await bookWithGoogle('Berta Caída');
    remote.set(b.appt.externalEventId!, 'down');
    expect((await runJobNow(b.r24.id)).status).toBe('done');
    expect((await outbound(b.conversationId)).filter((m) => m.metadata.kind === 'reminder_24h')).toHaveLength(1);
  });

  it('borrada en Google: se cancela también en KAI, no se envía el recordatorio y se avisa al entrenador', async () => {
    stubGoogle();
    const d = await bookWithGoogle('Diego Borrado');
    remote.set(d.appt.externalEventId!, 'deleted');
    calls.length = 0;
    expect((await runJobNow(d.r24.id)).status).toBe('done');
    expect(await outbound(d.conversationId)).toHaveLength(0);
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, d.appt.id));
    expect(row.status).toBe('cancelled');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0); // ya no estaba en Google
    expect(await pendingByKey(`appt:${d.appt.id}:r1`)).toHaveLength(0);
    expect(await pendingByKey(`appt:${d.appt.id}:post`)).toHaveLength(0);
    const alert = (await openAlerts(G.businessId)).filter((a) => a.appointmentId === d.appt.id);
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({ title: 'Llamada borrada en tu Google Calendar', leadId: d.leadId });
  });

  it('movida en Google: se actualiza la hora, no sale el recordatorio antiguo y se reprograman con la nueva', async () => {
    stubGoogle();
    const m = await bookWithGoogle('Marina Movida');
    const newStart = new Date(m.appt.startsAt.getTime() + 2 * 86_400_000 + 3 * 3600_000);
    remote.set(m.appt.externalEventId!, { start: newStart, end: new Date(newStart.getTime() + 30 * 60_000) });
    expect((await runJobNow(m.r24.id)).status).toBe('done');
    expect(await outbound(m.conversationId)).toHaveLength(0);
    const [row] = await getDb().select().from(appointments).where(eq(appointments.id, m.appt.id));
    expect(row.status).toBe('scheduled');
    expect(row.startsAt.getTime()).toBe(newStart.getTime());
    expect(row.endsAt.getTime()).toBe(newStart.getTime() + 30 * 60_000);
    const [r1] = await pendingByKey(`appt:${m.appt.id}:r1`);
    expect(r1.runAt.getTime()).toBe(newStart.getTime() - 3600_000);
    const [r24] = await pendingByKey(`appt:${m.appt.id}:r24`);
    expect(r24.runAt.getTime()).toBeGreaterThan(m.r24.runAt.getTime());
    const [post] = await pendingByKey(`appt:${m.appt.id}:post`);
    expect(post.runAt.getTime()).toBeGreaterThan(newStart.getTime());
    const alert = (await openAlerts(G.businessId)).filter((a) => a.appointmentId === m.appt.id);
    expect(alert).toHaveLength(1);
    expect(alert[0].title).toBe('Llamada movida en tu Google Calendar');

    // El recordatorio nuevo ya sale con la hora nueva.
    expect((await runJobNow(r1.id)).status).toBe('done');
    const sent = (await outbound(m.conversationId)).filter((x) => x.metadata.kind === 'reminder_1h');
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain(DateTime.fromJSDate(newStart).setZone(await timezoneOf(G.businessId)).toFormat('HH:mm'));
  });
});

// ───────────── 6. Horas de descanso al enviar ─────────────

describe('horas de descanso al ejecutar el trabajo', () => {
  /** Horario de descanso que incluye «ahora» (o que empieza dentro de un rato si `covering` es false). */
  function quietAroundNow(tz: string, covering = true) {
    const now = DateTime.now().setZone(tz);
    return covering
      ? { start: now.minus({ minutes: 60 }).toFormat('HH:mm'), end: now.plus({ minutes: 120 }).toFormat('HH:mm') }
      : { start: now.plus({ minutes: 120 }).toFormat('HH:mm'), end: now.plus({ minutes: 180 }).toFormat('HH:mm') };
  }

  it('un seguimiento que se ejecuta de madrugada se pasa al final del descanso sin enviarse', async () => {
    const Q = await registerTrainer(app, { name: 'Quique Quieto', businessName: 'Quique Coach' });
    const tz = await timezoneOf(Q.businessId);
    const quietHours = quietAroundNow(tz);
    const [fuAuto] = await getDb().select().from(automations).where(and(eq(automations.businessId, Q.businessId), eq(automations.type, 'followup_no_reply')));
    await setAutomation(Q.businessId, 'followup_no_reply', { enabled: true, config: { ...fuAuto.config, quietHours } });
    const l = await newLead(Q, 'Nacho Nocturno');
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: Q.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date() })
      .returning();
    const job = await scheduleJob({ businessId: Q.businessId, type: 'followup', runAt: new Date(), payload: { followUpId: fu.id, leadId: l.leadId }, dedupeKey: `followup:${fu.id}` });
    await getDb().update(followUps).set({ jobId: job.id }).where(eq(followUps.id, fu.id));

    expect((await runJobNow(job.id)).status).toBe('done');
    expect(await outbound(l.conversationId)).toHaveLength(0);
    const [next] = await pendingByKey(`followup:${fu.id}`);
    expect(next.id).not.toBe(job.id);
    expect(next.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(DateTime.fromJSDate(next.runAt).setZone(tz).toFormat('HH:mm')).toBe(quietHours.end);
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after).toMatchObject({ status: 'scheduled', jobId: next.id });
    expect(after.scheduledFor.getTime()).toBe(next.runAt.getTime());
  });

  it('el mensaje de no-show también espera al final del descanso (y fuera de él, se envía)', async () => {
    const Q = await registerTrainer(app, { name: 'Nuria Noche', businessName: 'Nuria Coach' });
    const tz = await timezoneOf(Q.businessId);

    async function noShowJob(name: string) {
      const l = await newLead(Q, name);
      const startsAt = new Date(Date.now() - 2 * 3600_000);
      const [appt] = await getDb()
        .insert(appointments)
        .values({ businessId: Q.businessId, leadId: l.leadId, conversationId: l.conversationId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'no_show', bookedBy: 'human' })
        .returning();
      const job = await scheduleJob({ businessId: Q.businessId, type: 'no_show_message', runAt: new Date(), payload: { appointmentId: appt.id, leadId: l.leadId }, dedupeKey: `appt:${appt.id}:noshow` });
      return { ...l, appt, job };
    }

    const quietHours = quietAroundNow(tz);
    await setAutomation(Q.businessId, 'no_show_recovery', { enabled: true, config: { delayMinutes: 15, quietHours } });
    const night = await noShowJob('Iván Insomne');
    expect((await runJobNow(night.job.id)).status).toBe('done');
    expect(await outbound(night.conversationId)).toHaveLength(0);
    const [next] = await pendingByKey(`appt:${night.appt.id}:noshow`);
    expect(DateTime.fromJSDate(next.runAt).setZone(tz).toFormat('HH:mm')).toBe(quietHours.end);
    expect(next.runAt.getTime()).toBeGreaterThan(Date.now());

    await setAutomation(Q.businessId, 'no_show_recovery', { enabled: true, config: { delayMinutes: 15, quietHours: quietAroundNow(tz, false) } });
    const day = await noShowJob('Diana Diurna');
    expect((await runJobNow(day.job.id)).status).toBe('done');
    expect((await outbound(day.conversationId)).filter((m) => m.metadata.kind === 'no_show')).toHaveLength(1);
  });
});
