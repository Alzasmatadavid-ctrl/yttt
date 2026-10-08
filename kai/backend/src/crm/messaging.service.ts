import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../database/client.js';
import { alerts, conversations, leads, messages } from '../database/schema.js';
import type { TemplateRef } from '../lib/domain.js';
import { badRequest } from '../lib/errors.js';
import { firstName } from '../lib/text.js';
import { logError } from '../audit/audit.service.js';
import { getChannelAdapter } from '../integrations/channels/registry.js';
import type { ChannelSendContext } from '../integrations/channels/types.js';
import { connectionCredentials, getActiveConnection, markConnectionError } from '../integrations/connections.service.js';
import { friendlyMetaError, GraphApiError } from '../integrations/meta/graph.js';
import { incrementUsage } from '../plans/plans.service.js';
import { createAlert, resolveAlertsFor } from './alerts.service.js';
import { getConversation, insertMessage, type Message } from './conversations.service.js';
import { applyPipelineEvent, cancelPendingAutomationsForLead, recordLeadEvent } from './leads.service.js';

export type MessagePurpose = 'reply' | 'manual' | 'first_contact' | 'follow_up' | 'confirmation' | 'reminder' | 'no_show' | 'handoff';

export interface SendMessageInput {
  businessId: string;
  conversationId: string;
  text: string;
  sender: { type: 'kai' | 'human' | 'system'; userId?: string | null };
  purpose: MessagePurpose;
  /** Parámetros extra para plantillas de WhatsApp ({{2}}, {{3}}…). {{1}} es siempre el nombre del lead. */
  templateExtraParams?: string[];
  metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
  message: Message;
  delivered: boolean;
  blockedReason?: string;
}

const TEMPLATE_FOR_PURPOSE: Partial<Record<MessagePurpose, 'firstContact' | 'followUp' | 'reminder' | 'noShow'>> = {
  first_contact: 'firstContact',
  follow_up: 'followUp',
  confirmation: 'reminder',
  reminder: 'reminder',
  no_show: 'noShow',
};

