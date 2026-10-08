/**
 * Revisión nº 1 · agenda, automatizaciones y Copilot (con base de datos PGlite y la app real):
 * - Reservas simultáneas del mismo hueco y reprogramaciones que fallan sin perder la cita original.
 * - Google Calendar: el evento nuevo se crea antes de borrar el viejo; el simulador no toca el calendario real.
 * - La conversación de una cita tiene que ser del mismo lead.
 * - No-show respetando el horario de silencio.
 * - Worker: cuenta suspendida, recordatorios a destiempo, textos personalizados y trabajos huérfanos.
 * - Copilot: acciones incompletas, texto completo en la confirmación, doble confirmación y acciones caducadas.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../../src/database/client.js';
import { alerts, appointments, automations, businesses, conversations, followUps, leadEvents, leads, messages, pendingActions, scheduledJobs } from '../../src/database/schema.js';
import { bookAppointment, releaseLeadAppointments, rescheduleAppointment, setAppointmentOutcome } from '../../src/calendar/calendar.service.js';
import { saveCalendarConnection } from '../../src/calendar/connections.js';
import { releaseStaleJobs, scheduleJob } from '../../src/automation/jobs.js';
import { scheduleNoReplyFollowUp } from '../../src/automation/followups.js';
import { runDueJobs } from '../../src/automation/worker.js';
import { cancelPendingAction, confirmPendingAction, createPendingAction, listPendingActions } from '../../src/ai/copilot/copilot-actions.js';
import type { TenantContext } from '../../src/auth/guards.js';
import { ROLE_PERMISSIONS, type AutomationConfig, type AutomationType } from '../../src/lib/domain.js';
import { AppError } from '../../src/lib/errors.js';
import { futureLocal, openAgenda, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const TZ = 'Europe/Madrid';

let app: FastifyInstance;
let T: Trainer;

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { name: 'Laura Gómez', businessName: 'Laura Fit' });
  await openAgenda(T.client);
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const userActor = (t: Trainer) => ({ type: 'user' as const, userId: t.userId });

/** Lead real con su conversación (chat web, sin canal externo). */
async function newLead(t: Trainer, name: string) {
  const res = await t.client.post('/api/leads', { name });
  expect(res.statusCode, res.body).toBe(200);
  const leadId = res.json().lead.id as string;
  const conv = await t.client.post(`/api/leads/${leadId}/start-test-conversation`);
  expect(conv.statusCode, conv.body).toBe(200);
  return { leadId, conversationId: conv.json().conversationId as string };
}

/** Lead de prueba del simulador. */
async function newTestLead(t: Trainer, name: string) {
  const res = await t.client.post('/api/simulator/conversations', { leadName: name });
  expect(res.statusCode, res.body).toBe(200);
  return { leadId: res.json().leadId as string, conversationId: res.json().conversationId as string };
}

const appointmentsOf = (leadId: string) => getDb().select().from(appointments).where(eq(appointments.leadId, leadId));
const jobsOf = (appointmentId: string) =>
  getDb()
    .select()
    .from(scheduledJobs)
    .where(eq(scheduledJobs.dedupeKey, `appt:${appointmentId}:post`))
    .then(async (post) => [...post, ...(await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `appt:${appointmentId}:confirm`)))]);
const outbound = (conversationId: string) =>
  getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));

async function setAutomation(businessId: string, type: AutomationType, patch: { enabled?: boolean; config?: AutomationConfig }) {
  await getDb()
    .update(automations)
    .set(patch)
    .where(and(eq(automations.businessId, businessId), eq(automations.type, type)));
}

const statusCodeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' && r.reason instanceof AppError ? r.reason.statusCode : null);

// ───────────── Reservas ─────────────

