/**
 * Webhook único de Meta para:
 *  - WhatsApp Business Cloud API  (object = "whatsapp_business_account")
 *  - Instagram Messaging          (object = "instagram")
 *  - Facebook/Instagram Lead Ads  (object = "page", field = "leadgen")
 *
 * Documentación: https://developers.facebook.com/docs/graph-api/webhooks
 * URL a configurar en el panel de Meta: {API_URL}/api/webhooks/meta
 */
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { businesses, conversations, messages, webhookEvents } from '../database/schema.js';
import { errorMessage } from '../lib/errors.js';
import { logError } from '../audit/audit.service.js';
import { connectionCredentials, findConnectionByExternalId, getActiveConnection, touchConnection, type ChannelConnection } from '../integrations/connections.service.js';
import { friendlyMetaCode, friendlyMetaError, graphRequest } from '../integrations/meta/graph.js';
import { insertMessage, markHandoffAttended } from '../crm/conversations.service.js';
import { createAlert } from '../crm/alerts.service.js';
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
  errors?: { code?: number; title?: string; message?: string }[];
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

/**
 * Procesa un aviso de Meta. `failed` cuenta las entradas que no se han podido procesar: la ruta responde
 * entonces con error para que Meta vuelva a enviar el aviso (todo el procesamiento es idempotente:
 * mensajes por su id de Meta y leads de Lead Ads por su leadgen_id).
 */
export async function handleMetaWebhook(payload: MetaPayload): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
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
      failed++;
      await logError('webhook.meta', err, { object: payload.object, entryId: entry.id });
    }
  }
  return { processed, failed };
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
    const metaError = st.errors?.[0];
    // Motivo en español para el entrenador; el texto original de Meta queda en error_logs.
    const error =
      st.status === 'failed'
        ? (friendlyMetaCode(metaError?.code, undefined, 'WhatsApp') ??
          `WhatsApp no ha podido entregar el mensaje${metaError?.code !== undefined ? ` (código ${metaError.code})` : ''}.`)
        : null;
    if (st.status === 'failed')
      await logError('webhook.whatsapp_status', new Error(metaError?.message ?? metaError?.title ?? 'Error de entrega'), { messageId: st.id, code: metaError?.code }, connection.businessId, 'warn');
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
  // Si KAI había escalado la conversación, la respuesta del entrenador la deja atendida.
  await markHandoffAttended(connection.businessId, conv.id, { type: 'integration' });
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

/**
 * Reclama un aviso de Lead Ads para procesarlo. Devuelve false si ya se procesó (o se está procesando).
 * Un aviso que falló antes (Meta caída, token caducado un momento…) se puede volver a reclamar: así,
 * cuando Meta reenvía el aviso o se reintenta desde el mantenimiento, el lead no se pierde.
 */
async function claimLeadgenEvent(businessId: string, value: LeadgenValue): Promise<boolean> {
  const rows = await getDb()
    .insert(webhookEvents)
    .values({ provider: 'meta_leadgen', externalId: value.leadgen_id, businessId, payload: value })
    .onConflictDoUpdate({
      target: [webhookEvents.provider, webhookEvents.externalId],
      set: { status: 'received', error: null },
      // También se recupera uno que se quedó a medias (proceso reiniciado mientras lo descargaba).
      setWhere: or(
        eq(webhookEvents.status, 'failed'),
        sql`${webhookEvents.status} = 'received' and ${webhookEvents.createdAt} < now() - interval '15 minutes'`,
      ),
    })
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

async function setLeadgenStatus(leadgenId: string, status: 'processed' | 'failed', error: string | null = null) {
  await getDb()
    .update(webhookEvents)
    .set({ status, error })
    .where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.externalId, leadgenId)));
}

async function handleLeadgen(value: LeadgenValue): Promise<number> {
  const connection = await findConnectionByExternalId('meta_lead_ads', value.page_id);
  if (!connection) return 0;
  if (connection.config.formIds?.length && value.form_id && !connection.config.formIds.includes(value.form_id)) return 0;
  if (!(await claimLeadgenEvent(connection.businessId, value))) return 0; // ya procesado
  try {
    await ingestLeadgen(connection, value);
    await setLeadgenStatus(value.leadgen_id, 'processed');
    await touchConnection(connection.id);
    return 1;
  } catch (err) {
    await setLeadgenStatus(value.leadgen_id, 'failed', errorMessage(err).slice(0, 500));
    await createAlert({
      businessId: connection.businessId,
      type: 'integration_error',
      severity: 'critical',
      title: 'No se ha podido recibir un lead de Meta Lead Ads',
      body:
        `Meta avisó de un lead nuevo (ID ${value.leadgen_id}), pero no hemos podido descargar sus datos. Motivo: ${friendlyMetaError(err, 'Meta Lead Ads')} ` +
        'KAI volverá a intentarlo solo. Si el lead no aparece en unas horas, revisa la conexión de Lead Ads en Integraciones o descárgalo desde Meta Business Suite.',
      dedupeByTitle: true,
    });
    throw err;
  }
}

/** Descarga de Meta los datos del lead y lo da de alta en el CRM. */
async function ingestLeadgen(connection: ChannelConnection, value: LeadgenValue) {
  const db = getDb();
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
}

/**
 * Reintenta los avisos de Lead Ads que fallaron en los últimos días (pensado para el mantenimiento
 * periódico). Devuelve cuántos leads se han recuperado.
 */
export async function retryFailedLeadgenEvents(opts: { maxAgeDays?: number; limit?: number } = {}): Promise<{ retried: number; recovered: number }> {
  const since = new Date(Date.now() - (opts.maxAgeDays ?? 7) * 86_400_000);
  const failed = await getDb()
    .select({ payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, 'meta_leadgen'), eq(webhookEvents.status, 'failed'), gte(webhookEvents.createdAt, since)))
    .orderBy(webhookEvents.createdAt)
    .limit(opts.limit ?? 20);
  let recovered = 0;
  for (const row of failed) {
    try {
      recovered += await handleLeadgen(row.payload as LeadgenValue);
    } catch (err) {
      await logError('webhook.meta.leadgen_retry', err, { leadgenId: (row.payload as LeadgenValue).leadgen_id });
    }
  }
  return { retried: failed.length, recovered };
}
