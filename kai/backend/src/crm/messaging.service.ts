import { and, eq, gte, inArray, lt } from 'drizzle-orm';
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
import { applyMessageCounters, getConversation, insertMessage, type Message } from './conversations.service.js';
import { applyPipelineEvent, cancelPendingAutomationsForLead, isUniqueViolation, recordLeadEvent } from './leads.service.js';

export type MessagePurpose = 'reply' | 'manual' | 'first_contact' | 'follow_up' | 'confirmation' | 'reminder' | 'no_show' | 'handoff';

export interface SendMessageInput {
  businessId: string;
  conversationId: string;
  text: string;
  sender: { type: 'kai' | 'human' | 'system'; userId?: string | null };
  purpose: MessagePurpose;
  /** Parámetros extra para plantillas de WhatsApp ({{2}}, {{3}}…). {{1}} es siempre el nombre del lead (o 👋 si no se sabe). */
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

/** Lo que recibe {{1}} en las plantillas de WhatsApp cuando no se sabe el nombre del lead. */
export const TEMPLATE_NAME_FALLBACK = '👋';

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

  // Se guarda ANTES de llamar al canal («en cola», con la hora en que se decide enviarlo): un mensaje del lead que
  // llegue mientras se envía queda detrás de esta respuesta (sin contestar), no delante como si ya se hubiera respondido.
  const metadata: Record<string, unknown> = { ...input.metadata, purpose: input.purpose };
  const queued = await insertMessage({ ...base, content: text, status: 'queued', metadata });
  try {
    let externalId: string | null;
    let content = text;
    let contentType: 'text' | 'template' = 'text';
    if (template && adapter.sendTemplate) {
      // {{1}} = nombre. Sin nombre (formularios que no lo piden, leads de WhatsApp sin perfil) va un saludo con la
      // mano: las plantillas empiezan por «Hola {{1}}, …» y con «hola» el lead leería «Hola hola, …».
      const params = [firstName(lead.name) || TEMPLATE_NAME_FALLBACK, ...(input.templateExtraParams ?? [])];
      ({ externalId } = await adapter.sendTemplate(ctx, template, params));
      content = `[Plantilla «${template.name}»] ${params.join(' · ')}`;
      contentType = 'template';
      metadata.intendedText = text;
      metadata.template = template;
    } else {
      ({ externalId } = await adapter.sendText(ctx, text, { humanAgent: humanAgentTag }));
    }
    const message = await recordSentMessage(queued, { content, contentType, externalId, metadata });
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
    const [message] = await db
      .update(messages)
      .set({ status: 'failed', error: reason.slice(0, 500) })
      .where(and(eq(messages.id, queued.id), eq(messages.status, 'queued')))
      .returning();
    if (!message) {
      // El mensaje ya había salido: el fallo es de lo que se anota después. No se da por no enviado (ni se reintenta).
      await logError('channel.after_send', err, { channel: conv.channel, conversationId: conv.id }, input.businessId);
      const [sent] = await db.select().from(messages).where(eq(messages.id, queued.id)).limit(1);
      return { message: sent ?? queued, delivered: true };
    }
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

/** Tiempo tras el que un envío en cola ya no puede seguir en marcha (la llamada al canal se corta a los 15 s). */
export const INTERRUPTED_SEND_AFTER_MS = 2 * 60_000;

/**
 * Envíos que se quedaron «en cola» porque el proceso se detuvo mientras se llamaba al canal (despliegue, caída…):
 * ya nadie los va a terminar y, mientras sigan así, cuentan como respuesta al lead. Se dan por no enviados: al
 * repetirse el trabajo, KAI vuelve a contestar, o la conversación sale en «Pendientes» con el mensaje «no enviado».
 */
export async function failInterruptedSends(olderThanMs = INTERRUPTED_SEND_AFTER_MS): Promise<number> {
  const rows = await getDb()
    .update(messages)
    .set({ status: 'failed', error: 'Envío interrumpido: KAI se reinició mientras lo enviaba y puede que no le haya llegado al lead.' })
    .where(and(eq(messages.direction, 'outbound'), eq(messages.status, 'queued'), lt(messages.createdAt, new Date(Date.now() - olderThanMs))))
    .returning({ id: messages.id });
  return rows.length;
}

/**
 * Da por enviado el mensaje que se guardó en cola antes de llamar al canal. Si el eco de Instagram llegó antes y se
 * registró como escrito por el entrenador desde la app (mismo id de Meta), ese eco sobra: se borra, y la conversación
 * vuelve a quedar como estaba antes del eco: ni se queda KAI en pausa por su propio mensaje, ni se reactiva en una
 * conversación que llevaba el entrenador, ni se da por atendido un escalado o un aviso.
 */
async function recordSentMessage(
  queued: Message,
  patch: { content: string; contentType: 'text' | 'template'; externalId: string | null; metadata: Record<string, unknown> },
): Promise<Message> {
  const db = getDb();
  const markSent = () => db.update(messages).set({ status: 'sent', ...patch }).where(eq(messages.id, queued.id)).returning();
  let rows: Message[];
  try {
    rows = await markSent();
  } catch (err) {
    if (!patch.externalId || !isUniqueViolation(err)) throw err;
    const [echo] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.businessId, queued.businessId), eq(messages.externalId, patch.externalId)))
      .limit(1);
    if (!echo || echo.id === queued.id) throw err;
    await db.delete(messages).where(eq(messages.id, echo.id));
    rows = await markSent();
    await undoEchoEffects(queued, echo);
  }
  const [sent] = rows;
  await applyMessageCounters(sent);
  return sent;
}

/** Deshace lo que hizo el eco de Instagram al tomarse por una respuesta del entrenador (ver handleInstagramEcho). */
async function undoEchoEffects(queued: Message, echo: Message) {
  const db = getDb();
  const before = echo.metadata.before as { aiEnabled: boolean; handoffActive: boolean; handoffReason: string | null } | undefined;
  const wasEcho = echo.senderType === 'human' && echo.metadata.via === 'instagram_app';
  if (!wasEcho) return;
  if (before) {
    await db
      .update(conversations)
      .set({ aiEnabled: before.aiEnabled, handoffActive: before.handoffActive, handoffReason: before.handoffReason, updatedAt: new Date() })
      .where(eq(conversations.id, queued.conversationId));
  } else if (queued.senderType === 'kai') {
    // Eco guardado sin el estado previo (versión anterior): se deshace al menos la pausa que puso.
    await db.update(conversations).set({ aiEnabled: true, updatedAt: new Date() }).where(eq(conversations.id, queued.conversationId));
  }
  // El eco cerró avisos al darlos por atendidos (el escalado, «te ha escrito», «contacto manual»): se vuelven a abrir.
  const reopen: (typeof alerts.$inferSelect)['type'][] = ['client_message', 'new_lead_manual'];
  if (before?.handoffActive) reopen.push('handoff');
  await db
    .update(alerts)
    .set({ status: 'open', resolvedAt: null })
    .where(
      and(
        eq(alerts.businessId, queued.businessId),
        eq(alerts.leadId, queued.leadId),
        inArray(alerts.type, reopen),
        eq(alerts.status, 'resolved'),
        gte(alerts.resolvedAt, echo.createdAt),
      ),
    );
}
