/**
 * Entrada unificada de leads y mensajes, venga del canal que venga.
 * Todos los webhooks (WhatsApp, Instagram, Meta Lead Ads, formularios, Calendly…) normalizan
 * sus datos y llaman aquí. Añadir un canal nuevo = un normalizador nuevo, sin tocar el CRM.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { aiSettings, businesses, messages } from '../database/schema.js';
import { OVER_LIMIT_TAG, type ChannelKey, type LeadSource } from '../lib/domain.js';
import { truncate } from '../lib/text.js';
import {
  createLead,
  applyPipelineEvent,
  cancelPendingAutomationsForLead,
  isUniqueViolation,
  markOptedOut,
  recordLeadEvent,
  type Lead,
} from '../crm/leads.service.js';
import { getOrCreateConversation, insertMessage, type Conversation, type Message } from '../crm/conversations.service.js';
import { createAlert } from '../crm/alerts.service.js';
import { isOptOutRequest } from '../crm/opt-out.js';
import { checkUsageLimit } from '../plans/plans.service.js';
import { scheduleJob, scheduleOrReschedule } from '../automation/jobs.js';
import { audit } from '../audit/audit.service.js';

export interface InboundMessageInput {
  businessId: string;
  channel: ChannelKey;
  channelConnectionId?: string | null;
  externalMessageId?: string | null;
  text: string;
  contentType?: 'text' | 'media' | 'unsupported';
  sentAt?: Date;
  profile: {
    name?: string | null;
    whatsappId?: string | null;
    phone?: string | null;
    instagramUserId?: string | null;
    instagramUsername?: string | null;
    avatarUrl?: string | null;
  };
  isTest?: boolean;
  /** Retardo de respuesta forzado (simulador). */
  replyDelaySeconds?: number;
}

export async function replyDelaySeconds(businessId: string): Promise<number> {
  const [s] = await getDb()
    .select({ min: aiSettings.replyDelayMinSeconds, max: aiSettings.replyDelayMaxSeconds })
    .from(aiSettings)
    .where(eq(aiSettings.businessId, businessId))
    .limit(1);
  const min = Math.max(0, s?.min ?? 20);
  const max = Math.max(min, s?.max ?? 70);
  return min + Math.random() * (max - min);
}

/**
 * ¿Puede KAI escribir en nombre de este negocio? Con la cuenta desactivada los leads y sus mensajes
 * se siguen guardando (no se pierde nada), pero no se programa ninguna respuesta ni primer contacto.
 */
