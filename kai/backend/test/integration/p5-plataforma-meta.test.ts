/**
 * Revisión nº5 — grupo «plataforma»: una sola app de Meta (la de KAI).
 *  - Al conectar un canal, un token de otra app de Meta se rechaza con una explicación (antes quedaba «Conectado» y
 *    los avisos de Meta, firmados con el secreto de esa otra app, se rechazaban con 401 sin dejar rastro).
 *  - La cuenta de WhatsApp Business y la de Instagram se suscriben solas a la app de KAI (el entrenador no configura
 *    ningún webhook).
 *  - Los avisos con firma no válida quedan registrados (con la cuenta y el negocio), sin llenar los registros.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { env } from '../../src/config/env.js';
import { getDb } from '../../src/database/client.js';
import { channelConnections, errorLogs } from '../../src/database/schema.js';
import { metaAccountIds } from '../../src/webhooks/webhooks.routes.js';
import { registerTrainer, setupTestApp, teardownTestApp, type Trainer } from './helpers.js';

const KAI_APP = '700100200300';
let app: FastifyInstance;
let savedAppId: string | undefined;
beforeAll(async () => {
  app = await setupTestApp();
  savedAppId = env.META_APP_ID;
  env.META_APP_ID = KAI_APP;
});
afterAll(async () => {
  env.META_APP_ID = savedAppId;
  await teardownTestApp(app);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Call = { method: string; host: string; path: string; query: Record<string, string>; auth: string | null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Simula la Graph API: `routes` responde según «MÉTODO host/ruta» (sin versión). Devuelve las llamadas hechas. */
