/**
 * Entrada de leads desde landing pages, formularios y herramientas externas (Zapier, Make…).
 *
 *  - POST /api/webhooks/leads/{publicKey}   → servidor a servidor. Requiere la cabecera
 *      X-KAI-Key: {secreto}    o    X-KAI-Signature: sha256={HMAC del cuerpo con el secreto}
 *  - POST /api/public/forms/{publicKey}     → formularios web (navegador). Sin secreto, con
 *      límite de peticiones y campo trampa anti-spam (“website” debe ir vacío).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../database/client.js';
import { businesses, leads } from '../database/schema.js';
import { env } from '../config/env.js';
import { createAlert } from '../crm/alerts.service.js';
import { decrypt, hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import { toWhatsAppId } from '../integrations/channels/phone.js';
import { getActiveConnection } from '../integrations/connections.service.js';
import { ingestExternalLead } from './inbound.service.js';

export const ExternalLeadSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  instagram: z.string().trim().max(60).optional(),
  goal: z.string().trim().max(500).optional(),
  message: z.string().trim().max(2000).optional(),
  source: z.enum(['landing', 'webhook']).optional(),
  source_detail: z.string().trim().max(120).optional(),
  contact_via_whatsapp: z.boolean().optional(),
  // Datos adicionales: como mucho 20 campos (todo acaba en las notas del lead y en el contexto de KAI).
  extra: z
    .record(z.string().trim().min(1).max(60), z.string().max(500))
    .refine((o) => Object.keys(o).length <= 20, 'admite como máximo 20 campos')
    .optional(),
  website: z.string().max(500).optional(),
});

export async function businessByPublicKey(publicKey: string) {
  const [b] = await getDb().select().from(businesses).where(eq(businesses.publicKey, publicKey)).limit(1);
  return b && b.status === 'active' ? b : null;
}

export function verifyLeadWebhookAuth(business: typeof businesses.$inferSelect, rawBody: string | undefined, key?: string, signature?: string): boolean {
  let secret: string;
  try {
    secret = decrypt(business.webhookSecretEnc);
  } catch {
    return false;
  }
  if (key && safeEqual(key, secret)) return true;
  if (signature && rawBody) return safeEqual(signature, `sha256=${hmacSha256Hex(secret, rawBody)}`);
  return false;
}

/**
 * Freno anti-abuso del formulario público (no lleva secreto: la clave pública está en la web).
 * Limita los leads NUEVOS por negocio y hora/día, aunque lleguen desde muchas IPs distintas, para que
 * nadie pueda agotar el cupo de leads del plan ni usar KAI para escribir por WhatsApp a números ajenos.
 */
export async function publicFormQuotaExceeded(businessId: string): Promise<boolean> {
  const now = Date.now();
  const [row] = await getDb()
    .select({
      lastHour: sql<number>`count(*) filter (where ${leads.createdAt} >= ${new Date(now - 3600_000)})::int`,
      lastDay: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(and(eq(leads.businessId, businessId), eq(leads.source, 'landing'), eq(leads.isTest, false), gte(leads.createdAt, new Date(now - 86_400_000))));
  const exceeded = Number(row?.lastHour ?? 0) >= env.PUBLIC_FORM_MAX_PER_HOUR || Number(row?.lastDay ?? 0) >= env.PUBLIC_FORM_MAX_PER_DAY;
  if (exceeded) {
    await createAlert({
      businessId,
      type: 'integration_error',
      severity: 'warning',
      title: 'Tu formulario web está recibiendo demasiados envíos',
      body:
        `Han llegado más de ${env.PUBLIC_FORM_MAX_PER_HOUR} leads nuevos en una hora (o ${env.PUBLIC_FORM_MAX_PER_DAY} en un día) desde el formulario de tu web. ` +
        'Para protegerte del spam y de agotar el cupo de leads de tu plan, KAI ha dejado de aceptar envíos del formulario durante un rato. ' +
        'Si es tráfico real de una campaña, contacta con soporte para ampliar el límite.',
      dedupeByTitle: true,
    });
  }
  return exceeded;
}

export async function ingestFromForm(business: typeof businesses.$inferSelect, data: z.infer<typeof ExternalLeadSchema>, defaultSource: 'landing' | 'webhook') {
  const whatsapp = await getActiveConnection(business.id, 'whatsapp');
  const waId = data.phone ? toWhatsAppId(data.phone, business.timezone) : null;
  // Formulario público: KAI solo escribe por WhatsApp si el formulario lo pide expresamente
  // (casilla de consentimiento). El webhook de servidor (con secreto) mantiene el comportamiento por defecto.
  const wantsWhatsApp = data.contact_via_whatsapp ?? defaultSource === 'webhook';
  const viaWhatsApp = wantsWhatsApp && Boolean(whatsapp) && Boolean(waId);
  return ingestExternalLead({
    businessId: business.id,
    source: data.source ?? defaultSource,
    sourceDetail: data.source_detail ?? null,
    name: data.name ?? null,
    email: data.email || null,
    phone: waId ? `+${waId}` : (data.phone ?? null),
    instagramUsername: data.instagram?.replace(/^@/, '') ?? null,
    goal: data.goal ?? null,
    message: data.message ?? null,
    extra: data.extra,
    firstContactChannel: viaWhatsApp ? 'whatsapp' : 'none',
    whatsappConnectionId: whatsapp?.id ?? null,
  });
}