describe('reservas sin dobles citas', () => {
  it('dos reservas simultáneas de KAI en el mismo hueco: solo una sale adelante (409 para la otra)', async () => {
    const a = await newLead(T, 'Ana Simultánea');
    const b = await newLead(T, 'Beto Simultáneo');
    const start = futureLocal(3, 10);
    const results = await Promise.allSettled([
      bookAppointment({ businessId: T.businessId, leadId: a.leadId, start, bookedBy: 'kai', actor: { type: 'kai' } }),
      bookAppointment({ businessId: T.businessId, leadId: b.leadId, start, bookedBy: 'kai', actor: { type: 'kai' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.map(statusCodeOf).filter(Boolean)).toEqual([409]);
    const scheduled = await getDb()
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, T.businessId), eq(appointments.startsAt, start), eq(appointments.status, 'scheduled')));
    expect(scheduled).toHaveLength(1);
  });

  it('KAI y el entrenador a la vez en el mismo hueco: una sola cita', async () => {
    const a = await newLead(T, 'Carla Simultánea');
    const b = await newLead(T, 'Dani Simultáneo');
    const start = futureLocal(3, 12);
    const results = await Promise.allSettled([
      bookAppointment({ businessId: T.businessId, leadId: a.leadId, start, bookedBy: 'kai', actor: { type: 'kai' } }),
      bookAppointment({ businessId: T.businessId, leadId: b.leadId, start: new Date(start.getTime() + 10 * 60_000), bookedBy: 'human', actor: userActor(T) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(statusCodeOf).filter(Boolean)).toEqual([409]);
  });

  it('POST /agenda/appointments rechaza la conversación de otro lead (la confirmación le llegaría a otra persona)', async () => {
    const x = await newLead(T, 'Xavi Conversación');
    const y = await newLead(T, 'Yolanda Conversación');
    const wrong = await T.client.post('/api/agenda/appointments', { leadId: x.leadId, conversationId: y.conversationId, start: futureLocal(4, 9).toISOString() });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toMatch(/otro lead/);
    expect(await appointmentsOf(x.leadId)).toHaveLength(0);

    const ok = await T.client.post('/api/agenda/appointments', { leadId: x.leadId, conversationId: x.conversationId, start: futureLocal(4, 9).toISOString() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().appointment.conversationId).toBe(x.conversationId);
  });
});

// ───────────── Reprogramar ─────────────

describe('reprogramar sin perder la cita', () => {
  it('si el nuevo hueco está ocupado, la cita original sigue intacta (y sus recordatorios)', async () => {
    const a = await newLead(T, 'Elena Reprograma');
    const b = await newLead(T, 'Fede Ocupa');
    const original = await bookAppointment({ businessId: T.businessId, leadId: a.leadId, conversationId: a.conversationId, start: futureLocal(5, 10), bookedBy: 'human', actor: userActor(T) });
    const target = futureLocal(5, 12);
    await bookAppointment({ businessId: T.businessId, leadId: b.leadId, start: target, bookedBy: 'human', actor: userActor(T) });

    const res = await T.client.post(`/api/agenda/appointments/${original.id}/reschedule`, { start: target.toISOString() });
    expect(res.statusCode).toBe(409);

    const rows = await appointmentsOf(a.leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');
    expect(rows[0].startsAt.toISOString()).toBe(original.startsAt.toISOString());
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, a.leadId));
    expect(lead.status).toBe('call_booked');
    expect((await jobsOf(original.id)).some((j) => j.status === 'pending')).toBe(true);
    const events = await getDb().select().from(leadEvents).where(eq(leadEvents.leadId, a.leadId));
    expect(events.map((e) => e.type)).not.toContain('call_cancelled');
  });

  it('carrera entre reprogramar y otra reserva del mismo hueco: el lead nunca se queda sin cita', async () => {
    const a = await newLead(T, 'Gema Carrera');
    const b = await newLead(T, 'Hugo Carrera');
    const original = await bookAppointment({ businessId: T.businessId, leadId: a.leadId, start: futureLocal(6, 10), bookedBy: 'human', actor: userActor(T) });
    const target = futureLocal(6, 12);
    const results = await Promise.allSettled([
      rescheduleAppointment(T.businessId, original.id, target, { type: 'kai' }, 'kai'),
      bookAppointment({ businessId: T.businessId, leadId: b.leadId, start: target, bookedBy: 'kai', actor: { type: 'kai' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = (await appointmentsOf(a.leadId)).filter((r) => r.status === 'scheduled');
    expect(active).toHaveLength(1);
    if (results[0].status === 'rejected') expect(active[0].id).toBe(original.id);
  });

  it('reprogramación correcta: la antigua queda “reprogramada” sin pasar el lead a seguimiento', async () => {
    const a = await newLead(T, 'Inés Mueve');
    const original = await bookAppointment({ businessId: T.businessId, leadId: a.leadId, conversationId: a.conversationId, start: futureLocal(7, 10), bookedBy: 'human', actor: userActor(T) });
    const res = await T.client.post(`/api/agenda/appointments/${original.id}/reschedule`, { start: futureLocal(7, 16).toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    const moved = res.json().appointment;
    expect(moved.id).not.toBe(original.id);
    expect(moved.conversationId).toBe(a.conversationId);

    const rows = await appointmentsOf(a.leadId);
    expect(rows.find((r) => r.id === original.id)!.status).toBe('rescheduled');
    expect(rows.find((r) => r.id === moved.id)!.status).toBe('scheduled');
    expect((await jobsOf(original.id)).every((j) => j.status !== 'pending')).toBe(true);
    expect((await jobsOf(moved.id)).some((j) => j.status === 'pending')).toBe(true);
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, a.leadId));
    expect(lead.status).toBe('call_booked');
    const changes = (await getDb().select().from(leadEvents).where(and(eq(leadEvents.leadId, a.leadId), eq(leadEvents.type, 'status_changed')))).map((e) => e.data.to);
    expect(changes).not.toContain('follow_up');
  });
});

// ───────────── Google Calendar y simulador ─────────────

describe('Google Calendar', () => {
  let G: Trainer;
  const calls: { method: string; url: string }[] = [];
  let failCreate = false;
  let eventCounter = 0;

  function stubGoogle() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        if (url.includes('/freeBusy')) return Response.json({ calendars: { primary: { busy: [] } } });
        if (method === 'POST' && url.includes('/events')) {
          return failCreate ? Response.json({ error: { message: 'Backend Error' } }, { status: 500 }) : Response.json({ id: `ev_${++eventCounter}`, hangoutLink: 'https://meet.google.com/abc-defg-hij' });
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json({ error: { message: 'no simulado' } }, { status: 404 });
      }),
    );
  }

  beforeAll(async () => {
    G = await registerTrainer(app, { name: 'Gonzalo Google', businessName: 'Gonzalo Coach' });
    await openAgenda(G.client);
    await saveCalendarConnection(G.businessId, G.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-de-prueba', refreshToken: 'refresh-de-prueba', expiresAt: Date.now() + 24 * 3600_000 },
      calendarId: 'primary',
    });
  });

  it('si Google falla al crear el evento nuevo, la cita original (y su evento) se conservan', async () => {
    stubGoogle();
    failCreate = false;
    const l = await newLead(G, 'Julia Google');
    const original = await bookAppointment({ businessId: G.businessId, leadId: l.leadId, start: futureLocal(5, 10), bookedBy: 'human', actor: userActor(G) });
    expect(original.calendarProvider).toBe('google');
    expect(original.externalEventId).toMatch(/^ev_/);
    expect(original.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');

    failCreate = true;
    calls.length = 0;
    const res = await G.client.post(`/api/agenda/appointments/${original.id}/reschedule`, { start: futureLocal(5, 12).toISOString() });
    expect(res.statusCode).toBe(503);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    const rows = await appointmentsOf(l.leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');
    expect(rows[0].externalEventId).toBe(original.externalEventId);

    // Con Google funcionando: primero se crea el evento nuevo y después se borra el antiguo.
    failCreate = false;
    calls.length = 0;
    const ok = await G.client.post(`/api/agenda/appointments/${original.id}/reschedule`, { start: futureLocal(5, 12).toISOString() });
    expect(ok.statusCode, ok.body).toBe(200);
    const order = calls.filter((c) => c.url.includes('/events')).map((c) => c.method);
    expect(order).toEqual(['POST', 'DELETE']);
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain(encodeURIComponent(original.externalEventId!));
  });

  it('una reserva del simulador no crea eventos en Google ni quita el hueco a un lead real', async () => {
    stubGoogle();
    failCreate = false;
    const test = await newTestLead(G, 'Prueba Simulador');
    const real = await newLead(G, 'Kevin Real');
    const start = futureLocal(6, 10);
    calls.length = 0;
    const testAppt = await bookAppointment({ businessId: G.businessId, leadId: test.leadId, start, bookedBy: 'kai', actor: { type: 'kai' } });
    expect(testAppt.calendarProvider).toBe('internal');
    expect(testAppt.externalEventId).toBeNull();
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/events'))).toHaveLength(0);

    const realAppt = await bookAppointment({ businessId: G.businessId, leadId: real.leadId, start, bookedBy: 'kai', actor: { type: 'kai' } });
    expect(realAppt.status).toBe('scheduled');
    expect(realAppt.calendarProvider).toBe('google');

    // En la agenda, las citas de prueba vienen marcadas.
    const list = await G.client.get('/api/agenda/appointments', {
      query: { from: new Date(start.getTime() - 3600_000).toISOString(), to: new Date(start.getTime() + 3600_000).toISOString() },
    });
    const byLead = Object.fromEntries((list.json().appointments as { lead: { id: string; isTest: boolean } }[]).map((r) => [r.lead.id, r.lead.isTest]));
    expect(byLead[test.leadId]).toBe(true);
    expect(byLead[real.leadId]).toBe(false);
  });

  it('releaseLeadAppointments borra el evento de Google y los recordatorios antes de eliminar un lead', async () => {
    stubGoogle();
    failCreate = false;
    const l = await newLead(G, 'Lola Borrar');
    const appt = await bookAppointment({ businessId: G.businessId, leadId: l.leadId, start: futureLocal(8, 10), bookedBy: 'human', actor: userActor(G) });
    calls.length = 0;
    expect(await releaseLeadAppointments(G.businessId, l.leadId)).toBe(1);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url).join()).toContain(encodeURIComponent(appt.externalEventId!));
    expect((await jobsOf(appt.id)).every((j) => j.status !== 'pending')).toBe(true);
  });
});

// ───────────── No-show ─────────────

describe('no-show', () => {
  it('el mensaje de no-show respeta el horario de silencio', async () => {
    const now = DateTime.now().setZone(TZ);
    const quietHours = { start: now.minus({ hours: 1 }).toFormat('HH:mm'), end: now.plus({ hours: 2 }).toFormat('HH:mm') };
    await setAutomation(T.businessId, 'no_show_recovery', { enabled: true, config: { delayMinutes: 15, quietHours } });
    const l = await newLead(T, 'Marco Ausente');
    // La llamada ya ha empezado (antes de su hora no se puede registrar el resultado).
    const appt = await bookAppointment({ businessId: T.businessId, leadId: l.leadId, start: new Date(Date.now() - 2 * 3600_000), bookedBy: 'human', actor: userActor(T), confirmationAlreadySent: true });
    await setAppointmentOutcome(T.businessId, appt.id, { attended: false }, userActor(T));
    const [job] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `appt:${appt.id}:noshow`));
    expect(job.status).toBe('pending');
    expect(DateTime.fromJSDate(job.runAt).setZone(TZ).toFormat('HH:mm')).toBe(quietHours.end);
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });
});

// ───────────── Worker ─────────────

/** Ejecuta YA los trabajos indicados (y solo esos: el resto se aparta un momento). */
async function runNow(jobIds: string[]) {
  const db = getDb();
  const others = (await db.select().from(scheduledJobs).where(eq(scheduledJobs.status, 'pending'))).filter((j) => !jobIds.includes(j.id));
  const far = new Date(Date.now() + 365 * 24 * 3600_000);
  for (const j of others) await db.update(scheduledJobs).set({ runAt: far }).where(eq(scheduledJobs.id, j.id));
  for (const id of jobIds) await db.update(scheduledJobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(scheduledJobs.id, id));
  await runDueJobs(50);
  for (const j of others) await db.update(scheduledJobs).set({ runAt: j.runAt }).where(and(eq(scheduledJobs.id, j.id), eq(scheduledJobs.status, 'pending')));
}

describe('worker', () => {
  it('cuenta suspendida: no envía nada y cancela sus trabajos y seguimientos', async () => {
    const S = await registerTrainer(app, { name: 'Sara Suspendida', businessName: 'Sara Fit' });
    await openAgenda(S.client);
    const l = await newLead(S, 'Nora Suspendida');
    const appt = await bookAppointment({ businessId: S.businessId, leadId: l.leadId, conversationId: l.conversationId, start: futureLocal(3, 10), bookedBy: 'human', actor: userActor(S) });
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: S.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date(Date.now() + 3600_000) })
      .returning();
    const before = (await outbound(l.conversationId)).length;
    await getDb().update(businesses).set({ status: 'suspended' }).where(eq(businesses.id, S.businessId));

    const [confirm] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `appt:${appt.id}:confirm`));
    await runNow([confirm.id]);

    expect(await outbound(l.conversationId)).toHaveLength(before);
    const jobs = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.businessId, S.businessId));
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.filter((j) => j.status === 'pending')).toHaveLength(0);
    expect(jobs.find((j) => j.id === confirm.id)!.status).toBe('cancelled');
    const [fuAfter] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(fuAfter.status).toBe('cancelled');
  });

  it('recordatorio de 1 h ejecutado tarde (faltan 10 min): no se envía', async () => {
    const l = await newLead(T, 'Óscar Tarde');
    const appt = await bookAppointment({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, start: new Date(Date.now() + 10 * 60_000), bookedBy: 'human', actor: userActor(T), confirmationAlreadySent: true });
    const job = await scheduleJob({ businessId: T.businessId, type: 'appointment_reminder', runAt: new Date(), payload: { appointmentId: appt.id, kind: '1h' }, dedupeKey: `test:late:${appt.id}` });
    await runNow([job.id]);
    const [after] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
    expect(after.status).toBe('done');
    expect((await outbound(l.conversationId)).filter((m) => m.metadata.kind === 'reminder_1h')).toHaveLength(0);
    const [row] = await appointmentsOf(l.leadId);
    expect(row.reminder1hSentAt).toBeNull();
  });

  it('recordatorio de 1 h a tiempo: usa el texto personalizado del entrenador', async () => {
    await setAutomation(T.businessId, 'appointment_reminders', {
      enabled: true,
      config: { confirmation: true, reminder24h: true, reminder1h: true, reminder1hMessage: 'Hola {nombre}, a las {hora} empieza tu {llamada}. Enlace: {enlace}' },
    });
    const l = await newLead(T, 'Paula Puntual');
    const start = new Date(Date.now() + 50 * 60_000);
    const appt = await bookAppointment({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, start, bookedBy: 'human', actor: userActor(T), confirmationAlreadySent: true });
    const job = await scheduleJob({ businessId: T.businessId, type: 'appointment_reminder', runAt: new Date(), payload: { appointmentId: appt.id, kind: '1h' }, dedupeKey: `test:ontime:${appt.id}` });
    await runNow([job.id]);
    const sent = (await outbound(l.conversationId)).filter((m) => m.metadata.kind === 'reminder_1h');
    expect(sent).toHaveLength(1);
    // Sin enlace (cita interna): “Enlace:” no queda suelto.
    expect(sent[0].content).toBe(`Hola Paula, a las ${DateTime.fromJSDate(start).setZone(TZ).toFormat('HH:mm')} empieza tu llamada de valoración.`);
  });

  it('trabajos huérfanos: vuelven a la cola si les quedan intentos, fallan si no, y no chocan con uno más reciente', async () => {
    const db = getDb();
    const stale = new Date(Date.now() - 30 * 60_000);
    const base = { businessId: T.businessId, type: 'post_call', runAt: stale, status: 'running' as const, lockedAt: stale, payload: {} };
    const [retry] = await db.insert(scheduledJobs).values({ ...base, attempts: 1, maxAttempts: 3, dedupeKey: 'test:stale:retry' }).returning();
    const [exhausted] = await db.insert(scheduledJobs).values({ ...base, attempts: 3, maxAttempts: 3, dedupeKey: 'test:stale:dead' }).returning();
    const [superseded] = await db.insert(scheduledJobs).values({ ...base, attempts: 1, maxAttempts: 3, dedupeKey: 'test:stale:dup' }).returning();
    const [newer] = await db.insert(scheduledJobs).values({ businessId: T.businessId, type: 'post_call', runAt: new Date(Date.now() + 3600_000), payload: {}, dedupeKey: 'test:stale:dup' }).returning();

    await releaseStaleJobs();
    const status = async (id: string) => (await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)))[0].status;
    expect(await status(retry.id)).toBe('pending');
    expect(await status(exhausted.id)).toBe('failed');
    expect(await status(superseded.id)).toBe('cancelled');
    expect(await status(newer.id)).toBe('pending');
    // Limpieza: que el worker no los ejecute en otros tests.
    await db.update(scheduledJobs).set({ status: 'cancelled' }).where(eq(scheduledJobs.id, retry.id));
    await db.update(scheduledJobs).set({ status: 'cancelled' }).where(eq(scheduledJobs.id, newer.id));
  });

  it('el worker (también con cron externo) asegura una sola vez los trabajos del sistema', async () => {
    await runDueJobs(0, { forceHousekeeping: true });
    await runDueJobs(0, { forceHousekeeping: true });
    const active = (await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, 'system:maintenance'))).filter((j) => j.status === 'pending' || j.status === 'running');
    expect(active).toHaveLength(1);
  });
});

