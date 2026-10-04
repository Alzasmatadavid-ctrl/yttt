/**
 * Revisión nº 1 (plataforma): seguridad, webhooks, CRM, ajustes, administración y analítica.
 * Cada bloque demuestra un fallo corregido. Ninguna petición sale a la red (fetch simulado).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import {
  alerts,
  auditLogs,
  conversations,
  errorLogs,
  leads,
  messages,
  scheduledJobs,
  services,
  users,
  webhookEvents,
} from '../../src/database/schema.js';
import { buildApp } from '../../src/app.js';
import { env, PRIVATE_PROXIES, startupWarnings } from '../../src/config/env.js';
import { ensureAdminAccount } from '../../src/database/bootstrap.js';
import { consoleEmail, sendEmail } from '../../src/integrations/email/email.service.js';
import { settleBackgroundTasks } from '../../src/lib/background.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation, insertMessage } from '../../src/crm/conversations.service.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import { triggerHandoff } from '../../src/crm/handoff.service.js';
import { receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { retryFailedLeadgenEvents } from '../../src/webhooks/meta.webhook.js';
import { scheduleJob } from '../../src/automation/jobs.js';
import { getUsage, incrementUsage } from '../../src/plans/plans.service.js';
import { getFunnel } from '../../src/analytics/analytics.service.js';
import { getInsights } from '../../src/analytics/insights.js';
import { OVER_LIMIT_TAG } from '../../src/lib/domain.js';
import {
  ApiClient,
  json,
  makePlatformAdmin,
  registerTrainer,
  setPlan,
  setupTestApp,
  teardownTestApp,
  uniqueEmail,
  type Trainer,
} from './helpers.js';

const APP_SECRET = 'test-app-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

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

function postMeta(payload: unknown) {
  const body = JSON.stringify(payload);
  return app.inject({ method: 'POST', url: '/api/webhooks/meta', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
}

/** Simula `fetch`: las llamadas a graph.facebook.com las responde `graph`; cualquier otra red falla. */
function mockGraph(graph: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'graph.facebook.com' || url.hostname === 'graph.instagram.com') {
      calls.push(url.pathname);
      return graph(url, init);
    }
    throw new Error(`Red no permitida en tests: ${url}`);
  });
  return calls;
}

const graphJson = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function connectChannel(t: Trainer, channel: 'whatsapp' | 'instagram' | 'meta_lead_ads', externalAccountId: string, extra: Record<string, unknown> = {}) {
  const res = await t.client.post('/api/integrations/channels', {
    channel,
    externalAccountId,
    accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
    skipVerification: true,
    ...extra,
  });
  return res;
}

// ───────────────────────── Administración de la plataforma ─────────────────────────

describe('cuenta de administración (ADMIN_EMAIL)', () => {
  const saved = { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, promote: env.ADMIN_PROMOTE_EXISTING };
  afterEach(() => {
    env.ADMIN_EMAIL = saved.email;
    env.ADMIN_PASSWORD = saved.password;
    env.ADMIN_PROMOTE_EXISTING = saved.promote;
  });

  it('registrarse con el email de ADMIN_EMAIL NO da acceso al panel /admin', async () => {
    const adminEmail = uniqueEmail('owner');
    env.ADMIN_EMAIL = adminEmail;
    env.ADMIN_PASSWORD = undefined;
    const intruder = await registerTrainer(app, { email: adminEmail });
    expect(json(await intruder.client.get('/api/auth/me')).user.platformRole).toBe('user');
    expect((await intruder.client.get('/api/admin/users')).statusCode).toBe(403);

    // El arranque tampoco asciende a esa cuenta ya existente…
    expect(await ensureAdminAccount()).toBe('not_promoted');
    expect(json(await intruder.client.get('/api/auth/me')).user.platformRole).toBe('user');

    // …salvo que el propietario lo pida expresamente.
    env.ADMIN_PROMOTE_EXISTING = true;
    expect(await ensureAdminAccount()).toBe('promoted');
    expect(json(await intruder.client.get('/api/auth/me')).user.platformRole).toBe('admin');
  });

  it('con ADMIN_PASSWORD crea la cuenta de administración al arrancar', async () => {
    const adminEmail = uniqueEmail('propietario');
    env.ADMIN_EMAIL = adminEmail;
    env.ADMIN_PASSWORD = 'ClaveAdmin2026';
    expect(await ensureAdminAccount()).toBe('created');
    expect(await ensureAdminAccount()).toBe('exists');
    const admin = new ApiClient(app);
    expect((await admin.post('/api/auth/login', { email: adminEmail, password: 'ClaveAdmin2026' })).statusCode).toBe(200);
    expect(json(await admin.get('/api/auth/me')).user.platformRole).toBe('admin');
  });

  it('con una ADMIN_PASSWORD débil no se crea la cuenta y se avisa', async () => {
    env.ADMIN_EMAIL = uniqueEmail('debil');
    env.ADMIN_PASSWORD = 'admin123';
    expect(await ensureAdminAccount()).toBe('weak_password');
    expect(await getDb().select().from(users).where(eq(users.email, env.ADMIN_EMAIL!.toLowerCase()))).toHaveLength(0);
    expect(startupWarnings().some((w) => w.includes('ADMIN_PASSWORD'))).toBe(true);
  });

  it('sin ADMIN_PASSWORD no se crea nada', async () => {
    env.ADMIN_EMAIL = uniqueEmail('sinclave');
    env.ADMIN_PASSWORD = undefined;
    expect(await ensureAdminAccount()).toBe('missing_password');
    expect(await getDb().select().from(users).where(eq(users.email, env.ADMIN_EMAIL!.toLowerCase()))).toHaveLength(0);
  });
});

