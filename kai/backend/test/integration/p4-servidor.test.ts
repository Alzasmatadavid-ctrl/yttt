/**
 * Revisión nº4 — grupo «servidor» (integración):
 *  1) Un número de otro país que acaba igual (+33 6… frente a +34 6…) no se queda con la ficha ni la conversación.
 *  2) El límite de negocios del plan se cuenta por cuenta, no por persona del equipo.
 *  4) El aviso «Datos de contacto sin confirmar» y «Mensaje no enviado» no se ocultan entre sí.
 *  5) Cambiar el teléfono de un lead cambia también a dónde le escribe KAI por WhatsApp.
 *  6) Modo sin IA: «¿Podemos hablar?» ofrece horarios en vez de repetir la pregunta anterior.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, MIGRATIONS_FOLDER } from '../../src/database/client.js';
import { alerts, auditLogs, businesses, conversations, leads, plans } from '../../src/database/schema.js';
import { createLead } from '../../src/crm/leads.service.js';
import { getOrCreateConversation } from '../../src/crm/conversations.service.js';
import { sendMessage } from '../../src/crm/messaging.service.js';
import { createBusiness } from '../../src/business/business.service.js';
import { receiveInboundMessage } from '../../src/webhooks/inbound.service.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import { ApiClient, DEFAULT_PASSWORD, json, openAgenda, registerTrainer, setPlan, setupTestApp, teardownTestApp, uniqueEmail, type Trainer } from './helpers.js';

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

/** Mensaje entrante de WhatsApp tal y como lo deja el webhook de Meta (wa_id y +wa_id). */
async function whatsappIn(T: Trainer, waId: string, text: string, opts: { connectionId?: string; name?: string } = {}) {
  const r = await receiveInboundMessage({
    businessId: T.businessId,
    channel: 'whatsapp',
    channelConnectionId: opts.connectionId ?? null,
    externalMessageId: `wamid.p4.${waId}.${Math.random().toString(36).slice(2)}`,
    text,
    profile: { whatsappId: waId, phone: `+${waId}`, name: opts.name ?? null },
  });
  if (r.duplicate) throw new Error('duplicado inesperado');
  return r;
}

const leadRow = async (id: string) => (await getDb().select().from(leads).where(eq(leads.id, id)))[0];
const leadCount = async (businessId: string) => (await getDb().select({ id: leads.id }).from(leads).where(eq(leads.businessId, businessId))).length;

async function connectWhatsApp(T: Trainer, phoneNumberId: string) {
  const res = await T.client.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: phoneNumberId, accessToken: 'EAAG-token-de-prueba-0123456789abcdef', skipVerification: true });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().connection.id as string;
}

/** Simula la API de WhatsApp y devuelve a qué números se ha enviado cada mensaje. */
function captureWhatsAppSends() {
  const to: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'graph.facebook.com') throw new Error(`Red no permitida en tests: ${url}`);
    to.push(JSON.parse(String(init?.body ?? '{}')).to);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${to.length}.${Date.now()}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return to;
}

const openAlertsOf = (leadId: string) =>
  getDb()
    .select({ type: alerts.type, title: alerts.title, body: alerts.body })
    .from(alerts)
    .where(and(eq(alerts.leadId, leadId), eq(alerts.status, 'open')));

// ───────────── 1) Números de otro país que acaban igual ─────────────

