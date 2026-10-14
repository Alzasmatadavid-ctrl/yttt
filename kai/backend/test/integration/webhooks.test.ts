/**
 * Webhooks: verificación y firma de Meta, mensajes entrantes de WhatsApp (idempotentes),
 * webhook de leads con clave/firma y formulario público con campo trampa anti-bots.
 *
 * Ninguna petición sale a la red: el canal de WhatsApp se conecta con `skipVerification`
 * y solo se comprueba que la respuesta de KAI queda programada (no se ejecuta).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../src/database/client.js';
import { conversations, leads, messages, scheduledJobs } from '../../src/database/schema.js';
import { ApiClient, registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const PHONE_NUMBER_ID = '106540352242922';

let app: FastifyInstance;
let T: Trainer;
let anon: ApiClient;

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function waPayload(opts: { wamid: string; from: string; text: string; name?: string; phoneNumberId?: string }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '34911222333', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: [{ wa_id: opts.from, profile: { name: opts.name ?? 'Pedro Ruiz' } }],
              messages: [{ id: opts.wamid, from: opts.from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: opts.text } }],
            },
          },
        ],
      },
    ],
  };
}

/** POST al webhook de Meta con el cuerpo exacto que se firma. */
function postMeta(payload: unknown, signature?: string | null) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-hub-signature-256'] = signature ?? sign(APP_SECRET, body);
  return app.inject({ method: 'POST', url: '/api/webhooks/meta', payload: body, headers });
}

async function leadByWhatsApp(waId: string) {
  const [row] = await getDb()
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, T.businessId), eq(leads.whatsappId, waId)));
  return row ?? null;
}

beforeAll(async () => {
  app = await setupTestApp();
  T = await registerTrainer(app, { businessName: 'Negocio Webhooks' });
  anon = new ApiClient(app);
});

afterAll(async () => {
  await teardownTestApp(app);
});