// ───────────────────────── IP real y límites de peticiones ─────────────────────────

describe('límites de peticiones: la IP no se puede falsificar', () => {
  const login = (target: FastifyInstance, remoteAddress: string, xff: string, email = uniqueEmail('xff')) =>
    target.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress,
      headers: { 'x-requested-with': 'kai', 'content-type': 'application/json', 'x-forwarded-for': xff },
      payload: JSON.stringify({ email, password: 'ClaveIncorrecta1' }),
    });

  it('sin proxy de confianza, cambiar X-Forwarded-For no evita el límite de login', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(app, '203.0.113.7', `9.9.9.${i}`)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('detrás de un proxy de confianza se usa la IP que añade el proxy (no la que inventa el cliente)', async () => {
    const proxied = await buildApp({ trustProxy: PRIVATE_PROXIES });
    await proxied.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await login(proxied, '10.1.2.3', `9.9.8.${i}, 198.51.100.20`)).statusCode);
      expect(codes.slice(10)).toEqual([429, 429]);
      // Otro visitante real detrás del mismo proxy no queda bloqueado.
      expect((await login(proxied, '10.1.2.3', '9.9.8.200, 198.51.100.21')).statusCode).toBe(401);
      // Un cliente que llega directo (IP pública) no puede hacerse pasar por otro con la cabecera.
      const direct: number[] = [];
      for (let i = 0; i < 11; i++) direct.push((await login(proxied, '203.0.113.99', `198.51.100.${30 + i}`)).statusCode);
      expect(direct[10]).toBe(429);
    } finally {
      await proxied.close();
    }
  });

  it('tras 10 contraseñas incorrectas, la cuenta se bloquea un rato aunque cada intento venga de otra IP', async () => {
    const t = await registerTrainer(app);
    for (let i = 0; i < 10; i++) {
      expect((await new ApiClient(app).post('/api/auth/login', { email: t.email, password: `Incorrecta${i}x` })).statusCode).toBe(401);
    }
    const blocked = await new ApiClient(app).post('/api/auth/login', { email: t.email, password: t.password });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().message).toMatch(/Demasiados intentos/);
    // Otra cuenta no se ve afectada.
    const other = await registerTrainer(app);
    expect((await new ApiClient(app).post('/api/auth/login', { email: other.email, password: other.password })).statusCode).toBe(200);
  });
});

// ───────────────────────── Recuperación de contraseña ─────────────────────────