describe('WhatsApp: un número de otro país con los mismos últimos dígitos es otra persona', () => {
  let T: Trainer;
  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Gemelos P4' });
  });

  it('+33 612 345 678 no se queda con la ficha de +34 612 345 678 (ni con su WhatsApp)', async () => {
    const { lead: ana } = await createLead(T.businessId, { name: 'Ana Martínez', phone: '+34 612 345 678', source: 'manual' }, { type: 'user', userId: T.userId });
    const r = await whatsappIn(T, '33612345678', 'Hola, ¿a qué hora era mi llamada?', { name: 'Desconocido' });
    expect(r.lead.id).not.toBe(ana.id);
    expect(r.leadCreated).toBe(true);
    expect(await leadRow(ana.id)).toMatchObject({ phone: '+34612345678', whatsappId: null });
  });

  it('los mensajes del gemelo no entran en la conversación de quien ya escribe por WhatsApp', async () => {
    const bea = await whatsappIn(T, '34622333444', 'Hola, quiero información', { name: 'Bea' });
    const twin = await whatsappIn(T, '33622333444', 'Cancela mi llamada por favor');
    expect(twin.lead.id).not.toBe(bea.lead.id);
    expect(twin.conversation.id).not.toBe(bea.conversation.id);
    expect((await leadRow(bea.lead.id)).whatsappId).toBe('34622333444');
  });

  it('el mismo número sí se reconoce: apuntado sin prefijo (país del negocio) o con otro formato', async () => {
    const { lead: carlos } = await createLead(T.businessId, { name: 'Carlos Local', phone: '612 345 679', source: 'manual' }, { type: 'user', userId: T.userId });
    expect((await whatsappIn(T, '33612345679', 'Hola')).lead.id).not.toBe(carlos.id);
    const own = await whatsappIn(T, '34612345679', 'Hola, soy Carlos');
    expect(own.lead.id).toBe(carlos.id);
    expect((await leadRow(carlos.id)).whatsappId).toBe('34612345679');
  });

  it('si ya existe el lead de ese WhatsApp, gana aunque otro más antiguo acabe igual', async () => {
    const { lead: older } = await createLead(T.businessId, { name: 'Lead Francés', phone: '+33 699 111 222', source: 'manual' }, { type: 'user', userId: T.userId });
    const first = await whatsappIn(T, '34699111222', 'Hola');
    expect(first.lead.id).not.toBe(older.id);
    const again = await whatsappIn(T, '34699111222', '¿Seguís ahí?');
    expect(again.lead.id).toBe(first.lead.id);
    expect(await leadRow(older.id)).toMatchObject({ whatsappId: null, phone: '+33699111222' });
  });

  it('México: el WhatsApp 521… es el mismo móvil que +52 …', async () => {
    const M = await registerTrainer(app, { businessName: 'Negocio México P4', timezone: 'America/Mexico_City' });
    const { lead } = await createLead(M.businessId, { name: 'Lupita', phone: '+52 55 1234 5678', source: 'manual' }, { type: 'user', userId: M.userId });
    const r = await whatsappIn(M, '5215512345678', 'Hola');
    expect(r.lead.id).toBe(lead.id);
    expect(await leadCount(M.businessId)).toBe(1);
  });

  it('un formulario con el número gemelo no se confunde con el lead existente', async () => {
    const { lead: eva } = await createLead(T.businessId, { name: 'Eva Gemela', phone: '+34 611 777 888', source: 'manual' }, { type: 'user', userId: T.userId });
    const publicKey = json(await T.client.get('/api/integrations')).endpoints.publicKey;
    const res = await new ApiClient(app).post(`/api/public/forms/${publicKey}`, { name: 'Otra Persona', phone: '+33 611 777 888' }, { csrf: false });
    expect(res.statusCode).toBe(200);
    const rows = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.phone, '+33611777888')));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(eva.id);
    expect(await openAlertsOf(eva.id)).toHaveLength(0);
  });
});

// ───────────── 5) Cambiar el teléfono de un lead ─────────────