// ───────────── Seguimientos e Instagram ─────────────

describe('seguimientos dentro de la ventana de 24 h (Instagram)', () => {
  const STEPS = { steps: [{ delayHours: 4, angle: 'Retomar la conversación.' }, { delayHours: 24, angle: 'Aportar algo útil.' }] };

  /** Lead real con conversación de Instagram cuyo último mensaje fue hace `hoursAgo` horas. */
  async function instagramLead(name: string, hoursAgo: number) {
    const res = await T.client.post('/api/leads', { name, source: 'instagram' });
    const leadId = res.json().lead.id as string;
    const [conv] = await getDb()
      .insert(conversations)
      .values({ businessId: T.businessId, leadId, channel: 'instagram', lastInboundAt: new Date(Date.now() - hoursAgo * 3600_000) })
      .returning();
    return { leadId, conversationId: conv.id };
  }

  it('si el paso caería fuera de la ventana, se adelanta para que entre', async () => {
    await setAutomation(T.businessId, 'followup_no_reply', { enabled: true, config: STEPS });
    const l = await instagramLead('Tania Instagram', 20);
    const fu = await scheduleNoReplyFollowUp(T.businessId, l.leadId, l.conversationId);
    expect(fu).not.toBeNull();
    // Último mensaje del lead hace 20 h → la ventana cierra en 4 h; con margen, a las 3 h 30 min.
    const expected = Date.now() + 3.5 * 3600_000;
    expect(Math.abs(fu!.scheduledFor.getTime() - expected)).toBeLessThan(60_000);
  });

  it('si ya no cabe en la ventana, no se programa (ni se redacta con IA para nada)', async () => {
    await setAutomation(T.businessId, 'followup_no_reply', { enabled: true, config: STEPS });
    const l = await instagramLead('Ulises Instagram', 23.8);
    expect(await scheduleNoReplyFollowUp(T.businessId, l.leadId, l.conversationId)).toBeNull();
    expect(await getDb().select().from(followUps).where(eq(followUps.leadId, l.leadId))).toHaveLength(0);
  });

  it('el worker no intenta enviar un seguimiento con la ventana ya cerrada: lo omite sin crear avisos', async () => {
    await setAutomation(T.businessId, 'followup_no_reply', { enabled: true, config: STEPS });
    const l = await instagramLead('Vera Instagram', 30);
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date() })
      .returning();
    const job = await scheduleJob({ businessId: T.businessId, type: 'followup', runAt: new Date(), payload: { followUpId: fu.id, leadId: l.leadId }, dedupeKey: `followup:${fu.id}` });
    await runNow([job.id]);
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after.status).toBe('skipped');
    expect(after.note).toMatch(/ventana de 24 h/);
    expect(await outbound(l.conversationId)).toHaveLength(0);
    expect(await getDb().select().from(alerts).where(eq(alerts.leadId, l.leadId))).toHaveLength(0);
  });
});