describe('restablecer contraseña', () => {
  const tokensFor = (email: string) =>
    consoleEmail.outbox.filter((m) => m.to === email.toLowerCase()).map((m) => decodeURIComponent(/[?&]token=([^\s&]+)/.exec(m.text)![1]));

  it('al restablecer, los demás enlaces pendientes dejan de servir', async () => {
    const t = await registerTrainer(app);
    const anon = new ApiClient(app);
    await anon.post('/api/auth/forgot-password', { email: t.email });
    await anon.post('/api/auth/forgot-password', { email: t.email });
    await settleBackgroundTasks();
    const [first, second] = tokensFor(t.email);
    expect(first && second && first !== second).toBe(true);
    expect((await anon.post('/api/auth/reset-password', { token: second, password: 'NuevaClave2026' })).statusCode).toBe(200);
    const old = await anon.post('/api/auth/reset-password', { token: first, password: 'OtraClave20261' });
    expect(old.statusCode).toBe(400);
  });

  it('dos peticiones simultáneas con el mismo enlace: solo una lo usa', async () => {
    const t = await registerTrainer(app);
    await new ApiClient(app).post('/api/auth/forgot-password', { email: t.email });
    await settleBackgroundTasks();
    const [token] = tokensFor(t.email);
    const results = await Promise.all([
      new ApiClient(app).post('/api/auth/reset-password', { token, password: 'ClaveCarreraA2026' }),
      new ApiClient(app).post('/api/auth/reset-password', { token, password: 'ClaveCarreraB2026' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it('cambiar la contraseña invalida los enlaces de restablecimiento pendientes', async () => {
    const t = await registerTrainer(app);
    await new ApiClient(app).post('/api/auth/forgot-password', { email: t.email });
    await settleBackgroundTasks();
    const [token] = tokensFor(t.email);
    const changed = await t.client.post('/api/auth/change-password', { currentPassword: t.password, newPassword: 'CambiadaAMano2026' });
    expect(changed.statusCode).toBe(200);
    expect((await new ApiClient(app).post('/api/auth/reset-password', { token, password: 'DesdeEnlace2026' })).statusCode).toBe(400);
  });

  it('no envía más de 3 emails por hora a la misma dirección (la respuesta es la misma)', async () => {
    const t = await registerTrainer(app);
    for (let i = 0; i < 5; i++) {
      const res = await new ApiClient(app).post('/api/auth/forgot-password', { email: t.email });
      expect(res.statusCode).toBe(200);
    }
    await settleBackgroundTasks();
    expect(tokensFor(t.email)).toHaveLength(3);
  });
});

// ───────────────────────── Email en producción ─────────────────────────

describe('email en producción sin proveedor configurado', () => {
  it('no se “envía” por consola (los enlaces con token no acaban en los registros) y se informa del fallo', async () => {
    const before = consoleEmail.outbox.length;
    const savedEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const ok = await sendEmail({ to: 'alguien@example.com', subject: 'Prueba', text: 'enlace https://x/restablecer?token=secreto' });
      expect(ok).toBe(false);
    } finally {
      env.NODE_ENV = savedEnv;
    }
    expect(consoleEmail.outbox.length).toBe(before);
    const [log] = await getDb().select().from(errorLogs).where(eq(errorLogs.source, 'email.send'));
    expect(log.message).toMatch(/no está configurado/);
    expect(JSON.stringify(log.context)).not.toContain('secreto');
  });
});

// ───────────────────────── Meta Lead Ads ─────────────────────────

describe('Meta Lead Ads: un fallo puntual de Meta no pierde el lead', () => {
  const PAGE_ID = '555000111222';
  let T: Trainer;

  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Lead Ads' });
    expect((await connectChannel(T, 'meta_lead_ads', PAGE_ID)).statusCode).toBe(200);
  });

  const leadgenPayload = (leadgenId: string) => ({
    object: 'page',
    entry: [{ id: PAGE_ID, time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: PAGE_ID, form_id: '777' } }] }],
  });
  const leadData = (id: string, email: string) => ({
    id,
    campaign_name: 'Campaña otoño',
    field_data: [
      { name: 'full_name', values: ['Lucía Anuncio'] },
      { name: 'email', values: [email] },
    ],
  });
  const eventFor = async (leadgenId: string) =>
    (await getDb().select().from(webhookEvents).where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.externalId, leadgenId))))[0];

  it('si Meta falla, responde con error (Meta reenvía), avisa al entrenador y al reenvío se recupera el lead', async () => {
    let fail = true;
    const calls = mockGraph(() => (fail ? graphJson(503, { error: { message: 'Service temporarily unavailable', code: 2 } }) : graphJson(200, leadData('9001', 'lucia.ads@example.com'))));

    const first = await postMeta(leadgenPayload('9001'));
    expect(first.statusCode).toBe(500);
    expect(calls).toHaveLength(1);
    expect((await eventFor('9001')).status).toBe('failed');
    expect(await getDb().select().from(leads).where(eq(leads.email, 'lucia.ads@example.com'))).toHaveLength(0);
    const [alert] = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.businessId, T.businessId), eq(alerts.type, 'integration_error'), eq(alerts.status, 'open')));
    expect(alert.title).toMatch(/Lead Ads/);
    expect(alert.body).toContain('9001');

    fail = false;
    const second = await postMeta(leadgenPayload('9001'));
    expect(second.statusCode).toBe(200);
    expect(calls).toHaveLength(2); // se vuelve a pedir a Meta
    expect((await eventFor('9001')).status).toBe('processed');
    const [lead] = await getDb().select().from(leads).where(eq(leads.email, 'lucia.ads@example.com'));
    expect(lead).toMatchObject({ businessId: T.businessId, source: 'meta_ads', name: 'Lucía Anuncio' });

    // Un tercer aviso del mismo lead ya no hace nada (deduplicado).
    expect((await postMeta(leadgenPayload('9001'))).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('el mantenimiento reintenta los avisos fallidos aunque Meta no los reenvíe', async () => {
    let fail = true;
    mockGraph(() => (fail ? graphJson(500, { error: { message: 'Unknown error', code: 1 } }) : graphJson(200, leadData('9002', 'mario.ads@example.com'))));
    expect((await postMeta(leadgenPayload('9002'))).statusCode).toBe(500);
    expect((await eventFor('9002')).status).toBe('failed');

    fail = false;
    const result = await retryFailedLeadgenEvents();
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect((await eventFor('9002')).status).toBe('processed');
    expect(await getDb().select().from(leads).where(eq(leads.email, 'mario.ads@example.com'))).toHaveLength(1);
  });
});

