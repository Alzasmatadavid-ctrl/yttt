/**
 * Aislamiento multi-tenant, permisos por rol y panel de administración.
 *
 * Dos entrenadores (A y B) con datos propios: B nunca puede leer, modificar ni borrar
 * nada de A, y sus listados no incluyen datos de A. Un miembro del equipo no puede tocar
 * ajustes, integraciones ni equipo. Solo un administrador de la plataforma entra en /api/admin
 * y ver una conversación queda auditado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { aiSettings, alerts, auditLogs, errorLogs, leads, services } from '../../src/database/schema.js';
import { createAlert } from '../../src/crm/alerts.service.js';
import { receiveInboundForConversation } from '../../src/webhooks/inbound.service.js';
import {
  ApiClient,
  DEFAULT_PASSWORD,
  futureLocal,
  makePlatformAdmin,
  registerTrainer,
  setPlan,
  setupTestApp,
  teardownTestApp,
  uniqueEmail,
  wideRange,
  type Trainer,
} from './helpers.js';

let app: FastifyInstance;
let A: Trainer;
let B: Trainer;

/** Datos de A que B intentará tocar. */
const a = {
  leadId: '',
  conversationId: '',
  appointmentId: '',
  alertId: '',
  serviceId: '',
  actionId: '',
  simConversationId: '',
};

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

beforeAll(async () => {
  app = await setupTestApp();
  A = await registerTrainer(app, { name: 'Ana Entrenadora', businessName: 'Negocio A' });
  B = await registerTrainer(app, { name: 'Bruno Entrenador', businessName: 'Negocio B' });

  // Lead real de A con conversación y un mensaje entrante.
  const lead = await A.client.post('/api/leads', { name: 'Lucía Secreta', phone: '+34600123456', email: 'lucia.secreta@example.com', goal: 'Perder grasa' });
  expect(lead.statusCode).toBe(200);
  a.leadId = lead.json().lead.id;
  const conv = await A.client.post(`/api/leads/${a.leadId}/start-test-conversation`);
  a.conversationId = conv.json().conversationId;
  await receiveInboundForConversation(A.businessId, a.conversationId, 'Hola, me interesa entrenar contigo');

  // Cita, aviso y servicio de A.
  const appt = await A.client.post('/api/agenda/appointments', { leadId: a.leadId, start: futureLocal(3, 11).toISOString() });
  expect(appt.statusCode).toBe(200);
  a.appointmentId = appt.json().appointment.id;
  const alert = await createAlert({ businessId: A.businessId, type: 'handoff', title: 'KAI necesita tu intervención', body: 'Aviso privado de A', leadId: a.leadId, conversationId: a.conversationId });
  a.alertId = alert!.id;
  const svc = await A.client.put('/api/settings/primary-service', { name: 'Plan Privado A', priceCents: 9900, billingPeriod: 'monthly' });
  a.serviceId = svc.json().service.id;

  // Acción pendiente de Copilot creada por A.
  const ask = await A.client.post('/api/copilot/ask', { question: 'Cambia el tono de KAI para que sea más directo' });
  a.actionId = ask.json().data.actions[0].id;

  // Conversación del simulador de A.
  const sim = await A.client.post('/api/simulator/conversations', { leadName: 'Prueba de A' });
  a.simConversationId = sim.json().conversationId;
});

afterAll(async () => {
  await teardownTestApp(app);
});