// ───────────── Textos de la llamada (API) ─────────────

describe('mensajes de la llamada', () => {
  it('GET /agenda/message-templates devuelve los textos por defecto, los campos y las variables', async () => {
    const res = await T.client.get('/api/agenda/message-templates');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fields).toEqual({ confirmation: 'confirmationMessage', reminder24h: 'reminder24hMessage', reminder1h: 'reminder1hMessage', noShow: 'noShowMessage' });
    expect(body.defaults.confirmation).toContain('{hora}');
    expect(body.variables.map((v: { key: string }) => v.key)).toEqual(['nombre', 'fecha', 'hora', 'llamada', 'entrenador', 'enlace']);
  });

  it('POST /agenda/message-templates/preview: vista previa con los datos del negocio y problemas del texto', async () => {
    const ok = await T.client.post('/api/agenda/message-templates/preview', { kind: 'confirmation', text: 'Hola {nombre}, te confirmo la {llamada} con {entrenador} {fecha} a las {hora}.' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().issues).toEqual([]);
    expect(ok.json().preview).toMatch(/^Hola Laura, te confirmo la llamada de valoración con .+ mañana a las 18:00\.$/);

    const bad = await T.client.post('/api/agenda/message-templates/preview', { kind: 'reminder1h', text: 'Hola {name}' });
    expect(bad.json().issues.join(' ')).toMatch(/\{name\} no es una variable válida/);

    const empty = await T.client.post('/api/agenda/message-templates/preview', { kind: 'noShow', text: '' });
    expect(empty.json().usesDefault).toBe(true);
    expect(empty.json().preview).toMatch(/veo que finalmente no pudiste entrar/);
  });
});