// ───────────────────────── Mensajes simultáneos de un contacto nuevo ─────────────────────────

describe('varios mensajes a la vez de un contacto nuevo', () => {
  it('se guardan todos en un único lead (antes solo se guardaba el primero)', async () => {
    const T = await registerTrainer(app);
    const waId = '34611000999';
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        receiveInboundMessage({
          businessId: T.businessId,
          channel: 'whatsapp',
          externalMessageId: `wamid.carrera.${i}`,
          text: `mensaje ${i}`,
          profile: { name: 'Carrera', whatsappId: waId, phone: `+${waId}` },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const rows = await getDb()
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, waId)));
    expect(rows).toHaveLength(1);
    const msgs = await getDb().select().from(messages).where(eq(messages.leadId, rows[0].id));
    expect(msgs.map((m) => m.content).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `mensaje ${i}`).sort());
    // El cupo de leads solo cuenta uno.
    expect((await getUsage(T.businessId)).leads).toBe(1);
  });

  it('el mismo mensaje entregado varias veces a la vez se guarda una sola vez (sin errores)', async () => {
    const T = await registerTrainer(app);
    const input = { businessId: T.businessId, channel: 'whatsapp' as const, externalMessageId: 'wamid.doble', text: 'hola', profile: { whatsappId: '34622000111' } };
    const results = await Promise.all([receiveInboundMessage(input), receiveInboundMessage(input), receiveInboundMessage(input)]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await getDb().select().from(messages).where(eq(messages.externalId, 'wamid.doble'))).toHaveLength(1);
    // Una entrega posterior también se reconoce como repetida.
    expect((await receiveInboundMessage(input)).duplicate).toBe(true);
  });
});

// ───────────────────────── Formulario público ─────────────────────────

describe('formulario público: protecciones anti-abuso', () => {
  let T: Trainer;
  let publicKey = '';
  const postForm = (payload: unknown) => new ApiClient(app).post(`/api/public/forms/${publicKey}`, payload, { csrf: false });

  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Formulario' });
    publicKey = json(await T.client.get('/api/integrations')).endpoints.publicKey;
    expect((await connectChannel(T, 'whatsapp', '106540352200001')).statusCode).toBe(200);
  });

  it('sin consentimiento expreso para WhatsApp no se escribe al número (se guarda el lead igualmente)', async () => {
    expect((await postForm({ name: 'Sin Casilla', phone: '600 777 001' })).statusCode).toBe(200);
    const [lead] = await getDb()
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, T.businessId), eq(leads.name, 'Sin Casilla')));
    expect(lead).toBeDefined();
    expect(await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `first_contact:${lead.id}`))).toHaveLength(0);
  });

  it('“extra” admite como máximo 20 campos', async () => {
    const extra = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`campo${i}`, 'x']));
    expect((await postForm({ name: 'Muchos Campos', email: 'muchos.campos@example.com', extra })).statusCode).toBe(400);
  });

  it('limita los leads nuevos por negocio aunque lleguen desde muchas IPs distintas', async () => {
    const saved = env.PUBLIC_FORM_MAX_PER_HOUR;
    env.PUBLIC_FORM_MAX_PER_HOUR = 3; // ya hay 1 lead del formulario en este negocio
    try {
      expect((await postForm({ name: 'Uno', email: 'cupo.uno@example.com' })).statusCode).toBe(200);
      expect((await postForm({ name: 'Dos', email: 'cupo.dos@example.com' })).statusCode).toBe(200);
      const blocked = await postForm({ name: 'Tres', email: 'cupo.tres@example.com' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().message).toMatch(/no podemos recibir más solicitudes/);
      expect(await getDb().select().from(leads).where(eq(leads.email, 'cupo.tres@example.com'))).toHaveLength(0);
      const open = await getDb()
        .select()
        .from(alerts)
        .where(and(eq(alerts.businessId, T.businessId), eq(alerts.title, 'Tu formulario web está recibiendo demasiados envíos')));
      expect(open).toHaveLength(1);
      // Un segundo bloqueo no duplica el aviso.
      expect((await postForm({ name: 'Cuatro', email: 'cupo.cuatro@example.com' })).statusCode).toBe(429);
      expect(
        await getDb()
          .select()
          .from(alerts)
          .where(and(eq(alerts.businessId, T.businessId), eq(alerts.title, 'Tu formulario web está recibiendo demasiados envíos'))),
      ).toHaveLength(1);
    } finally {
      env.PUBLIC_FORM_MAX_PER_HOUR = saved;
    }
  });
});

