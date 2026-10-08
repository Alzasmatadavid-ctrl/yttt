/**
 * Revisión nº 1 · integración del backend (tareas que dejaron los demás correctores):
 * - Worker: reintento de Lead Ads en el mantenimiento, sin avisos de ruido con leads dados de baja y
 *   seguimientos cancelados (no «fallidos») cuando el plan no deja escribir.
 * - Cuenta desactivada: el admin cancela sus trabajos al suspenderla y los mensajes entrantes no programan respuestas.
 * - Límite de peticiones por negocio en el simulador y la vista previa.
 * - Alta de nuevo (opt-in), una sola pregunta por variable, textos de recordatorio y migración de la pregunta de urgencia.
 * - Borrar un lead libera su evento de Google; panel con bandas, sin citas de prueba y sin tope de 10.
 * - Calendly: reconectar borra el webhook anterior; conectar Google también.
 * - Equipo y «Crear mi negocio» para una cuenta que se ha quedado sin negocio.
 * Ninguna petición sale a la red (fetch simulado).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { createDatabase, getDb, MIGRATIONS_FOLDER } from '../../src/database/client.js';
import {
  alerts,
  appointments,
  auditLogs,
  automations,
  businesses,
  calendarConnections,
  followUps,
  leadEvents,
  leads,
  messages,
  qualificationRules,
  scheduledJobs,
  sessions,
  users,
  webhookEvents,
} from '../../src/database/schema.js';
import { env } from '../../src/config/env.js';
import { runJob } from '../../src/automation/worker.js';
import { scheduleJob } from '../../src/automation/jobs.js';
import { incrementUsage } from '../../src/plans/plans.service.js';
import { createLead } from '../../src/crm/leads.service.js';
import { ingestExternalLead, receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';
import { bookAppointment } from '../../src/calendar/calendar.service.js';
import { saveCalendarConnection } from '../../src/calendar/connections.js';
import { createBusiness } from '../../src/business/business.service.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { ONE_QUESTION_MESSAGE } from '../../src/lib/domain.js';
import {
  ApiClient,
  json,
  makePlatformAdmin,
  openAgenda,
  registerTrainer,
  setPlan,
  setupTestApp,
  teardownTestApp,
  uniqueEmail,
  type Trainer,
} from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await setupTestApp();
});

afterAll(async () => {
  await teardownTestApp(app);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ───────────── Utilidades ─────────────

/** Lead real con su conversación de chat web (sin canal externo). */
async function newLead(t: Trainer, name: string) {
  const res = await t.client.post('/api/leads', { name });
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

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ───────────── Worker ─────────────

describe('worker', () => {
  it('el mantenimiento reintenta los avisos de Lead Ads que fallaron', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Anuncios' });
    const PAGE_ID = '880011223344';
    const conn = await T.client.post('/api/integrations/channels', {
      channel: 'meta_lead_ads',
      externalAccountId: PAGE_ID,
      accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
      skipVerification: true,
    });
    expect(conn.statusCode, conn.body).toBe(200);
    await getDb()
      .insert(webhookEvents)
      .values({ provider: 'meta_leadgen', externalId: '7001', businessId: T.businessId, payload: { leadgen_id: '7001', page_id: PAGE_ID, form_id: '777' }, status: 'failed' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'graph.facebook.com') throw new Error(`Red no permitida en tests: ${url}`);
      return jsonResponse(200, { id: '7001', campaign_name: 'Otoño', field_data: [{ name: 'full_name', values: ['Irene Anuncio'] }, { name: 'email', values: ['irene.ads@example.com'] }] });
    });

    const job = await scheduleJob({ type: 'maintenance', runAt: new Date(), dedupeKey: 'test:maintenance:leadgen' });
    expect((await runJobNow(job.id)).status).toBe('done');

    const [event] = await getDb().select().from(webhookEvents).where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.externalId, '7001')));
    expect(event.status).toBe('processed');
    const [lead] = await getDb().select().from(leads).where(eq(leads.email, 'irene.ads@example.com'));
    expect(lead).toMatchObject({ businessId: T.businessId, source: 'meta_ads', name: 'Irene Anuncio' });
  });

  it('confirmación y recordatorio de un lead dado de baja: no se intenta enviar (ni se crea el aviso «Mensaje no enviado»)', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Bajas' });
    const l = await newLead(T, 'Bruno Baja');
    const startsAt = new Date(Date.now() + 30 * 3600_000);
    const [appt] = await getDb()
      .insert(appointments)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), bookedBy: 'human' })
      .returning();
    // Baja registrada directamente (sin cancelar los trabajos) para comprobar la guarda del propio worker.
    await getDb().update(leads).set({ optedOut: true }).where(eq(leads.id, l.leadId));
    const confirm = await scheduleJob({ businessId: T.businessId, type: 'appointment_confirmation', runAt: new Date(), payload: { appointmentId: appt.id, leadId: l.leadId } });
    const reminder = await scheduleJob({ businessId: T.businessId, type: 'appointment_reminder', runAt: new Date(), payload: { appointmentId: appt.id, leadId: l.leadId, kind: '24h' } });

    expect((await runJobNow(confirm.id)).status).toBe('done');
    expect((await runJobNow(reminder.id)).status).toBe('done');
    expect(await outbound(l.conversationId)).toHaveLength(0);
    const blocked = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.businessId, T.businessId), eq(alerts.type, 'delivery_blocked')));
    expect(blocked).toHaveLength(0);
  });

  it('seguimiento con el límite de mensajes del plan agotado: se cancela con el motivo (no se marca como fallo de calidad)', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Sin Mensajes' });
    await setPlan(T.businessId, 'starter');
    const l = await newLead(T, 'Lidia Límite');
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: T.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date() })
      .returning();
    const job = await scheduleJob({ businessId: T.businessId, type: 'followup', runAt: new Date(), payload: { followUpId: fu.id, leadId: l.leadId } });
    await getDb().update(followUps).set({ jobId: job.id }).where(eq(followUps.id, fu.id));
    await incrementUsage(T.businessId, 'ai_messages', 1_000_000);

    expect((await runJobNow(job.id)).status).toBe('done');
    const [after] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(after.status).toBe('cancelled');
    expect(after.note).toMatch(/límite de mensajes/);
    expect(after.note).not.toMatch(/Control de calidad/);
    expect(await outbound(l.conversationId)).toHaveLength(0);
  });
});