describe('Meta: verificación de la suscripción (GET)', () => {
  it('devuelve el challenge con el token correcto', async () => {
    const res = await anon.get(`/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('rechaza un token incorrecto o un modo distinto con 403', async () => {
    expect((await anon.get('/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=otro-token&hub.challenge=1')).statusCode).toBe(403);
    expect((await anon.get(`/api/webhooks/meta?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`)).statusCode).toBe(403);
    expect((await anon.get('/api/webhooks/meta')).statusCode).toBe(403);
  });
});

describe('Meta: firma X-Hub-Signature-256 (POST)', () => {
  it('acepta una firma válida (sin necesitar la cabecera CSRF)', async () => {
    const res = await postMeta({ object: 'whatsapp_business_account', entry: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rechaza con 401 una firma inválida, ausente o calculada con otro secreto', async () => {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    expect((await postMeta(payload, 'sha256=' + '0'.repeat(64))).statusCode).toBe(401);
    expect((await postMeta(payload, null)).statusCode).toBe(401);
    expect((await postMeta(payload, sign('otro-secreto', JSON.stringify(payload)))).statusCode).toBe(401);
    expect((await postMeta(payload, 'firma-sin-prefijo')).statusCode).toBe(401);
  });

  it('una firma válida de otro cuerpo no sirve (el cuerpo se verifica byte a byte)', async () => {
    const original = JSON.stringify(waPayload({ wamid: 'wamid.FIRMA', from: '34600999888', text: 'Hola' }));
    const tampered = original.replace('Hola', 'Adiós');
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/meta',
      payload: tampered,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(APP_SECRET, original) },
    });
    expect(res.statusCode).toBe(401);
    expect(await leadByWhatsApp('34600999888')).toBeNull();
  });
});

describe('WhatsApp: mensajes entrantes', () => {
  let connectionId = '';

  beforeAll(async () => {
    const res = await T.client.post('/api/integrations/channels', {
      channel: 'whatsapp',
      externalAccountId: PHONE_NUMBER_ID,
      accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
      displayName: 'WhatsApp de prueba',
      skipVerification: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    connectionId = res.json().connection.id;
    expect(res.json().connection.credentialsEnc).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain('token-de-prueba');
    const list = (await T.client.get('/api/integrations')).json();
    expect(list.channels.map((c: { id: string }) => c.id)).toContain(connectionId);
  });

  it('un mensaje nuevo crea lead + conversación + mensaje y programa la respuesta de KAI', async () => {
    const res = await postMeta(waPayload({ wamid: 'wamid.HBgLMzQ2MDAxMTEyMjIVAgASGBQzQUY', from: '34600111222', text: 'Hola, quiero información para ponerme en forma' }));
    expect(res.statusCode).toBe(200);

    const lead = await leadByWhatsApp('34600111222');
    expect(lead).not.toBeNull();
    expect(lead!).toMatchObject({ name: 'Pedro Ruiz', phone: '+34600111222', source: 'whatsapp', isTest: false, status: 'conversing' });

    const convs = await getDb().select().from(conversations).where(eq(conversations.leadId, lead!.id));
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: 'whatsapp', channelConnectionId: connectionId, businessId: T.businessId });

    const msgs = await getDb().select().from(messages).where(eq(messages.conversationId, convs[0].id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'inbound', senderType: 'lead', content: 'Hola, quiero información para ponerme en forma', externalId: 'wamid.HBgLMzQ2MDAxMTEyMjIVAgASGBQzQUY' });

    const jobs = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `reply:${convs[0].id}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'kai_reply', status: 'pending', businessId: T.businessId });
    expect((jobs[0].payload as { conversationId: string }).conversationId).toBe(convs[0].id);
    // Con retardo humano (no se responde en el mismo segundo).
    expect(jobs[0].runAt.getTime()).toBeGreaterThan(Date.now());

    // Aparece en la bandeja del entrenador.
    const inbox = (await T.client.get('/api/inbox')).json();
    expect(inbox.items.map((i: { lead: { id: string } }) => i.lead.id)).toContain(lead!.id);
  });

  it('es idempotente: el mismo wamid dos veces = un solo mensaje y una sola respuesta programada', async () => {
    const payload = waPayload({ wamid: 'wamid.DUPLICADO-001', from: '34611222333', text: 'Hola, ¿cuánto cuesta?', name: 'Clara Díaz' });
    expect((await postMeta(payload)).statusCode).toBe(200);
    expect((await postMeta(payload)).statusCode).toBe(200);

    const lead = await leadByWhatsApp('34611222333');
    expect(lead).not.toBeNull();
    const msgs = await getDb().select().from(messages).where(eq(messages.leadId, lead!.id));
    expect(msgs).toHaveLength(1);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead!.id));
    const pending = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `reply:${conv.id}`), eq(scheduledJobs.status, 'pending')));
    expect(pending).toHaveLength(1);
    const allLeads = await getDb().select().from(leads).where(eq(leads.whatsappId, '34611222333'));
    expect(allLeads).toHaveLength(1);
  });

  it('varios mensajes seguidos del mismo lead se agrupan en una sola respuesta pendiente', async () => {
    expect((await postMeta(waPayload({ wamid: 'wamid.RAFAGA-1', from: '34622333444', text: 'Hola', name: 'Iván' }))).statusCode).toBe(200);
    expect((await postMeta(waPayload({ wamid: 'wamid.RAFAGA-2', from: '34622333444', text: 'Quería preguntarte una cosa', name: 'Iván' }))).statusCode).toBe(200);
    const lead = await leadByWhatsApp('34622333444');
    const msgs = await getDb().select().from(messages).where(eq(messages.leadId, lead!.id));
    expect(msgs).toHaveLength(2);
    const [conv] = await getDb().select().from(conversations).where(eq(conversations.leadId, lead!.id));
    const pending = await getDb()
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.dedupeKey, `reply:${conv.id}`), eq(scheduledJobs.status, 'pending')));
    expect(pending).toHaveLength(1);
  });

  it('ignora mensajes de un número de WhatsApp que no está conectado a ningún negocio', async () => {
    const res = await postMeta(waPayload({ wamid: 'wamid.DESCONOCIDO', from: '34633444555', text: 'Hola', phoneNumberId: '999999999999' }));
    expect(res.statusCode).toBe(200);
    expect(await getDb().select().from(leads).where(eq(leads.whatsappId, '34633444555'))).toHaveLength(0);
  });

  it('otro negocio no puede conectar el mismo número para quedarse con sus mensajes', async () => {
    const other = await registerTrainer(app, { businessName: 'Negocio Ajeno' });
    const res = await other.client.post('/api/integrations/channels', {
      channel: 'whatsapp',
      externalAccountId: PHONE_NUMBER_ID,
      accessToken: 'EAAG-otro-token-0123456789abcdef',
      skipVerification: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/otro negocio/i);
  });

  it('las actualizaciones de estado de Meta marcan los mensajes como entregados/leídos', async () => {
    const lead = await leadByWhatsApp('34600111222');
    const [msg] = await getDb().select().from(messages).where(eq(messages.leadId, lead!.id));
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'x', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [{ id: msg.externalId, status: 'read' }] } }] }],
    };
    expect((await postMeta(payload)).statusCode).toBe(200);
    const [after] = await getDb().select().from(messages).where(eq(messages.id, msg.id));
    expect(after.status).toBe('read');
  });
});