// ───────────────────────── Ajustes y planes: ediciones parciales ─────────────────────────

describe('ediciones parciales sin machacar campos', () => {
  it('PATCH de un servicio solo cambia lo enviado', async () => {
    const T = await registerTrainer(app);
    const created = await T.client.post('/api/settings/services', {
      name: 'Plan Premium',
      priceCents: 20000,
      billingPeriod: 'monthly',
      currency: 'USD',
      includes: ['A', 'B'],
      description: 'Desc larga',
      isPrimary: true,
      isActive: false,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().service.id;
    const patched = await T.client.patch(`/api/settings/services/${id}`, { priceCents: 25000 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().service).toMatchObject({ priceCents: 25000, currency: 'USD', includes: ['A', 'B'], description: 'Desc larga', isPrimary: true, isActive: false });
  });

  it('PUT del servicio principal no le quita la marca de principal ni otros datos', async () => {
    const T = await registerTrainer(app);
    await T.client.put('/api/settings/primary-service', { name: 'Asesoría online', priceCents: 15000, includes: ['Rutina'], currency: 'USD' });
    const res = await T.client.put('/api/settings/primary-service', { name: 'Asesoría online 2.0', isPrimary: false });
    expect(res.statusCode).toBe(200);
    const rows = await getDb().select().from(services).where(eq(services.businessId, T.businessId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Asesoría online 2.0', isPrimary: true, priceCents: 15000, includes: ['Rutina'], currency: 'USD' });
  });

  it('PATCH de un plan en /admin conserva la moneda y lo no enviado', async () => {
    const admin = await registerTrainer(app);
    await makePlatformAdmin(admin.userId);
    const created = await admin.client.post('/api/admin/plans', {
      key: `p${Date.now().toString(36)}`,
      name: 'Plan dólares',
      priceMonthlyCents: 5000,
      currency: 'USD',
      isPublic: false,
      sortOrder: 7,
      limits: { maxLeadsPerMonth: 10, maxAiMessagesPerMonth: 100, maxTeamMembers: 1, maxChannels: 1, maxBusinesses: 1, copilot: false, advancedAnalytics: false },
    });
    expect(created.statusCode, created.body).toBe(200);
    const patched = await admin.client.patch(`/api/admin/plans/${created.json().plan.id}`, { name: 'Plan dólares v2' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().plan).toMatchObject({ name: 'Plan dólares v2', currency: 'USD', isPublic: false, sortOrder: 7 });
  });
});

// ───────────────────────── CRM ─────────────────────────

describe('leads: asignación y límite del plan', () => {
  it('solo se puede asignar un lead a alguien del equipo del negocio', async () => {
    const A = await registerTrainer(app);
    const B = await registerTrainer(app);
    const lead = json(await A.client.post('/api/leads', { name: 'Lead Asignable' })).lead;
    const foreign = await A.client.patch(`/api/leads/${lead.id}`, { assignedUserId: B.userId });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toMatch(/equipo/);
    const own = await A.client.patch(`/api/leads/${lead.id}`, { assignedUserId: A.userId });
    expect(own.statusCode).toBe(200);
    expect(own.json().lead.assignedUserId).toBe(A.userId);
    expect((await A.client.patch(`/api/leads/${lead.id}`, { assignedUserId: null })).json().lead.assignedUserId).toBeNull();
  });

  it('la etiqueta “fuera de límite” no se puede quitar mientras el negocio siga por encima del límite', async () => {
    const T = await registerTrainer(app);
    await incrementUsage(T.businessId, 'leads', 150); // límite del plan Starter
    const { lead } = await createLead(T.businessId, { name: 'Lead de más', source: 'manual' }, { type: 'user', userId: T.userId });
    expect(lead.tags).toContain(OVER_LIMIT_TAG);

    const res = await T.client.patch(`/api/leads/${lead.id}`, { tags: ['vip'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().lead.tags).toEqual(['vip', OVER_LIMIT_TAG]);

    // Con un plan sin límite de leads, ya se puede liberar.
    await setPlan(T.businessId, 'agency');
    expect((await T.client.patch(`/api/leads/${lead.id}`, { tags: ['vip'] })).json().lead.tags).toEqual(['vip']);
  });
});

describe('bajas (“no me escribáis más”)', () => {
  it('con KAI pausado, la baja se registra igualmente y se cancelan recordatorios y seguimientos', async () => {
    const T = await registerTrainer(app);
    const first = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', externalMessageId: 'wamid.baja.1', text: 'Hola', profile: { whatsappId: '34633000111' } });
    if (first.duplicate) throw new Error('inesperado');
    const conversationId = first.conversation.id;
    const leadId = first.lead.id;
    expect((await T.client.post(`/api/conversations/${conversationId}/take-over`)).statusCode).toBe(200);
    const reminder = await scheduleJob({ businessId: T.businessId, type: 'appointment_reminder', runAt: new Date(Date.now() + 86_400_000), payload: { appointmentId: randomUUID(), leadId, kind: '24h' } });
    const postCall = await scheduleJob({ businessId: T.businessId, type: 'post_call', runAt: new Date(Date.now() + 86_400_000), payload: { appointmentId: randomUUID(), leadId } });

    await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', externalMessageId: 'wamid.baja.2', text: 'Dejad de escribirme, por favor', profile: { whatsappId: '34633000111' } });

    const [lead] = await getDb().select().from(leads).where(eq(leads.id, leadId));
    expect(lead.optedOut).toBe(true);
    const jobStatus = async (id: string) => (await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.id, id)))[0].status;
    expect(await jobStatus(reminder.id)).toBe('cancelled');
    expect(await jobStatus(postCall.id)).toBe('pending'); // el aviso post-llamada es para el entrenador
    const [alert] = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.leadId, leadId), eq(alerts.type, 'delivery_blocked')));
    expect(alert.title).toMatch(/no recibir más mensajes/);
    // Ni el entrenador puede escribirle ya.
    const send = await T.client.post(`/api/conversations/${conversationId}/messages`, { text: '¿Seguro?' });
    expect(send.json().delivered).toBe(false);
  });

  it('con KAI activo no se adelanta: la baja la gestiona KAI al responder', async () => {
    const T = await registerTrainer(app);
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', externalMessageId: 'wamid.baja.3', text: 'Dame de baja', profile: { whatsappId: '34633000222' } });
    if (r.duplicate) throw new Error('inesperado');
    expect((await getDb().select().from(leads).where(eq(leads.id, r.lead.id)))[0].optedOut).toBe(false);
    const jobs = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `reply:${r.conversation.id}`));
    expect(jobs).toHaveLength(1);
  });

  it('baja y alta manuales desde la ficha del lead, con auditoría', async () => {
    const T = await registerTrainer(app);
    const lead = json(await T.client.post('/api/leads', { name: 'Pidió la baja por teléfono' })).lead;
    const out = await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: true, reason: 'Lo pidió por teléfono' });
    expect(out.statusCode).toBe(200);
    expect(out.json().lead.optedOut).toBe(true);
    const back = await T.client.post(`/api/leads/${lead.id}/opt-out`, { optedOut: false });
    expect(back.json().lead.optedOut).toBe(false);
    const logs = await getDb().select().from(auditLogs).where(and(eq(auditLogs.businessId, T.businessId), eq(auditLogs.entityId, lead.id)));
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['lead.opted_out', 'lead.opted_in']));
  });
});