// ───────────── Cuenta desactivada ─────────────

describe('cuenta desactivada', () => {
  it('al suspenderla desde el panel de administración se cancelan sus trabajos y seguimientos pendientes', async () => {
    const admin = await registerTrainer(app, { businessName: 'Plataforma' });
    await makePlatformAdmin(admin.userId);
    const S = await registerTrainer(app, { businessName: 'Negocio Suspendido' });
    const l = await newLead(S, 'Sonia Suspendida');
    const [fu] = await getDb()
      .insert(followUps)
      .values({ businessId: S.businessId, leadId: l.leadId, conversationId: l.conversationId, reason: 'no_reply', step: 1, scheduledFor: new Date(Date.now() + 3600_000) })
      .returning();
    const job = await scheduleJob({ businessId: S.businessId, type: 'followup', runAt: new Date(Date.now() + 3600_000), payload: { followUpId: fu.id, leadId: l.leadId } });
    const other = await registerTrainer(app, { businessName: 'Negocio Activo' });
    const otherJob = await scheduleJob({ businessId: other.businessId, type: 'post_call', runAt: new Date(Date.now() + 3600_000), payload: {} });

    const res = await admin.client.patch(`/api/admin/businesses/${S.businessId}`, { status: 'suspended' });
    expect(res.statusCode, res.body).toBe(200);

    const [jobAfter] = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
    expect(jobAfter.status).toBe('cancelled');
    expect(jobAfter.lastError).toBe('Cuenta desactivada');
    const [fuAfter] = await getDb().select().from(followUps).where(eq(followUps.id, fu.id));
    expect(fuAfter).toMatchObject({ status: 'cancelled', note: 'Cuenta desactivada' });
    // Los demás negocios no se tocan.
    expect((await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.id, otherJob.id)))[0].status).toBe('pending');
  });

  it('los mensajes y leads que llegan se guardan, pero no se programa ninguna respuesta ni primer contacto', async () => {
    const S = await registerTrainer(app, { businessName: 'Negocio Pausado' });
    await getDb().update(businesses).set({ status: 'suspended' }).where(eq(businesses.id, S.businessId));

    const inbound = await receiveInboundMessage({
      businessId: S.businessId,
      channel: 'whatsapp',
      externalMessageId: 'wamid.suspendido.1',
      text: 'Hola, quiero información',
      profile: { name: 'Ana WhatsApp', whatsappId: '34600111333', phone: '+34600111333' },
    });
    expect(inbound.duplicate).toBe(false);
    if (inbound.duplicate) return;
    expect(await getDb().select().from(messages).where(eq(messages.conversationId, inbound.conversation.id))).toHaveLength(1);
    expect(await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `reply:${inbound.conversation.id}`))).toHaveLength(0);

    const external = await ingestExternalLead({ businessId: S.businessId, source: 'webhook', name: 'Bea Formulario', phone: '+34600111444', firstContactChannel: 'whatsapp' });
    expect(external.created).toBe(true);
    expect(external.conversationId).toBeNull();
    expect(await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `first_contact:${external.lead.id}`))).toHaveLength(0);

    // Con la cuenta activa, el mismo mensaje sí programa la respuesta de KAI.
    const A = await registerTrainer(app, { businessName: 'Negocio Funcionando' });
    const active = await receiveInboundMessage({
      businessId: A.businessId,
      channel: 'whatsapp',
      externalMessageId: 'wamid.activo.1',
      text: 'Hola, quiero información',
      profile: { name: 'Eva WhatsApp', whatsappId: '34600111555', phone: '+34600111555' },
    });
    if (active.duplicate) throw new Error('duplicado inesperado');
    const replyJobs = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `reply:${active.conversation.id}`));
    expect(replyJobs).toHaveLength(1);
    await getDb().update(scheduledJobs).set({ status: 'cancelled' }).where(eq(scheduledJobs.id, replyJobs[0].id));
  });
});