// ───────────── Copilot ─────────────

describe('Copilot: acciones pendientes', () => {
  const ctx = (): TenantContext => ({ businessId: T.businessId, userId: T.userId, role: 'trainer', permissions: ROLE_PERMISSIONS.trainer });

  it('no crea acciones incompletas (sin texto, sin lead, sin activar/desactivar)', async () => {
    const l = await newLead(T, 'Quique Copilot');
    await expect(createPendingAction(ctx(), 'send_message', { leadId: l.leadId, text: null })).rejects.toThrow(/Falta el texto/);
    await expect(createPendingAction(ctx(), 'send_message', { text: 'Hola' })).rejects.toThrow(/qué lead/);
    await expect(createPendingAction(ctx(), 'toggle_automation', { automation: 'post_call' })).rejects.toThrow(/activar o desactivar/);
    await expect(createPendingAction(ctx(), 'toggle_automation', { automation: 'inventada', enabled: true })).rejects.toThrow(/no válida/);
  });

  it('el mensaje propuesto pasa el control de calidad (nada de precios inventados)', async () => {
    const l = await newLead(T, 'Rosa Calidad');
    await expect(createPendingAction(ctx(), 'send_message', { leadId: l.leadId, text: 'Rosa, el plan te sale por solo 999 € si te decides hoy.' })).rejects.toThrow(/control de calidad/);
  });

  it('la confirmación muestra el mensaje completo y un doble clic no lo envía dos veces', async () => {
    const l = await newLead(T, 'Sergio Doble');
    const text =
      'Sergio, me quedé pensando en lo que me contaste de los turnos de noche y de lo difícil que se te hace mantener una rutina estable. Tengo una idea para organizar los entrenamientos en tus días libres. ¿Te cuento cómo lo haríamos?';
    expect(text.length).toBeGreaterThan(160);
    const action = await createPendingAction(ctx(), 'send_message', { leadId: l.leadId, text, summary: 'resumen del modelo' });
    expect(action.summary).toContain(text);

    const results = await Promise.allSettled([confirmPendingAction(ctx(), action.id), confirmPendingAction(ctx(), action.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map(statusCodeOf).filter(Boolean)).toEqual([400]);
    const sent = (await outbound(l.conversationId)).filter((m) => m.metadata.via === 'copilot');
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe(text);
    // Ya resuelta: tampoco se puede cancelar.
    await expect(cancelPendingAction(ctx(), action.id)).rejects.toThrow(/ya fue resuelta/);
  });

  it('las acciones caducadas no aparecen como pendientes ni se pueden confirmar', async () => {
    const [old] = await getDb()
      .insert(pendingActions)
      .values({ businessId: T.businessId, userId: T.userId, type: 'toggle_autopilot', summary: 'Pausar el piloto automático', payload: { enabled: false }, expiresAt: new Date(Date.now() - 60_000) })
      .returning();
    expect((await listPendingActions(ctx())).map((a) => a.id)).not.toContain(old.id);
    await expect(confirmPendingAction(ctx(), old.id)).rejects.toThrow(/caducado/);
    const [row] = await getDb().select().from(pendingActions).where(eq(pendingActions.id, old.id));
    expect(row.status).toBe('expired');
  });

  it('cambio de tono: el resumen muestra los cambios reales (antes → después)', async () => {
    const action = await createPendingAction(ctx(), 'update_tone', { tone: { formality: 4, emojiUsage: 'none' }, summary: 'algo que dice el modelo' });
    expect(action.summary).toContain('Formalidad: Cercano → Formal');
    expect(action.summary).toContain('Emojis: Pocos → Ninguno');
    expect(action.summary).not.toContain('algo que dice el modelo');
    await expect(createPendingAction(ctx(), 'update_tone', { tone: { formality: 2 } })).rejects.toThrow(/ya está así/);
  });
});
