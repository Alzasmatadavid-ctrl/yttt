/**
 * Webhook único de Meta para:
 *  - WhatsApp Business Cloud API  (object = "whatsapp_business_account")
 *  - Instagram Messaging          (object = "instagram")
 *  - Facebook/Instagram Lead Ads  (object = "page", field = "leadgen")
 *
 * Documentación: https://developers.facebook.com/docs/graph-api/webhooks
 * URL a configurar en el panel de Meta: {API_URL}/api/webhooks/meta
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, conversations, messages, webhookEvents } from '../database/schema.js';
import { errorMessage } from '../lib/errors.js';
import { logError } from '../audit/audit.service.js';
import { connectionCredentials, findConnectionByExternalId, getActiveConnection, touchConnection, type ChannelConnection } from '../integrations/connections.service.js';
import { graphRequest } from '../integrations/meta/graph.js';
import { insertMessage } from '../crm/conversations.service.js';
import { findExistingLead } from '../crm/leads.service.js';
import { toWhatsAppId } from '../integrations/channels/phone.js';
import { ingestExternalLead, receiveInboundMessage } from './inbound.service.js';

// ───────────── Tipos mínimos del payload de Meta ─────────────

interface WaMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
}
interface WaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errors?: { title?: string; message?: string }[];
}
interface WaValue {
  metadata?: { phone_number_id: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
}
interface IgMessaging {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: { mid: string; text?: string; is_echo?: boolean; attachments?: unknown[]; is_deleted?: boolean };
}
interface MetaPayload {
  object: string;
  entry?: {
    id: string;
    changes?: { field: string; value: unknown }[];
    messaging?: IgMessaging[];
  }[];
}

export async function handleMetaWebhook(payload: MetaPayload): Promise<{ processed: number }> {
  let processed = 0;
  for (const entry of payload.entry ?? []) {
    try {
      if (payload.object === 'whatsapp_business_account') {
        for (const change of entry.changes ?? []) if (change.field === 'messages') processed += await handleWhatsApp(change.value as WaValue);
      } else if (payload.object === 'instagram') {
        processed += await handleInstagram(entry.id, entry.messaging ?? []);
      } else if (payload.object === 'page') {
        for (const change of entry.changes ?? []) if (change.field === 'leadgen') processed += await handleLeadgen(change.value as LeadgenValue);
      }
    } catch (err) {
      await logError('webhook.meta', err, { object: payload.object, entryId: entry.id });
    }
  }
  return { processed };
}

// ───────────── WhatsApp ─────────────

function waText(m: WaMessage): { text: string; contentType: 'text' | 'media' | 'unsupported' } {
  if (m.type === 'text' && m.text) return { text: m.text.body, contentType: 'text' };
  if (m.type === 'button' && m.button) return { text: m.button.text, contentType: 'text' };
  if (m.type === 'interactive' && m.interactive) return { text: m.interactive.button_reply?.title ?? m.interactive.list_reply?.title ?? '', contentType: 'text' };
  const labels: Record<string, string> = { image: '📷 Imagen', audio: '🎤 Audio', video: '🎬 Vídeo', document: '📄 Documento', sticker: 'Sticker', location: '📍 Ubicación', contacts: 'Contacto' };
  return { text: `[${labels[m.type] ?? 'Mensaje no soportado'}]`, contentType: labels[m.type] ? 'media' : 'unsupported' };
}

async function handleWhatsApp(value: WaValue): Promise<number> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return 0;
  const connection = await findConnectionByExternalId('whatsapp', phoneNumberId);
  if (!connection) return 0;
  await touchConnection(connection.id);
  let n = 0;
  for (const m of value.messages ?? []) {
    const contact = value.contacts?.find((c) => c.wa_id === m.from);
    const { text, contentType } = waText(m);
    await receiveInboundMessage({
      businessId: connection.businessId,
      channel: 'whatsapp',
      channelConnectionId: connection.id,
      externalMessageId: m.id,
      text,
      contentType,
      sentAt: new Date(Number(m.timestamp) * 1000),
      profile: { name: contact?.profile?.name ?? null, whatsappId: m.from, phone: `+${m.from}` },
    });
    n++;
  }
  for (const st of value.statuses ?? []) {
    const error = st.status === 'failed' ? (st.errors?.[0]?.message ?? st.errors?.[0]?.title ?? 'Error de entrega') : null;
    await getDb()
      .update(messages)
      .set({ status: st.status, ...(error ? { error } : {}) })
      .where(and(eq(messages.businessId, connection.businessId), eq(messages.externalId, st.id)));
  }
  return n;
}

// ───────────── Instagram ─────────────

async function instagramProfile(connection: ChannelConnection, igsid: string) {
  const creds = connectionCredentials(connection);
  if (!creds) return null;
  try {
    return await graphRequest<{ name?: string; username?: string; profile_pic?: string }>(connection.config.apiHost ?? 'graph.instagram.com', igsid, creds.accessToken, {
      query: { fields: 'name,username,profile_pic' },
    });
  } catch {
    return null;
  }
}

async function handleInstagram(accountId: string, events: IgMessaging[]): Promise<number> {
  const connection = await findConnectionByExternalId('instagram', accountId);
  if (!connection) return 0;
  await touchConnection(connection.id);
  let n = 0;
  for (const ev of events) {
    const msg = ev.message;
    if (!msg || msg.is_deleted) continue;
    if (msg.is_echo) {
      await handleInstagramEcho(connection, ev);
      continue;
    }
    const igsid = ev.sender.id;
    const existing = await findExistingLead(connection.businessId, { instagramUserId: igsid });
    const profile = existing?.name ? null : await instagramProfile(connection, igsid);
    await receiveInboundMessage({
      businessId: connection.businessId,
      channel: 'instagram',
      channelConnectionId: connection.id,
      externalMessageId: msg.mid,
      text: msg.text ?? (msg.attachments?.length ? '[📎 Adjunto]' : ''),
      contentType: msg.text ? 'text' : 'media',
      sentAt: new Date(ev.timestamp),
      profile: { instagramUserId: igsid, name: profile?.name ?? profile?.username ?? null, instagramUsername: profile?.username ?? null, avatarUrl: profile?.profile_pic ?? null },
    });
    n++;
  }
  return n;
}

/**
 * Mensaje enviado desde la propia cuenta (eco). Si no lo envió KAI, es el entrenador escribiendo
 * desde la app de Instagram: se registra y KAI se pausa en esa conversación para no pisarle.
 */