/**
 * Envía un mensaje al lead por el canal de la conversación, respetando las reglas de cada plataforma
 * (ventana de 24 h, plantillas, bajas), y lo registra en el CRM.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const text = input.text.trim();
  if (!text) throw badRequest('El mensaje está vacío.');
  if (text.length > 4000) throw badRequest('El mensaje es demasiado largo.');
  const db = getDb();
  const conv = await getConversation(input.businessId, input.conversationId);
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, input.businessId), eq(leads.id, conv.leadId)))
    .limit(1);
  if (!lead) throw badRequest('Lead no encontrado.');

  const base = {
    businessId: input.businessId,
    conversationId: conv.id,
    leadId: lead.id,
    direction: 'outbound' as const,
    senderType: input.sender.type === 'human' ? ('human' as const) : input.sender.type === 'kai' ? ('kai' as const) : ('system' as const),
    senderUserId: input.sender.userId ?? null,
  };

  const blocked = async (reason: string) => {
    const message = await insertMessage({ ...base, content: text, status: 'skipped', error: reason, metadata: { ...input.metadata, purpose: input.purpose } });
    if (input.sender.type !== 'human') {
      await createAlert({
        businessId: input.businessId,
        type: 'delivery_blocked',
        title: 'Mensaje no enviado',
        body: `${lead.name || 'Lead'}: ${reason}`,
        leadId: lead.id,
        conversationId: conv.id,
        // Que no quede oculto detrás de otro aviso de entrega del mismo lead (p. ej. el de la baja).
        dedupeByTitle: true,
      });
    }
    return { message, delivered: false, blockedReason: reason };
  };

  if (lead.optedOut) return blocked('El lead pidió no recibir más mensajes.');

  const adapter = getChannelAdapter(conv.channel);
  let ctx: ChannelSendContext = {
    externalAccountId: '',
    credentials: null,
    config: {},
    recipient: { whatsappId: lead.whatsappId, instagramUserId: lead.instagramUserId, phone: lead.phone },
  };
  let connectionId: string | null = null;
  if (conv.channel !== 'web') {
    const connection = await getActiveConnection(input.businessId, conv.channel, conv.channelConnectionId);
    if (!connection) return blocked(`No hay ninguna cuenta de ${adapter.label} conectada.`);
    connectionId = connection.id;
    ctx = { ...ctx, externalAccountId: connection.externalAccountId, credentials: connectionCredentials(connection), config: connection.config };
  }

  const senderKind = input.sender.type === 'human' ? 'human' : 'kai';
  const windowOpen = adapter.canSendFreeText(conv.lastInboundAt, new Date(), senderKind);
  const humanAgentTag =
    conv.channel === 'instagram' && senderKind === 'human' && !adapter.canSendFreeText(conv.lastInboundAt, new Date(), 'kai');

  let template: TemplateRef | undefined;
  if (!windowOpen) {
    const templateKey = TEMPLATE_FOR_PURPOSE[input.purpose];
    template = templateKey ? ctx.config.templates?.[templateKey] : undefined;
    if (!template || !adapter.sendTemplate) {
      return blocked(
        conv.channel === 'whatsapp'
          ? 'Han pasado más de 24 h desde el último mensaje del lead. WhatsApp solo permite plantillas aprobadas: configúrala en Integraciones.'
          : `${adapter.label} no permite escribir fuera de la ventana de mensajería (24 h desde el último mensaje del lead).`,
      );
    }
  }

  try {
    let externalId: string | null;
    let content = text;
    let contentType: 'text' | 'template' = 'text';
    const metadata: Record<string, unknown> = { ...input.metadata, purpose: input.purpose };
    if (template && adapter.sendTemplate) {
      const params = [firstName(lead.name) || 'hola', ...(input.templateExtraParams ?? [])];
      ({ externalId } = await adapter.sendTemplate(ctx, template, params));
      content = `[Plantilla «${template.name}»] ${params.join(' · ')}`;
      contentType = 'template';
      metadata.intendedText = text;
      metadata.template = template;
    } else {
      ({ externalId } = await adapter.sendText(ctx, text, { humanAgent: humanAgentTag }));
    }
    const message = await recordSentMessage({ ...base, content, contentType, externalId, status: 'sent', metadata });
    // Los leads del simulador no consumen el cupo mensual de mensajes de KAI.
    if (input.sender.type === 'kai' && !lead.isTest) await incrementUsage(input.businessId, 'ai_messages');
    if (input.sender.type === 'human') {
      await cancelPendingAutomationsForLead(input.businessId, lead.id, ['no_reply']);
      // El entrenador ya ha contestado: los avisos de «te ha escrito» o «contacto manual» quedan atendidos.
      await resolveAlertsFor(input.businessId, { leadId: lead.id, type: 'client_message' });
      await resolveAlertsFor(input.businessId, { leadId: lead.id, type: 'new_lead_manual' });
    }
    await recordLeadEvent(input.businessId, lead.id, 'message_out', { type: input.sender.type === 'human' ? 'user' : input.sender.type, userId: input.sender.userId }, { purpose: input.purpose, messageId: message.id });
    await applyPipelineEvent(input.businessId, lead.id, 'outbound_sent', { type: input.sender.type === 'human' ? 'user' : 'kai', userId: input.sender.userId });
    return { message, delivered: true };
  } catch (err) {
    // Al entrenador se le muestra un motivo comprensible en español; el error técnico de Meta queda en error_logs.
    const reason = friendlyMetaError(err, adapter.label);
    const message = await insertMessage({ ...base, content: text, status: 'failed', error: reason.slice(0, 500), metadata: { ...input.metadata, purpose: input.purpose } });
    await logError('channel.send', err, { channel: conv.channel, conversationId: conv.id }, input.businessId);
    if (err instanceof GraphApiError && err.isAuthError && connectionId) {
      await markConnectionError(connectionId, reason);
    }
    await createAlert({
      businessId: input.businessId,
      type: 'integration_error',
      severity: 'critical',
      title: `Error al enviar por ${adapter.label}`,
      body: reason.slice(0, 300),
      leadId: lead.id,
      conversationId: conv.id,
    });
    return { message, delivered: false, blockedReason: reason };
  }
}

/**
 * Guarda un mensaje ya enviado. Si el eco de Instagram llegó antes y lo registró como escrito por el
 * entrenador desde la app (mismo id de Meta), se corrige esa fila en vez de dar el envío por fallido,
 * y la conversación vuelve a quedar como estaba antes del eco: ni se queda KAI en pausa por su propio
 * mensaje, ni se reactiva en una conversación que llevaba el entrenador, ni se da por atendido un escalado.
 */
async function recordSentMessage(input: Parameters<typeof insertMessage>[0]): Promise<Message> {
  try {
    return await insertMessage(input);
  } catch (err) {
    if (!input.externalId) throw err;
    const db = getDb();
    const [echo] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.businessId, input.businessId), eq(messages.externalId, input.externalId)))
      .limit(1);
    if (!echo) throw err;
    const [fixed] = await db
      .update(messages)
      .set({ senderType: input.senderType, senderUserId: input.senderUserId ?? null, content: input.content, contentType: input.contentType ?? 'text', metadata: input.metadata ?? {} })
      .where(eq(messages.id, echo.id))
      .returning();
    const before = echo.metadata.before as { aiEnabled: boolean; handoffActive: boolean; handoffReason: string | null } | undefined;
    const wasEcho = echo.senderType === 'human' && echo.metadata.via === 'instagram_app';
    if (wasEcho && before) {
      await db
        .update(conversations)
        .set({ aiEnabled: before.aiEnabled, handoffActive: before.handoffActive, handoffReason: before.handoffReason, updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      // El eco cerró el aviso del escalado al darlo por atendido: se vuelve a abrir.
      if (before.handoffActive)
        await db
          .update(alerts)
          .set({ status: 'open', resolvedAt: null })
          .where(
            and(
              eq(alerts.businessId, input.businessId),
              eq(alerts.leadId, input.leadId),
              eq(alerts.type, 'handoff'),
              eq(alerts.status, 'resolved'),
              gte(alerts.resolvedAt, echo.createdAt),
            ),
          );
    } else if (wasEcho && input.senderType === 'kai') {
      // Eco guardado sin el estado previo (versión anterior): se deshace al menos la pausa que puso.
      await db.update(conversations).set({ aiEnabled: true, updatedAt: new Date() }).where(eq(conversations.id, input.conversationId));
    }
    return fixed;
  }
}
