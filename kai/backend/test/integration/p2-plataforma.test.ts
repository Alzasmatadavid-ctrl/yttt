import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { alerts, conversations, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { env } from '../../src/config/env.js';
import { handleMetaWebhook } from '../../src/webhooks/meta.webhook.js';
import { receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { runFirstContact, runSetterReply } from '../../src/ai/setter/setter-engine.js';
import { receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import { ApiClient, futureLocal, makePlatformAdmin, registerTrainer, setPlan, setupTestApp, teardownTestApp } from './helpers.js';

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

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

describe('Invitaciones: no sirven para adivinar contraseñas', () => {
  it('los fallos al aceptar cuentan para el límite de inicio de sesión de esa cuenta', async () => {
    const attacker = await registerTrainer(app, { businessName: 'Negocio Atacante' });
    await setPlan(attacker.businessId, 'pro');
    const victim = await registerTrainer(app, { businessName: 'Negocio Víctima' });

    const inv = await attacker.client.post('/api/team/invite', { email: victim.email, role: 'trainer' });
    expect(inv.statusCode).toBe(200);
    const token = tokenOf(inv.json().link);

    // Cada intento desde una IP distinta (esquiva el límite por IP de la ruta).
    for (let i = 0; i < 10; i++) {
      const r = await new ApiClient(app).post('/api/auth/accept-invitation', { token, password: `Prueba${i}12345` });
      expect(r.statusCode).toBe(401);
    }
    // Ya no se puede seguir probando, ni siquiera con la contraseña buena…
    const blocked = await new ApiClient(app).post('/api/auth/accept-invitation', { token, password: victim.password });
    expect(blocked.statusCode).toBe(429);
    // …y el inicio de sesión normal de esa cuenta también queda frenado.
    const login = await new ApiClient(app).post('/api/auth/login', { email: victim.email, password: victim.password });
    expect(login.statusCode).toBe(429);
  });

  it('una cuenta de administración de la plataforma no puede unirse a un negocio', async () => {
    const owner = await registerTrainer(app);
    await setPlan(owner.businessId, 'pro');
    const admin = await registerTrainer(app);
    await makePlatformAdmin(admin.userId);
    const inv = await owner.client.post('/api/team/invite', { email: admin.email, role: 'trainer' });
    expect(inv.statusCode).toBe(200);
    const res = await new ApiClient(app).post('/api/auth/accept-invitation', { token: tokenOf(inv.json().link), password: admin.password });
    expect(res.statusCode).toBe(403);
  });

  it('sin proveedor de email real, el enlace se devuelve para copiarlo', async () => {
    const owner = await registerTrainer(app);
    await setPlan(owner.businessId, 'pro');
    const inv = await owner.client.post('/api/team/invite', { email: `nuevo.${Date.now()}@example.com`, role: 'team_member' });
    expect(inv.json()).toMatchObject({ emailed: false });
    expect(inv.json().link).toMatch(/\/invitacion\?token=/);
  });
});

describe('Cuenta suspendida y reactivada', () => {
  it('al reactivarla, las llamadas ya reservadas recuperan sus recordatorios', async () => {
    const admin = await registerTrainer(app, { businessName: 'Plataforma P2' });
    await makePlatformAdmin(admin.userId);
    const T = await registerTrainer(app, { businessName: 'Negocio Reactivado' });
    const lead = await T.client.post('/api/leads', { name: 'Rocío Reserva' });
    const appt = await T.client.post('/api/agenda/appointments', { leadId: lead.json().lead.id, start: futureLocal(5, 11).toISOString() });
    expect(appt.statusCode, appt.body).toBe(200);
    const apptId = appt.json().appointment.id as string;
    const pending = () =>
      getDb()
        .select({ key: scheduledJobs.dedupeKey })
        .from(scheduledJobs)
        .where(and(like(scheduledJobs.dedupeKey, `appt:${apptId}:%`), eq(scheduledJobs.status, 'pending')));
    const before = (await pending()).map((j) => j.key).sort();
    expect(before).toContain(`appt:${apptId}:r24`);

    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'suspended' })).statusCode).toBe(200);
    expect(await pending()).toHaveLength(0);

    expect((await admin.client.patch(`/api/admin/businesses/${T.businessId}`, { status: 'active' })).statusCode).toBe(200);
    const after = (await pending()).map((j) => j.key).sort();
    // Todo vuelve salvo la confirmación (ya se había enviado o ya no tiene sentido).
    expect(after).toEqual(before.filter((k) => !k?.endsWith(':confirm')));
  });
});