describe('escalados atendidos por el entrenador', () => {
  async function escalated(T: Trainer, name: string) {
    const { lead } = await createLead(T.businessId, { name, source: 'manual' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    await insertMessage({ businessId: T.businessId, conversationId: conv.id, leadId: lead.id, direction: 'inbound', senderType: 'lead', content: 'Tengo una lesión de rodilla' });
    await triggerHandoff(T.businessId, conv.id, 'medical');
    return { lead, conv };
  }

  it('al contestar el entrenador, deja de estar pendiente y se cierra el aviso, pero KAI sigue pausado', async () => {
    const T = await registerTrainer(app);
    const { lead, conv } = await escalated(T, 'Lead Escalado');
    expect(json(await T.client.get('/api/inbox')).counts.pending).toBe(1);

    const res = await T.client.post(`/api/conversations/${conv.id}/messages`, { text: 'Hola, te escribo yo personalmente.' });
    expect(res.json().delivered).toBe(true);
    const [after] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ handoffActive: false, aiEnabled: false });
    const open = await getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.leadId, lead.id), eq(alerts.type, 'handoff'), eq(alerts.status, 'open')));
    expect(open).toHaveLength(0);
    expect(json(await T.client.get('/api/inbox')).counts.pending).toBe(0);
  });

  it('«Marcar como atendido» cierra el escalado sin devolverlo a KAI', async () => {
    const T = await registerTrainer(app);
    const { conv } = await escalated(T, 'Lead Atendido');
    const res = await T.client.post(`/api/conversations/${conv.id}/handoff-attended`);
    expect(res.json()).toEqual({ ok: true, changed: true });
    const [after] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ handoffActive: false, aiEnabled: false });
    expect(json(await T.client.post(`/api/conversations/${conv.id}/handoff-attended`)).changed).toBe(false);
  });
});

