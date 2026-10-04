import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env, integrationAvailability, isProduction, publicApiUrl, publicAppUrl } from '../config/env.js';
import { parse, uuidParam } from '../lib/http.js';
import { badRequest, errorMessage, unavailable } from '../lib/errors.js';
import { decrypt, decryptJson, encrypt, randomToken, signPayload, verifySignedPayload } from '../lib/crypto.js';
import { requireTenant } from '../auth/guards.js';
import { getDb } from '../database/client.js';
import { businesses, calendarConnections } from '../database/schema.js';
import { audit, logError } from '../audit/audit.service.js';
import { aiModeInfo } from '../ai/providers/index.js';
import type { ChannelConfig } from '../lib/domain.js';
import { disconnectConnection, listConnections, updateConnectionConfig, upsertConnection } from './connections.service.js';
import { friendlyMetaError, graphRequest } from './meta/graph.js';
import {
  getCalendarConnection,
  listCalendarConnections,
  releaseCalendlyWebhook,
  saveCalendarConnection,
  updateCalendarConnection,
  type CalendlyCredentials,
} from '../calendar/connections.js';
import { exchangeGoogleCode, googleAuthUrl } from '../calendar/providers/google.js';
import { calendlyCreateWebhook, calendlyEventTypes, calendlyMe } from '../calendar/providers/calendly.js';

const TemplateRef = z.object({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(2).max(10) });
const ChannelConfigSchema = z.object({
  templates: z
    .object({ firstContact: TemplateRef.optional(), followUp: TemplateRef.optional(), reminder: TemplateRef.optional(), noShow: TemplateRef.optional() })
    .optional(),
  apiHost: z.enum(['graph.instagram.com', 'graph.facebook.com']).optional(),
  phoneNumber: z.string().max(40).optional(),
  wabaId: z.string().max(64).optional(),
  pageId: z.string().max(64).optional(),
  formIds: z.array(z.string().max(64)).max(50).optional(),
  firstContactChannel: z.enum(['whatsapp', 'none']).optional(),
});

/** Comprueba con Meta que el token y el identificador son válidos antes de guardar nada. */
async function verifyMetaAccount(channel: 'whatsapp' | 'instagram' | 'meta_lead_ads', id: string, token: string, config: ChannelConfig) {
  if (channel === 'whatsapp') {
    const r = await graphRequest<{ display_phone_number?: string; verified_name?: string }>('graph.facebook.com', id, token, { query: { fields: 'display_phone_number,verified_name' } });
    return { displayName: [r.verified_name, r.display_phone_number].filter(Boolean).join(' · '), phoneNumber: r.display_phone_number };
  }
  if (channel === 'instagram') {
    const r = await graphRequest<{ username?: string; name?: string }>(config.apiHost ?? 'graph.instagram.com', id, token, { query: { fields: 'username,name' } });
    return { displayName: r.username ? `@${r.username}` : (r.name ?? 'Instagram') };
  }
  const page = await graphRequest<{ name?: string }>('graph.facebook.com', id, token, { query: { fields: 'name' } });
  // Suscribe la página a la app para recibir el webhook `leadgen`.
  await graphRequest('graph.facebook.com', `${id}/subscribed_apps`, token, { method: 'POST', query: { subscribed_fields: 'leadgen' } });
  return { displayName: page.name ?? 'Página de Facebook' };
}