describe('Cambiar el teléfono de un lead cambia su WhatsApp', () => {
  let T: Trainer;
  let connectionId: string;
  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Cambio Teléfono P4' });
    connectionId = await connectWhatsApp(T, '106540352200401');
  });

  it('los mensajes salen hacia el número nuevo y lo que llega desde él entra en su ficha', async () => {
    const first = await whatsappIn(T, '34611000111', 'Hola, quiero información', { connectionId, name: 'Eva' });
    const patch = await T.client.patch(`/api/leads/${first.lead.id}`, { phone: '+34 655 000 999' });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(await leadRow(first.lead.id)).toMatchObject({ phone: '+34655000999', whatsappId: '34655000999' });

    const to = captureWhatsAppSends();
    const sent = await T.client.post(`/api/conversations/${first.conversation.id}/messages`, { text: 'Hola Eva, te escribo al número nuevo.' });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(to).toEqual(['34655000999']);

    const again = await whatsappIn(T, '34655000999', 'Ya tengo número nuevo, ¿me escribís aquí?', { connectionId });
    expect(again.lead.id).toBe(first.lead.id);
    expect(again.conversation.id).toBe(first.conversation.id);
  });

  it('el mismo número con otro formato no cambia nada', async () => {
    const r = await whatsappIn(T, '34611000222', 'Hola', { connectionId, name: 'Félix' });
    expect((await T.client.patch(`/api/leads/${r.lead.id}`, { phone: '611 000 222' })).statusCode).toBe(200);
    expect((await leadRow(r.lead.id)).whatsappId).toBe('34611000222');
  });

  it('si el número nuevo ya es el WhatsApp de otro lead, se explica en vez de fallar', async () => {
    const a = await whatsappIn(T, '34611000333', 'Hola', { connectionId, name: 'Gema' });
    await whatsappIn(T, '34611000444', 'Hola', { connectionId, name: 'Hugo' });
    const res = await T.client.patch(`/api/leads/${a.lead.id}`, { phone: '+34 611 000 444' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/ya es el WhatsApp de otro lead \(Hugo\)/);
    expect((await leadRow(a.lead.id)).whatsappId).toBe('34611000333');
  });

  it('quitar el teléfono deja de escribir a su WhatsApp antiguo', async () => {
    const r = await whatsappIn(T, '34611000555', 'Hola', { connectionId, name: 'Inés' });
    expect((await T.client.patch(`/api/leads/${r.lead.id}`, { phone: null })).statusCode).toBe(200);
    expect(await leadRow(r.lead.id)).toMatchObject({ phone: null, whatsappId: null });
  });

  it('si su ficha apuntaba a otro WhatsApp, al escribir desde su propio número se le contesta a ese', async () => {
    const { lead } = await createLead(T.businessId, { name: 'Julia', phone: '+34 611 000 666', source: 'manual' }, { type: 'user', userId: T.userId });
    // Ficha antigua enlazada por error con el gemelo (+33…) por el criterio anterior de los últimos 9 dígitos.
    await getDb().update(leads).set({ whatsappId: '33611000666' }).where(eq(leads.id, lead.id));
    const r = await whatsappIn(T, '34611000666', 'Hola, soy Julia', { connectionId });
    expect(r.lead.id).toBe(lead.id);
    expect((await leadRow(lead.id)).whatsappId).toBe('34611000666');
  });
});

// ───────────── 4) Avisos que se ocultaban entre sí ─────────────