describe('aislamiento entre negocios', () => {
  it('B no puede leer los datos de A (404)', async () => {
    const c = B.client;
    expect((await c.get(`/api/leads/${a.leadId}`)).statusCode).toBe(404);
    expect((await c.get(`/api/conversations/${a.conversationId}`)).statusCode).toBe(404);
    expect((await c.get(`/api/agenda/appointments/${a.appointmentId}`)).statusCode).toBe(404);
    expect((await c.get(`/api/simulator/conversations/${a.simConversationId}`)).statusCode).toBe(404);
  });

  it('B no puede modificar ni borrar leads de A', async () => {
    const c = B.client;
    expect((await c.patch(`/api/leads/${a.leadId}`, { name: 'Hackeado' })).statusCode).toBe(404);
    expect((await c.post(`/api/leads/${a.leadId}/status`, { status: 'lost' })).statusCode).toBe(404);
    expect((await c.post(`/api/leads/${a.leadId}/memories`, { content: 'Dato inventado por B' })).statusCode).toBe(404);
    expect((await c.post(`/api/leads/${a.leadId}/rescore`)).statusCode).toBe(404);
    expect((await c.delete(`/api/leads/${a.leadId}`)).statusCode).toBe(404);

    const [row] = await getDb().select().from(leads).where(eq(leads.id, a.leadId));
    expect(row.name).toBe('Lucía Secreta');
    expect(row.status).not.toBe('lost');
    expect(row.businessId).toBe(A.businessId);
  });

  it('B no puede escribir en conversaciones de A ni tomar su control', async () => {
    const c = B.client;
    expect((await c.post(`/api/conversations/${a.conversationId}/messages`, { text: 'Mensaje de B' })).statusCode).toBe(404);
    expect((await c.post(`/api/conversations/${a.conversationId}/take-over`)).statusCode).toBe(404);
    expect((await c.post(`/api/conversations/${a.conversationId}/release`, { replyNow: true })).statusCode).toBe(404);
    expect((await c.post(`/api/simulator/conversations/${a.simConversationId}/messages`, { text: 'Hola' })).statusCode).toBe(404);
    expect((await c.delete(`/api/simulator/conversations/${a.simConversationId}`)).statusCode).toBe(404);

    const detail = (await A.client.get(`/api/conversations/${a.conversationId}`)).json();
    expect(detail.messages.map((m: { content: string }) => m.content)).not.toContain('Mensaje de B');
    expect(detail.conversation.aiEnabled).toBe(true);
  });

  it('B no puede ver, cancelar, mover ni registrar el resultado de citas de A, ni reservar con sus leads', async () => {
    const c = B.client;
    expect((await c.post(`/api/agenda/appointments/${a.appointmentId}/cancel`, { reason: 'B' })).statusCode).toBe(404);
    expect((await c.post(`/api/agenda/appointments/${a.appointmentId}/reschedule`, { start: futureLocal(4, 12).toISOString() })).statusCode).toBe(404);
    expect((await c.post(`/api/agenda/appointments/${a.appointmentId}/outcome`, { attended: false })).statusCode).toBe(404);
    expect((await c.post('/api/agenda/appointments', { leadId: a.leadId, start: futureLocal(5, 12).toISOString() })).statusCode).toBe(404);
    const appt = (await A.client.get(`/api/agenda/appointments/${a.appointmentId}`)).json().appointment;
    expect(appt.status).toBe('scheduled');
  });

  it('B no puede resolver avisos de A', async () => {
    expect((await B.client.post(`/api/alerts/${a.alertId}/resolve`, { status: 'dismissed' })).statusCode).toBe(404);
    const [row] = await getDb().select().from(alerts).where(eq(alerts.id, a.alertId));
    expect(row.status).toBe('open');
  });

  it('B no puede editar ni borrar servicios de A', async () => {
    expect((await B.client.patch(`/api/settings/services/${a.serviceId}`, { priceCents: 1 })).statusCode).toBe(404);
    const del = await B.client.delete(`/api/settings/services/${a.serviceId}`);
    // El borrado está filtrado por negocio: aunque responda, el servicio de A sigue intacto.
    expect(del.statusCode).toBeLessThan(500);
    const [row] = await getDb().select().from(services).where(eq(services.id, a.serviceId));
    expect(row).toBeTruthy();
    expect(row.priceCents).toBe(9900);
    expect(row.businessId).toBe(A.businessId);
  });

  it('B no puede ver, confirmar ni cancelar acciones de Copilot de A', async () => {
    expect((await B.client.post(`/api/copilot/actions/${a.actionId}/confirm`)).statusCode).toBe(404);
    expect((await B.client.post(`/api/copilot/actions/${a.actionId}/cancel`)).statusCode).toBe(404);
    const list = (await B.client.get('/api/copilot/actions')).json().actions as { id: string }[];
    expect(ids(list)).not.toContain(a.actionId);
    // Sigue pendiente para A y el tono no ha cambiado.
    expect(ids((await A.client.get('/api/copilot/actions')).json().actions)).toContain(a.actionId);
    const [s] = await getDb().select().from(aiSettings).where(eq(aiSettings.businessId, A.businessId));
    expect(s.tone.directness).toBe(3);
  });

  it('los listados de B no incluyen nada de A', async () => {
    const c = B.client;
    const leadsList = (await c.get('/api/leads?includeTest=true')).json().leads as { id: string }[];
    expect(ids(leadsList)).not.toContain(a.leadId);
    expect(leadsList).toHaveLength(0);

    const inbox = (await c.get('/api/inbox?includeTest=true')).json();
    expect(inbox.items).toHaveLength(0);
    expect(inbox.counts.all).toBe(0);

    expect((await c.get('/api/alerts')).json().alerts).toHaveLength(0);
    expect((await c.get('/api/agenda/appointments', { query: wideRange() })).json().appointments).toHaveLength(0);
    expect((await c.get('/api/simulator/conversations')).json().conversations).toHaveLength(0);
    expect((await c.get('/api/follow-ups')).json().followUps).toHaveLength(0);

    const settings = (await c.get('/api/settings')).json();
    expect(ids(settings.services)).not.toContain(a.serviceId);
    expect(settings.business.id).toBe(B.businessId);
    // El secreto del webhook nunca se expone en /settings.
    expect(settings.business.webhookSecretEnc).toBeUndefined();

    const dash = (await c.get('/api/dashboard')).json();
    expect(dash.attention.alerts).toHaveLength(0);
    expect(dash.upcoming).toHaveLength(0);
    expect(JSON.stringify(dash)).not.toContain('Lucía Secreta');

    // Copilot de B tampoco ve los leads de A.
    const ask = (await c.post('/api/copilot/ask', { question: '¿A quién debería responder ahora?' })).json();
    expect(JSON.stringify(ask)).not.toContain('Lucía');
  });

  it('A sí ve sus propios datos (control positivo)', async () => {
    expect((await A.client.get(`/api/leads/${a.leadId}`)).statusCode).toBe(200);
    expect(ids((await A.client.get('/api/leads')).json().leads)).toContain(a.leadId);
    expect((await A.client.get('/api/alerts')).json().alerts.map((x: { alert: { id: string } }) => x.alert.id)).toContain(a.alertId);
  });

  it('B no puede forzar el negocio de A con la cabecera x-kai-business ni cambiando de negocio', async () => {
    const res = await B.client.get('/api/leads', { headers: { 'x-kai-business': A.businessId } });
    expect(res.statusCode).toBe(403);
    expect((await B.client.get(`/api/leads/${a.leadId}`, { headers: { 'x-kai-business': A.businessId } })).statusCode).toBe(403);
    expect((await B.client.post('/api/auth/switch-business', { businessId: A.businessId })).statusCode).toBe(403);
  });

  it('un identificador mal formado devuelve 400, no un error interno', async () => {
    expect((await B.client.get('/api/leads/no-es-un-uuid')).statusCode).toBe(400);
  });
});