// ───────────── Límite de peticiones por negocio ─────────────

describe('límite de peticiones del simulador y de la vista previa (por negocio, no por IP)', () => {
  const saved = env.SIMULATOR_MAX_PER_MINUTE;
  afterEach(() => {
    env.SIMULATOR_MAX_PER_MINUTE = saved;
  });

  it('la vista previa del Setter IA: al pasar el límite responde 429 aunque se cambie de IP; otro negocio no se ve afectado', async () => {
    env.SIMULATOR_MAX_PER_MINUTE = 2;
    const T = await registerTrainer(app, { businessName: 'Negocio Previews' });
    for (let i = 0; i < 2; i++) expect((await T.client.post('/api/settings/ai/preview', { leadMessage: 'Hola, quiero perder grasa' })).statusCode).toBe(200);
    const third = await T.client.post('/api/settings/ai/preview', { leadMessage: 'Hola' });
    expect(third.statusCode).toBe(429);
    expect(third.json().message).toMatch(/Espera un momento/);
    // Misma cuenta desde otra IP: el límite es del negocio.
    expect((await T.client.withNewIp().post('/api/settings/ai/preview', { leadMessage: 'Hola' })).statusCode).toBe(429);
    // Otro negocio tiene su propio contador.
    const other = await registerTrainer(app, { businessName: 'Otro Negocio Previews' });
    expect((await other.client.post('/api/settings/ai/preview', { leadMessage: 'Hola' })).statusCode).toBe(200);
  });

  it('los mensajes del simulador también tienen límite', async () => {
    env.SIMULATOR_MAX_PER_MINUTE = 2;
    const T = await registerTrainer(app, { businessName: 'Negocio Simulador' });
    const sim = await T.client.post('/api/simulator/conversations', { leadName: 'Prueba' });
    const id = sim.json().conversationId as string;
    expect((await T.client.post(`/api/simulator/conversations/${id}/messages`, { text: 'Hola!' })).statusCode).toBe(200);
    expect((await T.client.post(`/api/simulator/conversations/${id}/messages`, { text: 'Quiero perder grasa' })).statusCode).toBe(200);
    expect((await T.client.withNewIp().post(`/api/simulator/conversations/${id}/messages`, { text: 'Otra cosa' })).statusCode).toBe(429);
  });
});