describe('«Datos de contacto sin confirmar» y «Mensaje no enviado» no se ocultan entre sí', () => {
  let T: Trainer;
  let publicKey = '';
  const postForm = (payload: unknown) => new ApiClient(app).post(`/api/public/forms/${publicKey}`, payload, { csrf: false });

  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Avisos P4' });
    publicKey = json(await T.client.get('/api/integrations')).endpoints.publicKey;
  });

  it('con el aviso de datos sin confirmar abierto, un envío bloqueado de KAI también avisa', async () => {
    const { lead } = await createLead(T.businessId, { name: 'Carla', email: 'carla.p4@example.com', phone: '+34611222444', source: 'manual' }, { type: 'user', userId: T.userId });
    expect((await postForm({ email: 'carla.p4@example.com', phone: '+34 699 000 333' })).statusCode).toBe(200);
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    const sent = await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: 'Carla, mañana es la llamada.', sender: { type: 'kai' }, purpose: 'reminder' });
    expect(sent.delivered).toBe(false);
    const open = await openAlertsOf(lead.id);
    expect(open.map((a) => `${a.type}: ${a.title}`).sort()).toEqual(['contact_unverified: Datos de contacto sin confirmar', 'delivery_blocked: Mensaje no enviado']);
  });

  it('con un «Mensaje no enviado» abierto, el formulario con otros datos sí avisa', async () => {
    const { lead } = await createLead(T.businessId, { name: 'Dani', email: 'dani.p4@example.com', phone: '+34611222555', source: 'manual' }, { type: 'user', userId: T.userId });
    const conv = await getOrCreateConversation(T.businessId, lead.id, 'whatsapp');
    await sendMessage({ businessId: T.businessId, conversationId: conv.id, text: 'Dani, te escribo por lo de tu objetivo.', sender: { type: 'kai' }, purpose: 'follow_up' });
    expect((await postForm({ email: 'dani.p4@example.com', phone: '+34 688 888 888' })).statusCode).toBe(200);
    const open = await openAlertsOf(lead.id);
    expect(open.map((a) => a.title).sort()).toEqual(['Datos de contacto sin confirmar', 'Mensaje no enviado']);
    expect(open.find((a) => a.type === 'contact_unverified')?.body).toContain('+34688888888');
  });

  it('la baja abierta tampoco oculta un «Mensaje no enviado» posterior (y no se duplican)', async () => {
    const r = await whatsappIn(T, '34611222666', 'Hola', { name: 'Elsa' });
    expect((await T.client.post(`/api/conversations/${r.conversation.id}/take-over`)).statusCode).toBe(200);
    await whatsappIn(T, '34611222666', 'Dame de baja');
    expect((await T.client.post(`/api/leads/${r.lead.id}/opt-in`)).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) await sendMessage({ businessId: T.businessId, conversationId: r.conversation.id, text: `Elsa, recordatorio ${i}.`, sender: { type: 'kai' }, purpose: 'reminder' });
    const open = await openAlertsOf(r.lead.id);
    expect(open.map((a) => a.title).sort()).toEqual(['Mensaje no enviado', 'Un lead ha pedido no recibir más mensajes']);
  });
});

// ───────────── 2) Límite de negocios por cuenta ─────────────