async function businessIsActive(businessId: string): Promise<boolean> {
  const [biz] = await getDb().select({ status: businesses.status }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  return biz?.status === 'active';
}

/** Registra un mensaje entrante y programa la respuesta de KAI (con retardo humano y agrupando ráfagas). */
export async function receiveInboundMessage(input: InboundMessageInput) {
  const db = getDb();
  if (input.externalMessageId) {
    const [dup] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.businessId, input.businessId), eq(messages.externalId, input.externalMessageId)))
      .limit(1);
    if (dup) return { duplicate: true as const };
  }
  const source: LeadSource = input.isTest ? 'simulator' : input.channel === 'web' ? 'manual' : input.channel;
  const { lead, created } = await createLead(
    input.businessId,
    {
      name: input.profile.name ?? '',
      whatsappId: input.profile.whatsappId,
      phone: input.profile.phone,
      instagramUserId: input.profile.instagramUserId,
      instagramUsername: input.profile.instagramUsername,
      avatarUrl: input.profile.avatarUrl,
      source,
      isTest: input.isTest,
    },
    { type: 'lead' },
  );
  const conversation = await getOrCreateConversation(input.businessId, lead.id, input.channel, input.channelConnectionId);
  let message: Message;
  try {
    message = await insertMessage({
      businessId: input.businessId,
      conversationId: conversation.id,
      leadId: lead.id,
      direction: 'inbound',
      senderType: 'lead',
      content: input.text || '(mensaje sin texto)',
      contentType: input.contentType ?? 'text',
      externalId: input.externalMessageId ?? null,
      createdAt: input.sentAt,
    });
  } catch (err) {
    // Meta entregó el mismo mensaje dos veces a la vez: el otro aviso ya lo ha guardado.
    if (input.externalMessageId && isUniqueViolation(err)) return { duplicate: true as const };
    throw err;
  }
  // El lead respondió: se cancelan seguimientos pendientes.
  await cancelPendingAutomationsForLead(input.businessId, lead.id, ['no_reply', 'no_show', 'reactivation']);
  await recordLeadEvent(input.businessId, lead.id, 'message_in', { type: 'lead' }, { messageId: message.id, channel: input.channel });
  await applyPipelineEvent(input.businessId, lead.id, 'inbound_received', { type: 'lead' });

  // Baja pedida mientras KAI no va a contestar (entrenador al mando, piloto automático apagado…):
  // se registra igualmente para que nadie le vuelva a escribir. Si KAI está activo, lo hace KAI al responder.
  let optedOutNow = false;
  if (!lead.optedOut && !input.isTest && isOptOutRequest(input.text) && !(await kaiWillHandle(input.businessId, conversation, lead))) {
    await registerOptOutFromInbound(input.businessId, lead, conversation, message);
    optedOutNow = true;
  }
  // Ya estaba dado de baja y vuelve a escribir: KAI no le contesta, pero el entrenador tiene que enterarse
  // (sale en «Pendientes» y con un aviso). Si solo repite que no le escriban, se renueva la baja y nada más.
  if (lead.optedOut && !input.isTest) {
    if (isOptOutRequest(input.text)) await markOptedOut(input.businessId, lead.id, { type: 'lead' }, { messageId: message.id, detectedBy: 'inbound', repeated: true });
    else await alertOptedOutLeadWrote(input.businessId, lead, conversation, message);
  }

  if (conversation.aiEnabled && !conversation.handoffActive && !lead.optedOut && !optedOutNow && (await businessIsActive(input.businessId))) {
    const delay = input.replyDelaySeconds ?? (await replyDelaySeconds(input.businessId));
    await scheduleOrReschedule({
      businessId: input.businessId,
      type: 'kai_reply',
      runAt: new Date(Date.now() + delay * 1000),
      payload: { conversationId: conversation.id, leadId: lead.id },
      dedupeKey: `reply:${conversation.id}`,
      maxAttempts: 2,
    });
  }
  return { duplicate: false as const, lead, leadCreated: created, conversation, message };
}

/** ¿Va a responder KAI a este mensaje? (mismas condiciones que comprueba antes de analizarlo). */
async function kaiWillHandle(businessId: string, conversation: Conversation, lead: Lead): Promise<boolean> {
  if (!conversation.aiEnabled || conversation.handoffActive || lead.optedOut || lead.status === 'client' || lead.tags.includes(OVER_LIMIT_TAG)) return false;
  const [row] = await getDb()
    .select({ status: businesses.status, autopilot: aiSettings.autopilotEnabled })
    .from(businesses)
    .leftJoin(aiSettings, eq(aiSettings.businessId, businesses.id))
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!row || row.status !== 'active' || !row.autopilot) return false;
  return lead.isTest || (await checkUsageLimit(businessId, 'ai_messages')).allowed;
}

async function registerOptOutFromInbound(businessId: string, lead: Lead, conversation: Conversation, message: Message) {
  await markOptedOut(businessId, lead.id, { type: 'lead' }, { messageId: message.id, detectedBy: 'inbound' });
  await audit({ businessId, actorType: 'system', action: 'lead.opted_out', entityType: 'lead', entityId: lead.id, metadata: { messageId: message.id, detectedBy: 'inbound' } });
  await createAlert({
    businessId,
    type: 'delivery_blocked',
    severity: 'info',
    title: 'Un lead ha pedido no recibir más mensajes',
    body: `${lead.name || 'Un lead'} ha escrito «${truncate(message.content.replace(/\s+/g, ' '), 120)}». Se ha registrado la baja: no se le enviarán más mensajes y se han cancelado sus seguimientos y recordatorios. Si ha sido un malentendido, puedes darle de alta de nuevo desde su ficha.`,
    leadId: lead.id,
    conversationId: conversation.id,
    dedupeByTitle: true,
  });
}