// ───────────────────────── Simulador y analítica ─────────────────────────

describe('simulador y métricas', () => {
  it('los mensajes de KAI a leads de prueba no consumen el cupo del plan', async () => {
    const T = await registerTrainer(app);
    const test = await createLead(T.businessId, { name: 'Prueba', source: 'simulator', isTest: true }, { type: 'user', userId: T.userId });
    const testConv = await getOrCreateConversation(T.businessId, test.lead.id, 'web');
    await sendMessage({ businessId: T.businessId, conversationId: testConv.id, text: 'Hola desde KAI', sender: { type: 'kai' }, purpose: 'reply' });
    expect((await getUsage(T.businessId)).ai_messages).toBe(0);

    const real = await createLead(T.businessId, { name: 'Real', source: 'manual' }, { type: 'user', userId: T.userId });
    const realConv = await getOrCreateConversation(T.businessId, real.lead.id, 'web');
    await sendMessage({ businessId: T.businessId, conversationId: realConv.id, text: 'Hola desde KAI', sender: { type: 'kai' }, purpose: 'reply' });
    expect((await getUsage(T.businessId)).ai_messages).toBe(1);
  });

  it('las objeciones de conversaciones de prueba no entran en las recomendaciones', async () => {
    const T = await registerTrainer(app);
    const range = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };
    const test = await createLead(T.businessId, { name: 'Prueba', source: 'simulator', isTest: true }, { type: 'user', userId: T.userId });
    const testConv = await getOrCreateConversation(T.businessId, test.lead.id, 'web');
    await getDb()
      .update(conversations)
      .set({ state: { objectionsHandled: ['expensive', 'expensive', 'no_time'] }, updatedAt: new Date() })
      .where(eq(conversations.id, testConv.id));
    let insights = await getInsights(T.businessId, range, await getFunnel(T.businessId, range), []);
    expect(insights.map((i) => i.key)).not.toContain('top_objection');

    const real = await createLead(T.businessId, { name: 'Real', source: 'manual' }, { type: 'user', userId: T.userId });
    const realConv = await getOrCreateConversation(T.businessId, real.lead.id, 'web');
    await getDb()
      .update(conversations)
      .set({ state: { objectionsHandled: ['expensive', 'expensive', 'no_time'] }, updatedAt: new Date() })
      .where(eq(conversations.id, realConv.id));
    insights = await getInsights(T.businessId, range, await getFunnel(T.businessId, range), []);
    expect(insights.map((i) => i.key)).toContain('top_objection');
  });

  it('«Respondieron» solo cuenta a quien contesta DESPUÉS de nuestro primer mensaje', async () => {
    const T = await registerTrainer(app);
    const base = Date.now() - 3600_000;
    const at = (min: number) => new Date(base + min * 60_000);
    async function leadWith(name: string, thread: ('in' | 'out')[]) {
      const { lead } = await createLead(T.businessId, { name, source: 'instagram' }, { type: 'lead' });
      const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
      for (const [i, d] of thread.entries()) {
        await insertMessage({
          businessId: T.businessId,
          conversationId: conv.id,
          leadId: lead.id,
          direction: d === 'in' ? 'inbound' : 'outbound',
          senderType: d === 'in' ? 'lead' : 'kai',
          content: `${d} ${i}`,
          createdAt: at(i + 1),
        });
      }
    }
    await leadWith('Escribió y no contestó', ['in', 'out']);
    await leadWith('Escribió y contestó', ['in', 'out', 'in']);
    await leadWith('Formulario y contestó', ['out', 'in']);
    await leadWith('Sin contactar', []);
    const funnel = await getFunnel(T.businessId, { from: new Date(Date.now() - 2 * 3600_000), to: new Date(Date.now() + 60_000) });
    expect(funnel.leads).toBe(4);
    expect(funnel.contacted).toBe(3);
    expect(funnel.responded).toBe(2);
    expect(funnel.rates.response).toBe(50);
  });
});