describe('Instagram: el eco del propio envío de KAI no se toma como respuesta del entrenador', () => {
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
    return { T, conversationId: r.conversation.id };
  }
  const echo = (igAccount: string, igsid: string, mid: string, extra: Record<string, unknown> = {}) =>
    handleMetaWebhook({
      object: 'instagram',
      entry: [{ id: igAccount, messaging: [{ sender: { id: igAccount }, recipient: { id: igsid }, timestamp: Date.now(), message: { mid, text: 'Mensaje', is_echo: true, ...extra } }] }],
    });

  it('un eco con el app_id de KAI se ignora', async () => {
    const { T, conversationId } = await igLead('178414000000301', '9001001');
    const saved = env.META_APP_ID;
    env.META_APP_ID = '123456789';
    try {
      await echo('178414000000301', '9001001', 'mid.echo.app', { app_id: 123456789 });
    } finally {
      env.META_APP_ID = saved;
    }
    expect(await getDb().select().from(messages).where(eq(messages.externalId, 'mid.echo.app'))).toHaveLength(0);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.aiEnabled).toBe(true);
    expect(T.businessId).toBeTruthy();
  });

  it('si el eco llega antes de que KAI guarde su envío, el mensaje queda como de KAI y KAI no se pausa', async () => {
    const { T, conversationId } = await igLead('178414000000302', '9001002');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'graph.instagram.com') throw new Error(`Red no permitida en tests: ${url}`);
      // Meta avisa del eco mientras KAI aún espera la respuesta del envío.
      await echo('178414000000302', '9001002', 'mid.echo.race');
      return new Response(JSON.stringify({ recipient_id: '9001002', message_id: 'mid.echo.race' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await sendMessage({ businessId: T.businessId, conversationId, text: '¡Hola! Soy el asistente virtual de KAI.', sender: { type: 'kai' }, purpose: 'reply' });
    expect(res.delivered).toBe(true);
    const rows = await getDb().select().from(messages).where(eq(messages.externalId, 'mid.echo.race'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderType: 'kai', status: 'sent', content: '¡Hola! Soy el asistente virtual de KAI.' });
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.aiEnabled).toBe(true);
  }, 15_000);

  it('un eco que no es de KAI (el entrenador escribe desde la app) se registra y pausa a KAI', async () => {
    const { conversationId } = await igLead('178414000000303', '9001003');
    await echo('178414000000303', '9001003', 'mid.echo.human');
    const rows = await getDb().select().from(messages).where(eq(messages.externalId, 'mid.echo.human'));
    expect(rows[0]).toMatchObject({ senderType: 'human', direction: 'outbound' });
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv.aiEnabled).toBe(false);
  }, 15_000);
});

describe('Mensajes que KAI no va a contestar', () => {
  const openAlerts = (businessId: string, leadId: string) =>
    getDb()
      .select()
      .from(alerts)
      .where(and(eq(alerts.businessId, businessId), eq(alerts.leadId, leadId), eq(alerts.status, 'open')));

  it('si escribe un cliente, el entrenador recibe un aviso (y se cierra al contestarle)', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Carlos Cliente', source: 'manual' }, { type: 'user', userId: T.userId });
    await getDb().update(leads).set({ status: 'client' }).where(eq(leads.id, lead.id));
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    await receiveInboundForConversation(T.businessId, conv.id, 'Hola David, esta semana no puedo ir el jueves');
    const r = await runSetterReply(T.businessId, conv.id);
    expect(r).toMatchObject({ status: 'skipped', reason: 'already_client' });
    const open = await openAlerts(T.businessId, lead.id);
    expect(open.map((a) => a.type)).toEqual(['client_message']);
    expect(open[0].body).toContain('no puedo ir el jueves');

    await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: 'Sin problema, lo movemos.', sender: { type: 'human', userId: T.userId }, purpose: 'manual' });
    expect(await openAlerts(T.businessId, lead.id)).toHaveLength(0);
  });

  it('con el piloto automático apagado, un lead nuevo de formulario genera un aviso de contacto manual', async () => {
    const T = await registerTrainer(app);
    expect((await T.client.put('/api/settings/ai', { autopilotEnabled: false })).statusCode).toBe(200);
    const { lead } = await createLead(T.businessId, { name: 'Fernando Formulario', source: 'landing' }, { type: 'integration' });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    const r = await runFirstContact(T.businessId, conv.id);
    expect(r).toMatchObject({ status: 'skipped', reason: 'disabled' });
    const open = await openAlerts(T.businessId, lead.id);
    expect(open.map((a) => a.type)).toEqual(['new_lead_manual']);
    expect(open[0].body).toMatch(/piloto automático/);
  });
});

describe('Bandeja: «Pendientes»', () => {
  it('un lead que pidió la baja no se queda en «Pendientes»', async () => {
    const T = await registerTrainer(app);
    const { lead } = await createLead(T.businessId, { name: 'Olga Baja', source: 'manual' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'web');
    await getDb().update(conversations).set({ aiEnabled: false }).where(eq(conversations.id, conv.id));
    await receiveInboundForConversation(T.businessId, conv.id, '¿Hola?');
    const pendingIds = async () =>
      ((await T.client.get('/api/inbox', { query: { filter: 'pending', limit: '50' } })).json().items as { conversation: { id: string } }[]).map((i) => i.conversation.id);
    expect(await pendingIds()).toContain(conv.id);
    await getDb().update(leads).set({ optedOut: true }).where(eq(leads.id, lead.id));
    expect(await pendingIds()).not.toContain(conv.id);
  });
});