function fakeGraph(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'graph.facebook.com' && url.hostname !== 'graph.instagram.com') throw new Error(`Red no permitida en tests: ${url}`);
    const call: Call = {
      method: init?.method ?? 'GET',
      host: url.hostname,
      path: url.pathname.replace(/^\/v[\d.]+\//, ''),
      query: Object.fromEntries(url.searchParams),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.host}/${call.path}`];
    if (!handler) return json({ error: { message: `Ruta no simulada: ${call.method} ${call.path}`, code: 100 } }, 400);
    return handler(call);
  });
  return calls;
}

const connectionsOf = (businessId: string) => getDb().select().from(channelConnections).where(eq(channelConnections.businessId, businessId));

describe('Conectar WhatsApp con la app de Meta de KAI', () => {
  let T: Trainer;
  beforeAll(async () => {
    T = await registerTrainer(app, { businessName: 'Negocio Meta P5' });
  });

  it('un token de otra app de Meta se rechaza con una explicación y no se guarda nada', async () => {
    const calls = fakeGraph({
      'GET graph.facebook.com/debug_token': () => json({ data: { app_id: '999888777', is_valid: true, granular_scopes: [] } }),
      'GET graph.facebook.com/551000000000001': () => json({ display_phone_number: '+34 600 000 001', verified_name: 'Estudio' }),
    });
    const res = await T.client.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: '551000000000001', accessToken: 'EAAG-token-de-otra-app-0123456789' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/otra app de Meta \(identificador 999888777\)/);
    expect(res.json().message).toMatch(/no te llegaría ningún mensaje/);
    expect(res.json().message).not.toMatch(/^Meta no ha aceptado/);
    // Se consulta con el token de la app de KAI (id|secreto), nunca con el del entrenador.
    const debug = calls.find((c) => c.path === 'debug_token')!;
    expect(debug.auth).toBe(`Bearer ${KAI_APP}|test-app-secret`);
    expect(debug.query.input_token).toBe('EAAG-token-de-otra-app-0123456789');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(await connectionsOf(T.businessId)).toHaveLength(0);
  });

  it('con un token de la app de KAI suscribe su cuenta de WhatsApp Business a la app y la guarda', async () => {
    const calls = fakeGraph({
      'GET graph.facebook.com/debug_token': () =>
        json({ data: { app_id: KAI_APP, is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['330000000000001'] }] } }),
      'GET graph.facebook.com/551000000000002': () => json({ display_phone_number: '+34 600 000 002', verified_name: 'Estudio Laura' }),
      'POST graph.facebook.com/330000000000001/subscribed_apps': () => json({ success: true }),
    });
    const res = await T.client.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: '551000000000002', accessToken: 'EAAG-token-de-kai-0123456789abcdef' });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['330000000000001/subscribed_apps']);
    expect(res.json().connection.config).toMatchObject({ wabaId: '330000000000001', phoneNumber: '+34 600 000 002' });
  });

  it('si el token da acceso a varias cuentas de WhatsApp Business, suscribe la que tiene el número', async () => {
    const calls = fakeGraph({
      'GET graph.facebook.com/debug_token': () =>
        json({
          data: {
            app_id: KAI_APP,
            granular_scopes: [
              { scope: 'whatsapp_business_management', target_ids: ['330000000000010', '330000000000011'] },
              { scope: 'whatsapp_business_messaging', target_ids: ['330000000000010', '330000000000011'] },
            ],
          },
        }),
      'GET graph.facebook.com/551000000000003': () => json({ display_phone_number: '+34 600 000 003', verified_name: 'Estudio' }),
      'GET graph.facebook.com/330000000000010/phone_numbers': () => json({ data: [{ id: '551000000000999' }] }),
      'GET graph.facebook.com/330000000000011/phone_numbers': () => json({ data: [{ id: '551000000000003' }] }),
      'POST graph.facebook.com/330000000000011/subscribed_apps': () => json({ success: true }),
    });
    const other = await registerTrainer(app, { businessName: 'Negocio Varias WABA' });
    const res = await other.client.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: '551000000000003', accessToken: 'EAAG-token-de-kai-0123456789abcdef' });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['330000000000011/subscribed_apps']);
    expect(res.json().connection.config.wabaId).toBe('330000000000011');
  });

  it('si Meta no deja suscribir la cuenta (falta un permiso), no se da por conectada', async () => {
    fakeGraph({
      'GET graph.facebook.com/debug_token': () => json({ data: { app_id: KAI_APP, granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['330000000000020'] }] } }),
      'GET graph.facebook.com/551000000000004': () => json({ display_phone_number: '+34 600 000 004' }),
      'POST graph.facebook.com/330000000000020/subscribed_apps': () => json({ error: { message: '(#200) Permissions error', code: 200 } }, 403),
    });
    const other = await registerTrainer(app, { businessName: 'Negocio Sin Permiso' });
    const res = await other.client.post('/api/integrations/channels', { channel: 'whatsapp', externalAccountId: '551000000000004', accessToken: 'EAAG-token-de-kai-0123456789abcdef' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/le falta un permiso/);
    expect(await connectionsOf(other.businessId)).toHaveLength(0);
  });

  it('sin META_APP_ID en el servidor no se puede comprobar la app y se conecta como antes (con la cuenta indicada)', async () => {
    env.META_APP_ID = undefined;
    try {
      const calls = fakeGraph({
        'GET graph.facebook.com/551000000000005': () => json({ display_phone_number: '+34 600 000 005' }),
        'POST graph.facebook.com/330000000000030/subscribed_apps': () => json({ success: true }),
      });
      const other = await registerTrainer(app, { businessName: 'Negocio Sin AppId' });
      const res = await other.client.post('/api/integrations/channels', {
        channel: 'whatsapp',
        externalAccountId: '551000000000005',
        accessToken: 'EAAG-token-de-kai-0123456789abcdef',
        config: { wabaId: '330000000000030' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET 551000000000005', 'POST 330000000000030/subscribed_apps']);
    } finally {
      env.META_APP_ID = KAI_APP;
    }
  });

  it('la pantalla de Integraciones recibe el identificador de la app de KAI (para elegirla al generar los tokens)', async () => {
    const res = await T.client.get('/api/integrations');
    expect(res.statusCode).toBe(200);
    expect(res.json().endpoints.metaAppId).toBe(KAI_APP);
  });
});

describe('Conectar Instagram y Lead Ads', () => {
  it('Instagram (inicio de sesión con Instagram): activa los avisos de mensajes de la cuenta', async () => {
    const calls = fakeGraph({
      'GET graph.instagram.com/17841400000000001': () => json({ username: 'estudio_laura' }),
      'POST graph.instagram.com/me/subscribed_apps': () => json({ success: true }),
    });
    const T = await registerTrainer(app, { businessName: 'Negocio IG P5' });
    const res = await T.client.post('/api/integrations/channels', { channel: 'instagram', externalAccountId: '17841400000000001', accessToken: 'IGAA-token-de-prueba-0123456789' });
    expect(res.statusCode, res.body).toBe(200);
    const sub = calls.find((c) => c.method === 'POST')!;
    expect(sub).toMatchObject({ host: 'graph.instagram.com', path: 'me/subscribed_apps', query: { subscribed_fields: 'messages' } });
    // Los tokens de Instagram no se consultan con debug_token (no son de graph.facebook.com).
    expect(calls.some((c) => c.path === 'debug_token')).toBe(false);
  });

  it('Lead Ads con un token de otra app: rechazado antes de suscribir la página', async () => {
    const calls = fakeGraph({
      'GET graph.facebook.com/debug_token': () => json({ data: { app_id: '999888777' } }),
    });
    const T = await registerTrainer(app, { businessName: 'Negocio Anuncios P5' });
    const res = await T.client.post('/api/integrations/channels', { channel: 'meta_lead_ads', externalAccountId: '104000000000001', accessToken: 'EAAG-token-de-otra-app-0123456789' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/otra app de Meta/);
    expect(calls.some((c) => c.path.endsWith('subscribed_apps'))).toBe(false);
  });
});

describe('Avisos de Meta con firma no válida', () => {
  const post = (payload: unknown, secret: string | null) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    return app.inject({ method: 'POST', url: '/api/webhooks/meta', payload: body, headers });
  };
  const waPayload = (wabaId: string, phoneId: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, messages: [{ from: '34600111222', id: `wamid.${Date.now()}`, type: 'text', text: { body: 'Hola' } }] } }] }],
  });
  const badSignatureLogs = (businessId: string) =>
    getDb()
      .select()
      .from(errorLogs)
      .where(and(eq(errorLogs.source, 'webhook.meta.invalid_signature'), eq(errorLogs.businessId, businessId)));

  it('se rechazan con 401 y quedan registrados con la cuenta y el negocio, una vez por hora y cuenta', async () => {
    const T = await registerTrainer(app, { businessName: 'Negocio Firma P5' });
    const res = await T.client.post('/api/integrations/channels', {
      channel: 'whatsapp',
      externalAccountId: '551000000000077',
      accessToken: 'EAAG-token-de-prueba-0123456789abcdef',
      skipVerification: true,
    });
    expect(res.statusCode, res.body).toBe(200);

    // Firmado con el secreto de la app que se creó el entrenador (no la de KAI).
    const r1 = await post(waPayload('330000000000077', '551000000000077'), 'secreto-de-otra-app');
    expect(r1.statusCode).toBe(401);
    const logs = await badSignatureLogs(T.businessId);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('warn');
    expect(logs[0].message).toMatch(/otra app de Meta/);
    expect(logs[0].context).toMatchObject({ object: 'whatsapp_business_account', accounts: ['330000000000077', '551000000000077'] });

    // Meta reintenta: no se repite el registro.
    expect((await post(waPayload('330000000000077', '551000000000077'), 'secreto-de-otra-app')).statusCode).toBe(401);
    expect(await badSignatureLogs(T.businessId)).toHaveLength(1);
  });

  it('sin firma también se rechaza (y se distingue en el registro)', async () => {
    const r = await post({ object: 'page', entry: [{ id: '104999999999999', changes: [] }] }, null);
    expect(r.statusCode).toBe(401);
    const [log] = await getDb()
      .select()
      .from(errorLogs)
      .where(eq(errorLogs.source, 'webhook.meta.invalid_signature'))
      .then((rows) => rows.filter((l) => (l.context as { accounts?: string[] }).accounts?.includes('104999999999999')));
    expect(log.message).toMatch(/sin firma/);
    expect(log.businessId).toBeNull();
  });

  it('solo se toman identificadores numéricos y pocos (el cuerpo no está autenticado)', () => {
    expect(metaAccountIds({ entry: [{ id: '123', changes: [{ value: { metadata: { phone_number_id: '456' } } }] }, { id: 'x; drop table' }] })).toEqual(['123', '456']);
    expect(metaAccountIds({ entry: Array.from({ length: 20 }, (_, i) => ({ id: String(1000 + i) })) })).toHaveLength(5);
    expect(metaAccountIds(null)).toEqual([]);
    expect(metaAccountIds({ entry: 'no' })).toEqual([]);
  });
});