// ───────────── CRM: alta de nuevo ─────────────

describe('volver a permitir mensajes (opt-in)', () => {
  it('POST /leads/:id/opt-in deshace la baja, deja el evento en la ficha y la auditoría con el usuario', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Altas' });
    const l = await newLead(T, 'Olga Alta');
    expect(json(await T.client.post(`/api/leads/${l.leadId}/opt-out`, { optedOut: true, reason: 'Me lo pidió por teléfono' })).lead.optedOut).toBe(true);

    const res = await T.client.post(`/api/leads/${l.leadId}/opt-in`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().lead.optedOut).toBe(false);
    const events = await getDb().select().from(leadEvents).where(eq(leadEvents.leadId, l.leadId));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['opted_out', 'opted_in']));
    const [log] = await getDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, T.businessId), eq(auditLogs.action, 'lead.opted_in'), eq(auditLogs.entityId, l.leadId)));
    expect(log.actorUserId).toBe(T.userId);
    // KAI sigue en pausa en sus conversaciones hasta que el entrenador se las devuelva.
    const detail = json(await T.client.get(`/api/conversations/${l.conversationId}`));
    expect(detail.conversation.aiEnabled).toBe(false);
    // Repetirlo no duplica nada.
    await T.client.post(`/api/leads/${l.leadId}/opt-in`);
    expect((await getDb().select().from(leadEvents).where(and(eq(leadEvents.leadId, l.leadId), eq(leadEvents.type, 'opted_in'))))).toHaveLength(1);
  });
});

// ───────────── Ajustes ─────────────