describe('webhook de leads (servidor a servidor)', () => {
  let publicKey = '';
  let secret = '';

  beforeAll(async () => {
    const integ = (await T.client.get('/api/integrations')).json();
    publicKey = integ.endpoints.publicKey;
    expect(integ.endpoints.leadsWebhookUrl).toContain(`/api/webhooks/leads/${publicKey}`);
    secret = (await T.client.get('/api/integrations/webhook-secret')).json().secret;
    expect(secret).toMatch(/^kai_sk_/);
  });

  const postLead = (payload: unknown, headers: Record<string, string> = {}, key = publicKey) => {
    const body = JSON.stringify(payload);
    return app.inject({ method: 'POST', url: `/api/webhooks/leads/${key}`, payload: body, headers: { 'content-type': 'application/json', ...headers } });
  };

  it('con la X-KAI-Key correcta crea el lead (sin cabecera CSRF)', async () => {
    const res = await postLead({ name: 'Marina Webhook', email: 'marina.webhook@example.com', goal: 'Tonificar', source_detail: 'Zapier' }, { 'x-kai-key': secret });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, created: true });
    const [lead] = await getDb().select().from(leads).where(eq(leads.id, res.json().leadId));
    expect(lead).toMatchObject({ businessId: T.businessId, name: 'Marina Webhook', email: 'marina.webhook@example.com', source: 'webhook', sourceDetail: 'Zapier', goalSummary: 'Tonificar' });

    // Mismo email otra vez: no se duplica.
    const again = await postLead({ name: 'Marina Webhook', email: 'MARINA.WEBHOOK@example.com' }, { 'x-kai-key': secret });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, leadId: res.json().leadId });
  });

  it('rechaza con 401 una clave incorrecta o ausente', async () => {
    expect((await postLead({ name: 'Intruso', email: 'intruso@example.com' }, { 'x-kai-key': 'kai_sk_falsa' })).statusCode).toBe(401);
    expect((await postLead({ name: 'Intruso', email: 'intruso@example.com' })).statusCode).toBe(401);
    expect(await getDb().select().from(leads).where(eq(leads.email, 'intruso@example.com'))).toHaveLength(0);
  });

  it('acepta una X-KAI-Signature válida (HMAC del cuerpo) y rechaza una inválida', async () => {
    const payload = { name: 'Firma Válida', phone: '+34 600 777 888' };
    const body = JSON.stringify(payload);
    const ok = await postLead(payload, { 'x-kai-signature': sign(secret, body) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().created).toBe(true);

    const bad = await postLead({ name: 'Firma Mala', phone: '+34 600 777 999' }, { 'x-kai-signature': sign('otro-secreto', JSON.stringify({ name: 'Firma Mala', phone: '+34 600 777 999' })) });
    expect(bad.statusCode).toBe(401);
    // La firma de otro cuerpo tampoco sirve.
    const replay = await postLead({ name: 'Firma Mala', phone: '+34 600 777 999' }, { 'x-kai-signature': sign(secret, body) });
    expect(replay.statusCode).toBe(401);
    expect(await getDb().select().from(leads).where(eq(leads.name, 'Firma Mala'))).toHaveLength(0);
  });

  it('una clave pública desconocida devuelve 404 y los datos vacíos 400', async () => {
    expect((await postLead({ name: 'X' }, { 'x-kai-key': secret }, 'kai_pk_no_existe')).statusCode).toBe(404);
    expect((await postLead({}, { 'x-kai-key': secret })).statusCode).toBe(400);
  });

  it('al rotar el secreto, el anterior deja de funcionar', async () => {
    const rotated = await T.client.post('/api/integrations/webhook-secret/rotate');
    expect(rotated.statusCode).toBe(200);
    const newSecret = rotated.json().secret as string;
    expect(newSecret).not.toBe(secret);
    expect((await postLead({ name: 'Con secreto viejo', email: 'viejo@example.com' }, { 'x-kai-key': secret })).statusCode).toBe(401);
    expect((await postLead({ name: 'Con secreto nuevo', email: 'nuevo@example.com' }, { 'x-kai-key': newSecret })).statusCode).toBe(200);
    secret = newSecret;
  });
});