async function handleInstagramEcho(connection: ChannelConnection, ev: IgMessaging) {
  const msg = ev.message!;
  const db = getDb();
  const [ours] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.businessId, connection.businessId), eq(messages.externalId, msg.mid)))
    .limit(1);
  if (ours) return;
  const lead = await findExistingLead(connection.businessId, { instagramUserId: ev.recipient.id });
  if (!lead) return;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, connection.businessId), eq(conversations.leadId, lead.id), eq(conversations.channel, 'instagram')))
    .limit(1);
  if (!conv) return;
  await insertMessage({
    businessId: connection.businessId,
    conversationId: conv.id,
    leadId: lead.id,
    direction: 'outbound',
    senderType: 'human',
    content: msg.text ?? '[📎 Adjunto]',
    externalId: msg.mid,
    status: 'sent',
    metadata: { via: 'instagram_app' },
    createdAt: new Date(ev.timestamp),
  });
  await db.update(conversations).set({ aiEnabled: false, updatedAt: new Date() }).where(eq(conversations.id, conv.id));
}

// ───────────── Lead Ads ─────────────

interface LeadgenValue {
  leadgen_id: string;
  page_id: string;
  form_id?: string;
  ad_id?: string;
  created_time?: number;
}

interface LeadData {
  id: string;
  created_time?: string;
  ad_name?: string;
  campaign_name?: string;
  form_id?: string;
  field_data?: { name: string; values: string[] }[];
}

export function mapLeadFields(fields: { name: string; values: string[] }[]) {
  const get = (...names: string[]) => fields.find((f) => names.includes(f.name.toLowerCase()))?.values?.[0]?.trim() || null;
  const first = get('first_name', 'nombre');
  const last = get('last_name', 'apellidos');
  const name = get('full_name', 'nombre_completo', 'name') ?? ([first, last].filter(Boolean).join(' ') || null);
  const email = get('email', 'correo', 'correo_electronico');
  const phone = get('phone_number', 'phone', 'telefono', 'teléfono', 'whatsapp');
  const known = new Set(['first_name', 'last_name', 'full_name', 'nombre', 'apellidos', 'nombre_completo', 'name', 'email', 'correo', 'correo_electronico', 'phone_number', 'phone', 'telefono', 'teléfono', 'whatsapp']);
  const extra: Record<string, string> = {};
  let goal: string | null = null;
  for (const f of fields) {
    if (known.has(f.name.toLowerCase())) continue;
    const label = f.name.replace(/_/g, ' ');
    const value = f.values.join(', ');
    extra[label] = value;
    if (!goal && /objetivo|meta|conseguir|goal/i.test(f.name)) goal = value;
  }
  return { name, email, phone, goal, extra };
}

async function handleLeadgen(value: LeadgenValue): Promise<number> {
  const connection = await findConnectionByExternalId('meta_lead_ads', value.page_id);
  if (!connection) return 0;
  if (connection.config.formIds?.length && value.form_id && !connection.config.formIds.includes(value.form_id)) return 0;
  const db = getDb();
  const inserted = await db
    .insert(webhookEvents)
    .values({ provider: 'meta_leadgen', externalId: value.leadgen_id, businessId: connection.businessId, payload: value })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return 0; // ya procesado
  try {
    const creds = connectionCredentials(connection);
    if (!creds) throw new Error('Credenciales de Lead Ads no válidas.');
    const data = await graphRequest<LeadData>('graph.facebook.com', value.leadgen_id, creds.accessToken, { query: { fields: 'id,created_time,ad_name,campaign_name,form_id,field_data' } });
    const mapped = mapLeadFields(data.field_data ?? []);
    const [biz] = await db.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, connection.businessId)).limit(1);
    const whatsapp = await getActiveConnection(connection.businessId, 'whatsapp');
    const wantsWhatsApp = (connection.config.firstContactChannel ?? 'whatsapp') === 'whatsapp' && Boolean(whatsapp);
    const waId = toWhatsAppId(mapped.phone, biz?.timezone ?? 'Europe/Madrid');
    await ingestExternalLead({
      businessId: connection.businessId,
      source: 'meta_ads',
      sourceDetail: [data.campaign_name, data.ad_name].filter(Boolean).join(' · ') || `Formulario ${value.form_id ?? ''}`.trim(),
      name: mapped.name,
      email: mapped.email,
      phone: waId ? `+${waId}` : mapped.phone,
      goal: mapped.goal,
      extra: mapped.extra,
      firstContactChannel: wantsWhatsApp && waId ? 'whatsapp' : 'none',
      whatsappConnectionId: whatsapp?.id ?? null,
    });
    await db.update(webhookEvents).set({ status: 'processed' }).where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.externalId, value.leadgen_id)));
    await touchConnection(connection.id);
    return 1;
  } catch (err) {
    await db
      .update(webhookEvents)
      .set({ status: 'failed', error: errorMessage(err).slice(0, 500) })
      .where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.externalId, value.leadgen_id)));
    throw err;
  }
}