describe('permisos del miembro del equipo', () => {
  let owner: Trainer;
  let member: ApiClient;
  let leadId = '';

  beforeAll(async () => {
    owner = await registerTrainer(app, { businessName: 'Negocio con equipo' });
    await setPlan(owner.businessId, 'pro');
    const email = uniqueEmail('miembro');
    const inv = await owner.client.post('/api/team/invite', { email, role: 'team_member' });
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(inv.json().link)![1]);
    member = new ApiClient(app);
    const acc = await member.post('/api/auth/accept-invitation', { token, name: 'Miembro Equipo', password: DEFAULT_PASSWORD });
    expect(acc.statusCode).toBe(200);
    leadId = (await owner.client.post('/api/leads', { name: 'Lead del equipo' })).json().lead.id;
  });

  it('puede trabajar con leads y leer los ajustes', async () => {
    expect((await member.get('/api/leads')).statusCode).toBe(200);
    expect((await member.get('/api/settings')).statusCode).toBe(200);
    expect((await member.patch(`/api/leads/${leadId}`, { notes: 'Nota del miembro' })).statusCode).toBe(200);
    expect((await member.post('/api/leads', { name: 'Lead creado por el miembro' })).statusCode).toBe(200);
  });

  it('no puede cambiar ajustes, agenda, automatizaciones ni el plan de KAI (403)', async () => {
    expect((await member.put('/api/settings/ai', { tone: { formality: 5, energy: 1, directness: 1, emojiUsage: 'none', messageLength: 'long', addressing: 'usted' } })).statusCode).toBe(403);
    expect((await member.put('/api/settings/business', { name: 'Cambiado', timezone: 'Europe/Madrid', currency: 'EUR', monthlyAdSpendCents: 0 })).statusCode).toBe(403);
    expect((await member.put('/api/settings/trainer', { displayName: 'Otro' })).statusCode).toBe(403);
    expect((await member.put('/api/settings/primary-service', { name: 'Servicio pirata', priceCents: 100 })).statusCode).toBe(403);
    expect((await member.put('/api/agenda/availability', { weekly: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }, slotMinutes: 30, bufferMinutes: 0, minNoticeMinutes: 0, maxDaysAhead: 14, blackoutDates: [] })).statusCode).toBe(403);
    expect((await member.put('/api/settings/automations/followup_no_reply', { enabled: false, config: {} })).statusCode).toBe(403);
    const [s] = await getDb().select().from(aiSettings).where(eq(aiSettings.businessId, owner.businessId));
    expect(s.tone.formality).not.toBe(5);
  });

  it('no puede gestionar integraciones ni ver el secreto del webhook (403)', async () => {
    expect((await member.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: '5550001', accessToken: 'x'.repeat(30), skipVerification: true })).statusCode).toBe(403);
    expect((await member.get('/api/integrations/webhook-secret')).statusCode).toBe(403);
    expect((await member.post('/api/integrations/webhook-secret/rotate')).statusCode).toBe(403);
  });

  it('no puede gestionar el equipo ni borrar leads (403)', async () => {
    expect((await member.post('/api/team/invite', { email: uniqueEmail('otro'), role: 'trainer' })).statusCode).toBe(403);
    expect((await member.patch(`/api/team/members/${owner.userId}`, { role: 'team_member' })).statusCode).toBe(403);
    expect((await member.delete(`/api/team/members/${owner.userId}`)).statusCode).toBe(403);
    expect((await member.delete(`/api/leads/${leadId}`)).statusCode).toBe(403);
    expect((await owner.client.get(`/api/leads/${leadId}`)).statusCode).toBe(200);
  });

  it('no puede confirmar acciones de Copilot que requieren permisos de entrenador', async () => {
    const ask = await member.post('/api/copilot/ask', { question: 'Cambia el tono de KAI para que sea más directo' });
    expect(ask.statusCode).toBe(200);
    // Copilot no deja preparada una acción que el miembro no puede ejecutar.
    expect(ask.json().data?.actions ?? []).toHaveLength(0);
    // Y una acción del entrenador tampoco la puede confirmar el miembro.
    const ownerAsk = (await owner.client.post('/api/copilot/ask', { question: 'Cambia el tono de KAI para que sea más formal' })).json();
    const actionId = ownerAsk.data.actions[0].id as string;
    const confirm = await member.post(`/api/copilot/actions/${actionId}/confirm`);
    expect([403, 404]).toContain(confirm.statusCode);
    const [s] = await getDb().select().from(aiSettings).where(eq(aiSettings.businessId, owner.businessId));
    expect(s.tone.formality).not.toBe(4);
  });

  /**
   * BUG (src/ai/copilot/copilot.service.ts → askCopilot / answerWithRules):
   * cuando un miembro del equipo pide a Copilot “Cambia el tono de KAI…”, createPendingAction lanza
   * forbidden(); askCopilot lo trata como un fallo inesperado: lo registra en error_logs con nivel
   * “error” (ensucia el panel de errores del admin) y responde “Ahora mismo no puedo responder.
   * Inténtalo de nuevo en un momento.”, que hace pensar en una avería pasajera.
   * Esperado: una respuesta clara del tipo “No tienes permiso para cambiar el tono de KAI; pídeselo
   * al entrenador del negocio” y sin registrar un error interno.
   */
  it('Copilot explica al miembro del equipo que no tiene permiso (y no registra un error interno)', async () => {
    const ask = await member.post('/api/copilot/ask', { question: 'Cambia el tono de KAI para que sea más directo' });
    expect(ask.statusCode).toBe(200);
    expect(ask.json().text).toMatch(/permiso/i);
    const errors = await getDb().select().from(errorLogs).where(and(eq(errorLogs.source, 'ai.copilot'), eq(errorLogs.businessId, owner.businessId)));
    expect(errors).toHaveLength(0);
  });
});