export async function integrationsRoutes(app: FastifyInstance) {
  app.get('/integrations', async (request) => {
    const ctx = await requireTenant(request, 'settings:read');
    const [biz] = await getDb().select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
    const api = publicApiUrl();
    return {
      server: integrationAvailability(),
      ai: aiModeInfo(),
      channels: await listConnections(ctx.businessId),
      calendars: await listCalendarConnections(ctx.businessId),
      endpoints: {
        metaWebhookUrl: `${api}/api/webhooks/meta`,
        metaVerifyTokenConfigured: Boolean(env.META_VERIFY_TOKEN),
        leadsWebhookUrl: `${api}/api/webhooks/leads/${biz.publicKey}`,
        publicFormUrl: `${api}/api/public/forms/${biz.publicKey}`,
        publicKey: biz.publicKey,
      },
    };
  });

  app.post('/integrations/channels', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const body = parse(
      z.object({
        channel: z.enum(['whatsapp', 'instagram', 'meta_lead_ads']),
        externalAccountId: z.string().trim().min(3).max(64).regex(/^\d+$/, 'El identificador debe ser numérico'),
        accessToken: z.string().trim().min(20).max(2000),
        displayName: z.string().trim().max(120).optional(),
        config: ChannelConfigSchema.default({}),
        skipVerification: z.boolean().optional(),
        /** Al cambiar de número o de cuenta: id de la conexión anterior, que se desconecta en la misma operación. */
        replacesConnectionId: z.string().uuid().optional(),
      }),
      request.body,
    );
    let verified: { displayName: string; phoneNumber?: string } = { displayName: body.displayName ?? body.channel };
    if (!(body.skipVerification && !isProduction())) {
      try {
        verified = await verifyMetaAccount(body.channel, body.externalAccountId, body.accessToken, body.config);
      } catch (err) {
        await logError('integrations.verify_meta', err, { channel: body.channel }, ctx.businessId, 'warn');
        throw badRequest(`Meta no ha aceptado los datos: ${friendlyMetaError(err)}`);
      }
    }
    const connection = await upsertConnection(ctx.businessId, ctx.userId, {
      channel: body.channel,
      externalAccountId: body.externalAccountId,
      displayName: body.displayName || verified.displayName,
      accessToken: body.accessToken,
      config: { ...body.config, ...(verified.phoneNumber ? { phoneNumber: verified.phoneNumber } : {}) },
      replacesConnectionId: body.replacesConnectionId,
    });
    return { connection };
  });

  app.patch('/integrations/channels/:id', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const { id } = parse(uuidParam, request.params);
    const body = parse(z.object({ config: ChannelConfigSchema, displayName: z.string().trim().max(120).optional() }), request.body);
    return { connection: await updateConnectionConfig(ctx.businessId, ctx.userId, id, body.config, body.displayName) };
  });

  app.delete('/integrations/channels/:id', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const { id } = parse(uuidParam, request.params);
    await disconnectConnection(ctx.businessId, ctx.userId, id);
    return { ok: true };
  });

  // ───────────── Google Calendar (OAuth) ─────────────
  app.get('/integrations/google/connect', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw unavailable('Google Calendar no está configurado en el servidor (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
    const state = signPayload({ b: ctx.businessId, u: ctx.userId, n: randomToken(8) }, 900);
    return { url: googleAuthUrl(state) };
  });

  app.get('/integrations/google/callback', async (request, reply) => {
    const q = parse(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), request.query);
    const back = (status: string) => reply.redirect(`${publicAppUrl()}/app/integraciones?google=${status}`);
    if (q.error || !q.code || !q.state) return back('cancelado');
    const state = verifySignedPayload<{ b: string; u: string }>(q.state);
    if (!request.authUser) return back('sesion');
    if (!state || state.u !== request.authUser.id) return back('error');
    try {
      const tokens = await exchangeGoogleCode(q.code);
      await saveCalendarConnection(state.b, state.u, {
        provider: 'google',
        credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt },
        accountEmail: tokens.email,
        calendarId: 'primary',
        tokenExpiresAt: new Date(tokens.expiresAt),
      });
      return back('ok');
    } catch (err) {
      await logError('calendar.google.oauth', err, {}, state.b);
      return back('error');
    }
  });

  // ───────────── Calendly ─────────────
  app.post('/integrations/calendly', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const body = parse(z.object({ token: z.string().trim().min(20).max(4000), eventTypeUri: z.string().url().optional() }), request.body);
    let me;
    try {
      me = await calendlyMe(body.token);
    } catch (err) {
      throw badRequest(`Calendly no ha aceptado el token: ${errorMessage(err)}`);
    }
    let eventTypes;
    try {
      eventTypes = await calendlyEventTypes(body.token, me.uri);
    } catch (err) {
      // Sin tocar nada: la conexión anterior (si la hay) sigue funcionando.
      throw badRequest(`Calendly no ha devuelto tus tipos de evento: ${errorMessage(err)}`);
    }
    const selected = eventTypes.find((e) => e.uri === body.eventTypeUri) ?? (eventTypes.length === 1 ? eventTypes[0] : undefined);
    // Reconexión (otro token o la misma cuenta): primero se borra el webhook anterior. Calendly no admite dos
    // con la misma URL y el viejo firmaría con una clave que ya no se guarda. Solo con el token nuevo ya validado.
    const previous = await getCalendarConnection(ctx.businessId, 'calendly');
    if (previous) await releaseCalendlyWebhook(previous);
    const signingKey = randomToken(24);
    const creds: CalendlyCredentials = { token: body.token, signingKey };
    let webhookError: string | null = null;
    try {
      creds.webhookUri = await calendlyCreateWebhook(body.token, {
        url: `${publicApiUrl()}/api/webhooks/calendly/${ctx.businessId}`,
        organization: me.current_organization,
        user: me.uri,
        signingKey,
      });
    } catch (err) {
      webhookError = errorMessage(err);
    }
    const conn = await saveCalendarConnection(ctx.businessId, ctx.userId, {
      provider: 'calendly',
      credentials: creds,
      accountEmail: me.email,
      calendarId: selected?.uri ?? null,
      schedulingUrl: selected?.scheduling_url ?? me.scheduling_url,
      config: { webhookError, userUri: me.uri },
    });
    return {
      connectionId: conn.id,
      eventTypes: eventTypes.map((e) => ({ uri: e.uri, name: e.name, duration: e.duration })),
      selected: selected?.uri ?? null,
      webhookError,
    };
  });

  app.patch('/integrations/calendly', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const body = parse(z.object({ eventTypeUri: z.string().url() }), request.body);
    const conn = await getCalendarConnection(ctx.businessId, 'calendly');
    if (!conn) throw badRequest('Calendly no está conectado.');
    const creds = decryptJson<CalendlyCredentials>(conn.credentialsEnc);
    const types = await calendlyEventTypes(creds.token, String(conn.config.userUri ?? (await calendlyMe(creds.token)).uri));
    const selected = types.find((t) => t.uri === body.eventTypeUri);
    if (!selected) throw badRequest('Ese tipo de evento no existe en tu Calendly.');
    await updateCalendarConnection(conn.id, { calendarId: selected.uri, schedulingUrl: selected.scheduling_url });
    return { ok: true };
  });

  app.delete('/integrations/calendar/:provider', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const { provider } = parse(z.object({ provider: z.enum(['google', 'calendly']) }), request.params);
    const conn = await getCalendarConnection(ctx.businessId, provider);
    if (!conn) return { ok: true };
    await releaseCalendlyWebhook(conn);
    await getDb().update(calendarConnections).set({ status: 'disconnected', updatedAt: new Date() }).where(eq(calendarConnections.id, conn.id));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'calendar.disconnected', metadata: { provider } });
    return { ok: true };
  });

  // ───────────── Secreto del webhook de leads ─────────────
  app.get('/integrations/webhook-secret', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const [biz] = await getDb().select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1);
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'integration.webhook_secret_viewed' });
    return { secret: decrypt(biz.webhookSecretEnc) };
  });

  app.post('/integrations/webhook-secret/rotate', async (request) => {
    const ctx = await requireTenant(request, 'integrations:manage');
    const secret = `kai_sk_${randomToken(24)}`;
    await getDb().update(businesses).set({ webhookSecretEnc: encrypt(secret), updatedAt: new Date() }).where(eq(businesses.id, ctx.businessId));
    await audit({ businessId: ctx.businessId, actorType: 'user', actorUserId: ctx.userId, action: 'integration.webhook_secret_rotated' });
    return { secret };
  });
}
