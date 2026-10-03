/**
 * Entrada de leads desde landing pages, formularios y herramientas externas (Zapier, Make…).
 *
 *  - POST /api/webhooks/leads/{publicKey}   → servidor a servidor. Requiere la cabecera
 *      X-KAI-Key: {secreto}    o    X-KAI-Signature: sha256={HMAC del cuerpo con el secreto}
 *  - POST /api/public/forms/{publicKey}     → formularios web (navegador). Sin secreto, con
 *      límite de peticiones y campo trampa anti-spam (“website” debe ir vacío).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../database/client.js';
import { businesses } from '../database/schema.js';
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
  extra: z.record(z.string(), z.string().max(500)).optional(),
  website: z.string().optional(),
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

export async function ingestFromForm(business: typeof businesses.$inferSelect, data: z.infer<typeof ExternalLeadSchema>, defaultSource: 'landing' | 'webhook') {
  const whatsapp = await getActiveConnection(business.id, 'whatsapp');
  const waId = data.phone ? toWhatsAppId(data.phone, business.timezone) : null;
  const viaWhatsApp = (data.contact_via_whatsapp ?? true) && Boolean(whatsapp) && Boolean(waId);
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