describe('formulario público', () => {
  let publicKey = '';
  beforeAll(async () => {
    publicKey = (await T.client.get('/api/integrations')).json().endpoints.publicKey;
  });

  const postForm = (payload: unknown, key = publicKey) => anon.post(`/api/public/forms/${key}`, payload, { csrf: false });

  it('con el campo trampa “website” relleno responde ok pero NO crea el lead', async () => {
    const res = await postForm({ name: 'Bot Spam', email: 'bot.spam@example.com', website: 'https://spam.example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await getDb().select().from(leads).where(eq(leads.email, 'bot.spam@example.com'))).toHaveLength(0);
  });

  it('sin el campo trampa crea el lead con origen “landing”', async () => {
    const res = await postForm({ name: 'Sara Landing', email: 'sara.landing@example.com', goal: 'Perder 5 kilos', message: 'Os escribo desde la web' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const rows = await getDb().select().from(leads).where(eq(leads.email, 'sara.landing@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessId: T.businessId, name: 'Sara Landing', source: 'landing', isTest: false, goalSummary: 'Perder 5 kilos' });
    expect(rows[0].notes).toContain('Os escribo desde la web');
  });

  it('exige teléfono o email y una clave pública válida', async () => {
    expect((await postForm({ name: 'Sin contacto' })).statusCode).toBe(400);
    expect((await postForm({ name: 'X', email: 'x@example.com' }, 'kai_pk_inexistente')).statusCode).toBe(404);
  });

  it('el preflight CORS está permitido', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: `/api/public/forms/${publicKey}` });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('con WhatsApp conectado, teléfono y consentimiento para WhatsApp, programa el primer contacto por WhatsApp', async () => {
    // El formulario público solo escribe por WhatsApp si lo pide expresamente (como hace el generador de KAI).
    const res = await postForm({ name: 'Jorge Teléfono', phone: '600 555 444', contact_via_whatsapp: true });
    expect(res.statusCode).toBe(200);
    const [lead] = await getDb().select().from(leads).where(and(eq(leads.businessId, T.businessId), eq(leads.name, 'Jorge Teléfono')));
    expect(lead.phone).toBe('+34600555444');
    const jobs = await getDb().select().from(scheduledJobs).where(eq(scheduledJobs.dedupeKey, `first_contact:${lead.id}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'first_contact', status: 'pending' });
  });
});