describe('Límite de negocios del plan: se cuenta por cuenta, no por persona', () => {
  const MAX = 3;
  beforeAll(async () => {
    const [agency] = await getDb().select().from(plans).where(eq(plans.key, 'agency'));
    await getDb().update(plans).set({ limits: { ...agency.limits, maxBusinesses: MAX } }).where(eq(plans.id, agency.id));
  });

  it('un entrenador invitado no puede crear negocios por encima del límite de la cuenta', async () => {
    const owner = await registerTrainer(app, { businessName: 'Agencia Principal' });
    await setPlan(owner.businessId, 'agency');
    await getDb().update(businesses).set({ subscriptionStatus: 'active' }).where(eq(businesses.id, owner.businessId));
    const asRoot = { headers: { 'x-kai-business': owner.businessId } };

    for (let i = 2; i <= MAX; i++) expect((await owner.client.post('/api/businesses', { name: `Agencia ${i}` }, asRoot)).statusCode).toBe(200);
    const full = await owner.client.post('/api/businesses', { name: 'Agencia de más' }, asRoot);
    expect(full.statusCode).toBe(402);
    expect(full.json().message).toMatch(new RegExp(`permite ${MAX} negocios`));

    // Otra cuenta invitada como «entrenador» del negocio principal.
    const email = uniqueEmail('socio');
    const inv = await owner.client.post('/api/team/invite', { email, role: 'trainer' }, asRoot);
    expect(inv.statusCode, inv.body).toBe(200);
    const token = new URL(inv.json().link as string).searchParams.get('token')!;
    const partner = new ApiClient(app);
    expect((await partner.post('/api/auth/accept-invitation', { token, name: 'Socio Agencia', password: DEFAULT_PASSWORD })).statusCode).toBe(200);
    const res = await partner.post('/api/businesses', { name: 'Negocio del socio' }, asRoot);
    expect(res.statusCode).toBe(402);

    const accountRows = await getDb()
      .select({ id: businesses.id })
      .from(businesses)
      .where(sql`${businesses.id} = ${owner.businessId} or ${businesses.accountBusinessId} = ${owner.businessId}`);
    expect(accountRows).toHaveLength(MAX);
    // El panel sabe cuántos negocios lleva la cuenta (para no ofrecer «Añadir negocio» si ya no se puede).
    const me = json(await owner.client.get('/api/auth/me'));
    for (const b of me.businesses) expect(b.accountBusinesses).toBe(MAX);
  });

  it('los negocios creados desde un negocio adicional cuentan para la misma cuenta', async () => {
    const owner = await registerTrainer(app, { businessName: 'Agencia Cadena' });
    await setPlan(owner.businessId, 'agency');
    const second = await owner.client.post('/api/businesses', { name: 'Cadena 2' }, { headers: { 'x-kai-business': owner.businessId } });
    expect(second.statusCode).toBe(200);
    const secondId = second.json().business.id as string;
    expect((await owner.client.post('/api/businesses', { name: 'Cadena 3' }, { headers: { 'x-kai-business': secondId } })).statusCode).toBe(200);
    expect((await owner.client.post('/api/businesses', { name: 'Cadena 4' }, { headers: { 'x-kai-business': secondId } })).statusCode).toBe(402);
    const [row] = await getDb().select().from(businesses).where(eq(businesses.id, secondId));
    expect(row.accountBusinessId).toBe(owner.businessId);
  });

  it('la migración enlaza los negocios adicionales ya creados con el principal de su cuenta', async () => {
    const owner = await registerTrainer(app, { businessName: 'Agencia Antigua' });
    const mk = async (name: string, fromBusinessId: string) => {
      const b = await createBusiness({ name, ownerUserId: owner.userId, ownerName: 'Laura' });
      await getDb().insert(auditLogs).values({ businessId: b.id, actorType: 'user', actorUserId: owner.userId, action: 'business.created', entityType: 'business', entityId: b.id, metadata: { fromBusinessId } });
      return b.id;
    };
    const b2 = await mk('Antigua 2', owner.businessId);
    const b3 = await mk('Antigua 3', b2); // creado desde un negocio adicional
    const backfill = readFileSync(`${MIGRATIONS_FOLDER}/0002_account_business.sql`, 'utf8').split('--> statement-breakpoint')[2];
    expect(backfill).toMatch(/UPDATE "businesses"/);
    await getDb().execute(sql.raw(backfill));
    const rows = await getDb().select({ id: businesses.id, account: businesses.accountBusinessId }).from(businesses).where(sql`${businesses.id} in (${owner.businessId}, ${b2}, ${b3})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.account]))).toEqual({ [owner.businessId]: null, [b2]: owner.businessId, [b3]: owner.businessId });
  });
});

// ───────────── 6) «¿Podemos hablar?» en el simulador (modo sin IA) ─────────────

describe('Simulador sin IA: pedir hablar ofrece horarios', () => {
  it('«¿Podemos hablar?» a mitad de la cualificación ofrece horarios reales en vez de repetir la pregunta', async () => {
    const T = await registerTrainer(app, { name: 'Álex Romero', businessName: 'Álex Fit P4' });
    await openAgenda(T.client);
    const start = await T.client.post('/api/simulator/conversations', { leadName: 'Rubén' });
    expect(start.statusCode).toBe(200);
    const id = start.json().conversationId as string;
    const say = async (text: string) => {
      const res = await T.client.post(`/api/simulator/conversations/${id}/messages`, { text });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().result as { status: string; text?: string; directive?: string };
    };
    await say('Hola, quiero perder grasa');
    const before = await say('Unos 8 kilos');
    const r = await say('¿Podemos hablar?');
    expect(r.status).toBe('sent');
    expect(r.directive).toBe('offer_slots');
    expect(r.text).not.toBe(before.text);
    expect(r.text).toMatch(/\d{1,2}:\d{2}/);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.id, id));
    expect(((conv.state as SetterState).offeredSlots ?? []).length).toBeGreaterThan(0);
  });
});