describe('ajustes', () => {
  it('PUT /settings/qualification rechaza una pregunta con dos «?» (KAI hace una sola pregunta por mensaje)', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Preguntas' });
    const rules = json(await T.client.get('/api/settings')).qualificationRules as Record<string, unknown>[];
    const payload = (question: string) => ({
      rules: rules.map((r) => ({
        key: r.key,
        label: r.label,
        description: r.description,
        question: r.key === 'urgency' ? question : r.question,
        weight: r.weight,
        required: r.required,
        enabled: r.enabled,
        disqualifyWhen: r.disqualifyWhen,
      })),
    });
    const bad = await T.client.put('/api/settings/qualification', payload('¿Por qué ahora? ¿Hay alguna fecha?'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe(ONE_QUESTION_MESSAGE);
    expect(bad.json().details[0].path).toMatch(/^rules\.\d+\.question$/);

    const ok = await T.client.put('/api/settings/qualification', payload('¿Hay alguna fecha que te haga querer empezar ya?'));
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('PUT /settings/automations guarda los textos de la llamada y valida sus variables', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Textos' });
    const config = {
      confirmation: true,
      reminder24h: true,
      reminder1h: true,
      confirmationMessage: '  {nombre}, te espero {fecha} a las {hora} para la {llamada}.  ',
      reminder24hMessage: '',
      reminder1hMessage: 'En una hora, a las {hora}, hablamos. Enlace: {enlace}',
    };
    const ok = await T.client.put('/api/settings/automations/appointment_reminders', { enabled: true, config });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await getDb()
      .select()
      .from(automations)
      .where(and(eq(automations.businessId, T.businessId), eq(automations.type, 'appointment_reminders')));
    expect(row.config).toMatchObject({ confirmationMessage: '{nombre}, te espero {fecha} a las {hora} para la {llamada}.', reminder24hMessage: '', reminder1hMessage: config.reminder1hMessage });

    const missingTime = await T.client.put('/api/settings/automations/appointment_reminders', { enabled: true, config: { ...config, reminder1hMessage: 'Nos vemos enseguida' } });
    expect(missingTime.statusCode).toBe(400);
    expect(missingTime.json().message).toContain('recordatorio de una hora antes');
    expect(missingTime.json().message).toContain('{hora}');

    const price = await T.client.put('/api/settings/automations/no_show_recovery', { enabled: true, config: { delayMinutes: 15, noShowMessage: 'Te hago un 20% sobre los 150 € si reservas hoy' } });
    expect(price.statusCode).toBe(400);
    expect(price.json().message).toContain('mensaje si no se presenta');
    expect(price.json().message).toMatch(/precios/);

    const tooLong = await T.client.put('/api/settings/automations/no_show_recovery', { enabled: true, config: { noShowMessage: 'a'.repeat(701) } });
    expect(tooLong.statusCode).toBe(400);
  });
});

// ───────────── Migración de la pregunta de urgencia ─────────────

describe('migración 0001: pregunta de urgencia con una sola pregunta', () => {
  it('actualiza la pregunta antigua por defecto y respeta las personalizadas', async () => {
    const OLD = '¿Por qué ahora? ¿Hay alguna fecha o algo que te haga querer empezar ya?';
    const NEW = '¿Hay alguna fecha o motivo que te haga querer empezar ahora?';
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain('0001_urgency_one_question');

    // Base de datos “antigua”: solo la migración inicial.
    const dir = mkdtempSync(path.join(tmpdir(), 'kai-migr-'));
    const handle = await createDatabase({ memory: true });
    try {
      mkdirSync(path.join(dir, 'meta'));
      cpSync(path.join(MIGRATIONS_FOLDER, '0000_init.sql'), path.join(dir, '0000_init.sql'));
      writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
      const { migrate } = await import('drizzle-orm/pglite/migrator');
      await migrate(handle.db as never, { migrationsFolder: dir });

      const db = handle.db;
      const newBusiness = async (email: string, question: string) => {
        const [user] = await db.insert(users).values({ email, name: 'Dueño', passwordHash: await hashPassword('Kaizen12345') }).returning();
        const biz = await createBusiness({ name: `Negocio ${email}`, ownerUserId: user.id, ownerName: 'Dueño' }, db);
        await db.update(qualificationRules).set({ question }).where(and(eq(qualificationRules.businessId, biz.id), eq(qualificationRules.key, 'urgency')));
        return biz.id;
      };
      // El código actual ya escribe columnas que llegan en migraciones posteriores (0002: negocio principal de la
      // cuenta): se crean solo para dar de alta los datos “antiguos” y se quitan antes de migrar.
      await db.execute(sql`alter table "businesses" add column "account_business_id" uuid`);
      const withDefault = await newBusiness('antiguo@example.com', OLD);
      const custom = await newBusiness('personalizado@example.com', '¿Cuándo te gustaría empezar?');
      await db.execute(sql`alter table "businesses" drop column "account_business_id"`);

      // Arranque con la versión nueva: aplica las migraciones pendientes.
      await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
      const urgency = async (businessId: string) =>
        (await db.select().from(qualificationRules).where(and(eq(qualificationRules.businessId, businessId), eq(qualificationRules.key, 'urgency'))))[0].question;
      expect(await urgency(withDefault)).toBe(NEW);
      expect(await urgency(custom)).toBe('¿Cuándo te gustaría empezar?');
    } finally {
      await handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────── Borrar un lead con cita en Google Calendar ─────────────

describe('borrar un lead con una llamada en Google Calendar', () => {
  it('borra también el evento de Google y cancela sus recordatorios (no deja el hueco ocupado)', async () => {
    const G = await registerTrainer(app, { businessName: 'Negocio Google' });
    await openAgenda(G.client);
    await saveCalendarConnection(G.businessId, G.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-de-prueba', refreshToken: 'refresh-de-prueba', expiresAt: Date.now() + 24 * 3600_000 },
      calendarId: 'primary',
    });
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        if (url.includes('/freeBusy')) return Response.json({ calendars: { primary: { busy: [] } } });
        if (method === 'POST' && url.includes('/events')) return Response.json({ id: 'ev_borrar_1' });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json({ error: { message: 'no simulado' } }, { status: 404 });
      }),
    );
    const l = await newLead(G, 'Lorena Borrada');
    const start = DateTime.now().setZone('Europe/Madrid').plus({ days: 4 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    const appt = await bookAppointment({ businessId: G.businessId, leadId: l.leadId, conversationId: l.conversationId, start, bookedBy: 'human', actor: { type: 'user', userId: G.userId } });
    expect(appt.externalEventId).toBe('ev_borrar_1');
    calls.length = 0;

    const res = await G.client.delete(`/api/leads/${l.leadId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('ev_borrar_1'))).toBe(true);
    const pending = (await getDb().select().from(scheduledJobs).where(sql`${scheduledJobs.dedupeKey} like ${`appt:${appt.id}:%`}`)).filter((j) => j.status === 'pending');
    expect(pending).toHaveLength(0);
    expect(await getDb().select().from(appointments).where(eq(appointments.id, appt.id))).toHaveLength(0);
  });
});

// ───────────── Panel ─────────────

describe('panel (dashboard)', () => {
  it('no cuenta las citas de prueba, cuenta todas las próximas (no solo 10) y «contactados» = ya les hemos escrito', async () => {
    const D = await registerTrainer(app, { businessName: 'Negocio Panel' });
    const tz = 'Europe/Madrid';
    const real = (await createLead(D.businessId, { name: 'Real', source: 'manual' }, { type: 'system' })).lead;
    const test = (await createLead(D.businessId, { name: 'Prueba', source: 'simulator', isTest: true }, { type: 'system' })).lead;
    const startOfToday = DateTime.now().setZone(tz).startOf('day');
    const appt = (leadId: string, startsAt: Date) => ({ businessId: D.businessId, leadId, title: 'Llamada', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) });
    const todayAt = startOfToday.plus({ minutes: 1 }).toJSDate();
    await getDb().insert(appointments).values([appt(real.id, todayAt), appt(test.id, new Date(todayAt.getTime() + 60_000))]);
    const upcoming = Array.from({ length: 12 }, (_, i) => appt(real.id, startOfToday.plus({ days: 2, hours: 9, minutes: i * 31 }).toJSDate()));
    await getDb().insert(appointments).values([...upcoming, appt(test.id, startOfToday.plus({ days: 3, hours: 9 }).toJSDate())]);
    await getDb().update(leads).set({ lastOutboundAt: new Date() }).where(eq(leads.id, real.id));

    const d = await getDashboard(D.businessId);
    expect(d.callsToday.map((c) => c.leadName)).toEqual(['Real']);
    expect(d.activity.callsToday).toBe(1);
    expect(d.upcoming).toHaveLength(10);
    expect(d.upcoming.every((c) => c.leadName === 'Real')).toBe(true);
    expect(d.activity.upcomingCalls).toBe(12);
    expect(d.leads.contacted).toBe(1);
  });

  it('«a punto de perderse» usa la banda «interesado» guardada por el negocio', async () => {
    const D = await registerTrainer(app, { businessName: 'Negocio Bandas' });
    const { lead } = await createLead(D.businessId, { name: 'Marina Tibia', source: 'manual' }, { type: 'system' });
    const old = new Date(Date.now() - 3 * 86_400_000);
    await getDb().update(leads).set({ score: 45, status: 'interested', createdAt: old, lastInboundAt: old }).where(eq(leads.id, lead.id));
    expect((await getDashboard(D.businessId)).attention.atRisk.map((l) => l.id)).not.toContain(lead.id);

    const bands = [
      { key: 'frio', label: 'Frío', min: 0, max: 20 },
      { key: 'curioso', label: 'Curioso', min: 21, max: 39 },
      { key: 'interesado', label: 'Interesado', min: 40, max: 70 },
      { key: 'caliente', label: 'Caliente', min: 71, max: 85 },
      { key: 'muy_cualificado', label: 'Muy cualificado', min: 86, max: 100 },
    ];
    const res = await D.client.put('/api/settings/score-bands', { bands });
    expect(res.statusCode, res.body).toBe(200);
    expect((await getDashboard(D.businessId)).attention.atRisk.map((l) => l.id)).toContain(lead.id);
  });
});

// ───────────── Calendly ─────────────

describe('Calendly: reconectar y cambiar a Google', () => {
  const TOKEN_A = 'calendly-token-AAAAAAAAAAAAAAAAAAAAAAAA';
  const TOKEN_B = 'calendly-token-BBBBBBBBBBBBBBBBBBBBBBBB';
  const BAD = 'calendly-token-INVALIDOXXXXXXXXXXXXXXXX';

  function stubCalendly() {
    const calls: { method: string; url: string; token: string }[] = [];
    let webhooks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.hostname !== 'api.calendly.com') throw new Error(`Red no permitida en tests: ${url}`);
        const method = init?.method ?? 'GET';
        const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(/^Bearer /, '');
        calls.push({ method, url: url.toString(), token });
        if (token === BAD) return jsonResponse(401, { title: 'Unauthenticated', message: 'The access token is invalid' });
        if (url.pathname === '/users/me')
          return jsonResponse(200, {
            resource: { uri: 'https://api.calendly.com/users/U1', name: 'Coach', email: 'coach@example.com', scheduling_url: 'https://calendly.com/coach', current_organization: 'https://api.calendly.com/organizations/O1', timezone: 'Europe/Madrid' },
          });
        if (url.pathname === '/event_types')
          return jsonResponse(200, { collection: [{ uri: 'https://api.calendly.com/event_types/ET1', name: 'Llamada', duration: 30, scheduling_url: 'https://calendly.com/coach/llamada', active: true }] });
        if (url.pathname === '/webhook_subscriptions' && method === 'POST') return jsonResponse(201, { resource: { uri: `https://api.calendly.com/webhook_subscriptions/W${++webhooks}` } });
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse(404, { message: 'no simulado' });
      }),
    );
    return calls;
  }

  const calendlyRow = async (businessId: string) =>
    (await getDb().select().from(calendarConnections).where(and(eq(calendarConnections.businessId, businessId), eq(calendarConnections.provider, 'calendly'))))[0];

  it('token no válido: 400 y la conexión anterior sigue intacta; token válido: borra el webhook anterior antes de crear el nuevo', async () => {
    const C = await registerTrainer(app, { businessName: 'Negocio Calendly' });
    const calls = stubCalendly();
    const first = await C.client.post('/api/integrations/calendly', { token: TOKEN_A });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().webhookError).toBeNull();
    const before = await calendlyRow(C.businessId);
    expect(before.status).toBe('connected');

    calls.length = 0;
    const bad = await C.client.post('/api/integrations/calendly', { token: BAD });
    expect(bad.statusCode).toBe(400);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0); // no se ha tocado ningún webhook
    const afterBad = await calendlyRow(C.businessId);
    expect(afterBad).toMatchObject({ status: 'connected', calendarId: before.calendarId, credentialsEnc: before.credentialsEnc });

    calls.length = 0;
    const second = await C.client.post('/api/integrations/calendly', { token: TOKEN_B });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().webhookError).toBeNull();
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url} ${c.token}`);
    expect(writes).toEqual([
      `DELETE https://api.calendly.com/webhook_subscriptions/W1 ${TOKEN_A}`,
      `POST https://api.calendly.com/webhook_subscriptions ${TOKEN_B}`,
    ]);
  });

  it('conectar Google Calendar borra el webhook de Calendly de la conexión anterior', async () => {
    const C = await registerTrainer(app, { businessName: 'Negocio Calendly a Google' });
    const calls = stubCalendly();
    expect((await C.client.post('/api/integrations/calendly', { token: TOKEN_A })).statusCode).toBe(200);
    calls.length = 0;

    await saveCalendarConnection(C.businessId, C.userId, {
      provider: 'google',
      credentials: { accessToken: 'token-google', refreshToken: 'refresh-google', expiresAt: Date.now() + 3600_000 },
      calendarId: 'primary',
    });
    expect(calls.map((c) => `${c.method} ${c.url} ${c.token}`)).toEqual([`DELETE https://api.calendly.com/webhook_subscriptions/W1 ${TOKEN_A}`]);
    expect((await calendlyRow(C.businessId)).status).toBe('disconnected');
  });
});