describe('panel de administración de la plataforma', () => {
  it('un usuario normal recibe 403 en /api/admin/*', async () => {
    const c = A.client;
    for (const url of ['/api/admin/overview', '/api/admin/businesses', '/api/admin/users', '/api/admin/plans', '/api/admin/errors', '/api/admin/audit', `/api/admin/conversations/${a.conversationId}`]) {
      expect((await c.get(url)).statusCode, url).toBe(403);
    }
    expect((await c.patch(`/api/admin/businesses/${B.businessId}`, { status: 'suspended' })).statusCode).toBe(403);
    expect((await new ApiClient(app).get('/api/admin/overview')).statusCode).toBe(401);
  });

  it('un administrador accede y ver una conversación queda registrado en la auditoría', async () => {
    const admin = await registerTrainer(app, { name: 'Admin Plataforma', businessName: 'KAI HQ' });
    await makePlatformAdmin(admin.userId);
    expect((await admin.client.get('/api/auth/me')).json().user.platformRole).toBe('admin');

    const overview = await admin.client.get('/api/admin/overview');
    expect(overview.statusCode).toBe(200);
    const list = await admin.client.get('/api/admin/businesses');
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(A.businessId);

    const conv = await admin.client.get(`/api/admin/conversations/${a.conversationId}`);
    expect(conv.statusCode).toBe(200);
    expect(conv.json().conversation.id).toBe(a.conversationId);
    expect(conv.json().messages.length).toBeGreaterThan(0);

    const logs = await getDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'admin.conversation_viewed'), eq(auditLogs.entityId, a.conversationId)));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: 'admin', actorUserId: admin.userId, businessId: A.businessId, entityType: 'conversation' });
  });
});