async function alertOptedOutLeadWrote(businessId: string, lead: Lead, conversation: Conversation, message: Message) {
  await createAlert({
    businessId,
    type: 'client_message',
    title: 'Un lead dado de baja te ha vuelto a escribir',
    body: `${lead.name || 'Un lead'} pidió no recibir más mensajes y ahora ha escrito «${truncate(message.content.replace(/\s+/g, ' '), 120)}». KAI no le contesta. Si quiere volver a hablar contigo, pulsa «Volver a permitir mensajes» en su ficha y respóndele.`,
    leadId: lead.id,
    conversationId: conversation.id,
  });
}

export interface ExternalLeadInput {
  businessId: string;
  source: LeadSource;
  sourceDetail?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  instagramUsername?: string | null;
  goal?: string | null;
  message?: string | null;
  extra?: Record<string, string>;
  /** Canal por el que KAI debe iniciar la conversación (si es posible). */
  firstContactChannel?: 'whatsapp' | 'web' | 'none';
  whatsappConnectionId?: string | null;
  isTest?: boolean;
}

/** Lead que llega por formulario, anuncio de Meta o webhook externo (todavía no ha escrito). */
export async function ingestExternalLead(input: ExternalLeadInput): Promise<{ lead: Lead; created: boolean; conversationId: string | null }> {
  const notes = [
    input.message ? `Mensaje del formulario: ${input.message}` : '',
    ...Object.entries(input.extra ?? {}).map(([k, v]) => `${k}: ${v}`),
  ]
    .filter(Boolean)
    .join('\n');
  const { lead, created } = await createLead(
    input.businessId,
    {
      name: input.name ?? '',
      email: input.email,
      phone: input.phone,
      whatsappId: input.firstContactChannel === 'whatsapp' && input.phone ? input.phone.replace(/[^\d]/g, '') : null,
      instagramUsername: input.instagramUsername,
      source: input.source,
      sourceDetail: input.sourceDetail,
      notes,
      goal: input.goal,
      isTest: input.isTest,
    },
    { type: 'integration' },
    // Formularios, Lead Ads y webhooks: cualquiera puede escribir el email o el teléfono de otra persona.
    { unverifiedContact: true },
  );
  await audit({ businessId: input.businessId, actorType: 'integration', action: 'lead.ingested', entityType: 'lead', entityId: lead.id, metadata: { source: input.source, created } });

  let conversationId: string | null = null;
  const channel = input.firstContactChannel ?? 'none';
  // Cuenta desactivada: el lead queda guardado, pero KAI no le escribe.
  if (created && channel !== 'none' && (channel === 'web' || lead.phone) && (await businessIsActive(input.businessId))) {
    const conversation = await getOrCreateConversation(input.businessId, lead.id, channel, input.whatsappConnectionId ?? null);
    conversationId = conversation.id;
    await scheduleJob({
      businessId: input.businessId,
      type: 'first_contact',
      runAt: new Date(Date.now() + (channel === 'web' ? 1000 : 45_000)),
      payload: { conversationId, leadId: lead.id },
      dedupeKey: `first_contact:${lead.id}`,
    });
  }
  return { lead, created, conversationId };
}

/** Mensaje entrante en una conversación ya existente (simulador). */
export async function receiveInboundForConversation(businessId: string, conversationId: string, text: string) {
  const { getConversation } = await import('../crm/conversations.service.js');
  const conv = await getConversation(businessId, conversationId);
  const message = await insertMessage({ businessId, conversationId, leadId: conv.leadId, direction: 'inbound', senderType: 'lead', content: text });
  await cancelPendingAutomationsForLead(businessId, conv.leadId, ['no_reply', 'no_show', 'reactivation']);
  await recordLeadEvent(businessId, conv.leadId, 'message_in', { type: 'lead' }, { messageId: message.id, channel: conv.channel });
  await applyPipelineEvent(businessId, conv.leadId, 'inbound_received', { type: 'lead' });
  return { conversation: conv, message };
}