// ───────────────────────── Canales ─────────────────────────

describe('cambiar la cuenta de un canal con el plan al límite', () => {
  it('se puede sustituir el número de WhatsApp sin desconectarlo antes a mano', async () => {
    const T = await registerTrainer(app); // Starter: 2 canales
    const wa = (await connectChannel(T, 'whatsapp', '106540352200101')).json().connection;
    expect((await connectChannel(T, 'instagram', '178414000000101')).statusCode).toBe(200);

    const full = await connectChannel(T, 'whatsapp', '106540352200102');
    expect(full.statusCode).toBe(400);
    expect(full.json().message).toMatch(/Tu plan permite 2/);

    const replaced = await connectChannel(T, 'whatsapp', '106540352200102', { replacesConnectionId: wa.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const list = json(await T.client.get('/api/integrations')).channels as { id: string; externalAccountId: string }[];
    expect(list.map((c) => c.externalAccountId).sort()).toEqual(['106540352200102', '178414000000101']);

    // Solo se puede sustituir por una cuenta del mismo canal.
    const ig = list.find((c) => c.externalAccountId === '178414000000101')!;
    expect((await connectChannel(T, 'whatsapp', '106540352200103', { replacesConnectionId: ig.id })).statusCode).toBe(400);
  });
});

// ───────────────────────── Errores de Meta comprensibles ─────────────────────────

describe('fallos de envío explicados en español', () => {
  it('un rechazo de WhatsApp se guarda con un motivo claro (y el técnico queda en el registro de errores)', async () => {
    const T = await registerTrainer(app);
    const conn = (await connectChannel(T, 'whatsapp', '106540352200201')).json().connection;
    const r = await receiveInboundMessage({
      businessId: T.businessId,
      channel: 'whatsapp',
      channelConnectionId: conn.id,
      externalMessageId: 'wamid.err.1',
      text: 'Hola',
      profile: { whatsappId: '34644000111', phone: '+34644000111' },
    });
    if (r.duplicate) throw new Error('inesperado');
    mockGraph(() => graphJson(400, { error: { message: '(#131026) Message Undeliverable.', code: 131026 } }));
    const res = await T.client.post(`/api/conversations/${r.conversation.id}/messages`, { text: 'Hola, soy el entrenador' });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(false);
    expect(res.json().blockedReason).toMatch(/no tiene WhatsApp/);
    expect(res.json().message.error).not.toMatch(/Undeliverable|Graph API/);
    const logs = await getDb().select().from(errorLogs).where(and(eq(errorLogs.businessId, T.businessId), eq(errorLogs.source, 'channel.send')));
    expect(logs.some((l) => l.message.includes('131026'))).toBe(true);
  });

  it('los avisos de entrega fallida de WhatsApp también se traducen', async () => {
    const T = await registerTrainer(app);
    const PHONE_ID = '106540352200301';
    const conn = (await connectChannel(T, 'whatsapp', PHONE_ID)).json().connection;
    const r = await receiveInboundMessage({ businessId: T.businessId, channel: 'whatsapp', channelConnectionId: conn.id, externalMessageId: 'wamid.err.2', text: 'Hola', profile: { whatsappId: '34644000222' } });
    if (r.duplicate) throw new Error('inesperado');
    await insertMessage({ businessId: T.businessId, conversationId: r.conversation.id, leadId: r.lead.id, direction: 'outbound', senderType: 'kai', content: 'Hola!', externalId: 'wamid.out.err.2' });
    const res = await postMeta({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: 'wamid.out.err.2', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] },
            },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const [msg] = await getDb().select().from(messages).where(eq(messages.externalId, 'wamid.out.err.2'));
    expect(msg.status).toBe('failed');
    expect(msg.error).toMatch(/24 h/);
    expect(msg.error).not.toMatch(/Re-engagement/);
  });
});

// ───────────────────────── Auditoría del panel de administración ─────────────────────────

describe('panel de administración', () => {
  it('abrir el detalle de un negocio (que muestra fragmentos de conversaciones) queda auditado', async () => {
    const admin = await registerTrainer(app);
    await makePlatformAdmin(admin.userId);
    const T = await registerTrainer(app);
    const res = await admin.client.get(`/api/admin/businesses/${T.businessId}`);
    expect(res.statusCode).toBe(200);
    const logs = await getDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, T.businessId), eq(auditLogs.action, 'admin.business_viewed')));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: 'admin', actorUserId: admin.userId });
  });
});