// ───────────── Equipo y «Crear mi negocio» ─────────────

describe('cuenta sin negocio', () => {
  it('al quitar a un miembro su sesión deja de apuntar al negocio y puede crear el suyo (una sola vez)', async () => {
    const owner = await registerTrainer(app, { businessName: 'Negocio con Equipo' });
    await setPlan(owner.businessId, 'pro');
    const email = uniqueEmail('miembro');
    const invite = await owner.client.post('/api/team/invite', { email, role: 'team_member' });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = new URL(invite.json().link as string).searchParams.get('token')!;
    const member = new ApiClient(app);
    const accepted = await member.post('/api/auth/accept-invitation', { token, name: 'Mario Miembro', password: 'Kaizen12345' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const [memberUser] = await getDb().select().from(users).where(eq(users.email, email));
    expect(json(await member.get('/api/auth/me')).activeBusinessId).toBe(owner.businessId);

    // Mientras pertenece a un negocio no puede usar «Crear mi negocio».
    const early = await member.post('/api/auth/create-business', { name: 'Mi propio negocio' });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toBe('Ya perteneces a un negocio.');

    expect((await owner.client.delete(`/api/team/members/${memberUser.id}`)).statusCode).toBe(200);
    const memberSessions = await getDb().select().from(sessions).where(eq(sessions.userId, memberUser.id));
    expect(memberSessions.length).toBeGreaterThan(0);
    expect(memberSessions.every((s) => s.activeBusinessId === null)).toBe(true);
    const me = json(await member.get('/api/auth/me'));
    expect(me.businesses).toHaveLength(0);
    expect(me.activeBusinessId).toBeNull();
    expect((await member.get('/api/settings')).statusCode).toBe(403);

    expect((await member.post('/api/auth/create-business', { name: 'X' })).statusCode).toBe(400);
    const created = await member.post('/api/auth/create-business', { name: '  Mario Fit  ', timezone: 'Atlantic/Canary' });
    expect(created.statusCode, created.body).toBe(200);
    const business = created.json().business as { id: string; name: string };
    expect(business.name).toBe('Mario Fit');
    expect(json(await member.get('/api/auth/me')).activeBusinessId).toBe(business.id);
    const settings = json(await member.get('/api/settings'));
    expect(settings.business).toMatchObject({ id: business.id, timezone: 'Atlantic/Canary', subscriptionStatus: 'trialing' });
    expect(settings.business.planId).not.toBeNull();

    // Un segundo intento (doble clic) no crea otro negocio.
    const again = await member.post('/api/auth/create-business', { name: 'Mario Fit 2' });
    expect(again.statusCode).toBe(409);
    expect(json(await member.get('/api/auth/me')).businesses).toHaveLength(1);
  });

  it('sin sesión: 401', async () => {
    const anon = new ApiClient(app);
    expect((await anon.post('/api/auth/create-business', { name: 'Negocio anónimo' })).statusCode).toBe(401);
  });
});
