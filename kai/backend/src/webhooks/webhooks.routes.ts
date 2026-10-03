import { TRIAL_DAYS } from '../config/defaults.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env, isProduction } from '../config/env.js';
import { parse } from '../lib/http.js';
import { logError } from '../audit/audit.service.js';
import { verifyMetaSignature } from '../integrations/meta/graph.js';
import { handleMetaWebhook } from './meta.webhook.js';
import { handleCalendlyEvent, verifyCalendlyRequest } from './calendly.webhook.js';
import { businessByPublicKey, ExternalLeadSchema, ingestFromForm, verifyLeadWebhookAuth } from './leads.webhook.js';
import { listPublicPlans } from '../plans/plans.service.js';

export async function webhookRoutes(app: FastifyInstance) {
  // ───────────── Meta (WhatsApp, Instagram, Lead Ads) ─────────────
  // Verificación de la suscripción (Meta llama con GET al configurar el webhook).
  app.get('/webhooks/meta', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && env.META_VERIFY_TOKEN && q['hub.verify_token'] === env.META_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'verify_token_mismatch' });
  });

  app.post('/webhooks/meta', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    if (env.META_APP_SECRET) {
      if (!verifyMetaSignature(request.rawBody, signature)) return reply.code(401).send({ error: 'invalid_signature' });
    } else if (isProduction()) {
      return reply.code(503).send({ error: 'META_APP_SECRET no configurado' });
    }
    try {
      await handleMetaWebhook(request.body as Parameters<typeof handleMetaWebhook>[0]);
    } catch (err) {
      await logError('webhook.meta.handler', err);
    }
    // Meta reintenta si no recibe 200: respondemos 200 aunque un evento concreto falle (queda registrado).
    return { ok: true };
  });

  // ───────────── Calendly ─────────────
  app.post('/webhooks/calendly/:businessId', async (request, reply) => {
    const { businessId } = parse(z.object({ businessId: z.string().uuid() }), request.params);
    const conn = await verifyCalendlyRequest(businessId, request.rawBody, request.headers['calendly-webhook-signature'] as string | undefined);
    if (!conn) return reply.code(401).send({ error: 'invalid_signature' });
    try {
      return await handleCalendlyEvent(businessId, conn.id, request.body as Parameters<typeof handleCalendlyEvent>[2]);
    } catch (err) {
      await logError('webhook.calendly', err, {}, businessId);
      return reply.code(500).send({ error: 'processing_failed' });
    }
  });

  // ───────────── Leads externos (servidor a servidor) ─────────────
  app.post('/webhooks/leads/:publicKey', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { publicKey } = parse(z.object({ publicKey: z.string().max(80) }), request.params);
    const business = await businessByPublicKey(publicKey);
    if (!business) return reply.code(404).send({ error: 'not_found' });
    const ok = verifyLeadWebhookAuth(business, request.rawBody, request.headers['x-kai-key'] as string | undefined, request.headers['x-kai-signature'] as string | undefined);
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
    const data = parse(ExternalLeadSchema, request.body);
    if (!data.name && !data.email && !data.phone && !data.instagram) return reply.code(400).send({ error: 'Se necesita al menos nombre, email, teléfono o Instagram.' });
    const result = await ingestFromForm(business, data, 'webhook');
    return { ok: true, leadId: result.lead.id, created: result.created };
  });

  // ───────────── Formularios web públicos (desde el navegador) ─────────────
  app.options('/public/forms/:publicKey', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'POST, OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type').code(204).send();
  });

  app.post('/public/forms/:publicKey', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const { publicKey } = parse(z.object({ publicKey: z.string().max(80) }), request.params);
    const business = await businessByPublicKey(publicKey);
    if (!business) return reply.code(404).send({ error: 'not_found' });
    const data = parse(ExternalLeadSchema, request.body);
    if (data.website) return { ok: true }; // trampa anti-bots: se ignora en silencio
    if (!data.phone && !data.email) return reply.code(400).send({ error: 'Indica un teléfono o un email.' });
    await ingestFromForm(business, { ...data, source: 'landing' }, 'landing');
    return { ok: true };
  });

  app.get('/public/plans', async () => ({ plans: await listPublicPlans(), trialDays: TRIAL_DAYS }));
}
