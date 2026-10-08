import { graphRequest } from '../meta/graph.js';
import { DAYS_7, HOURS_24, type ChannelAdapter } from './types.js';

/**
 * Instagram Messaging API (mensajes directos de una cuenta profesional).
 * Envío: POST /{ig-user-id}/messages con { recipient: { id: IGSID }, message: { text } }.
 * - Con “Instagram Login” el host es graph.instagram.com; con “Facebook Login” es graph.facebook.com.
 * - Ventana estándar de 24 h. Una PERSONA (no KAI) puede responder hasta 7 días usando la etiqueta HUMAN_AGENT,
 *   que requiere el permiso “Human Agent” aprobado por Meta.
 */
interface SendResponse {
  recipient_id?: string;
  message_id?: string;
}

export const instagramChannel: ChannelAdapter = {
  key: 'instagram',
  label: 'Instagram',
  canSendFreeText(lastInboundAt, now = new Date(), sender = 'kai') {
    if (!lastInboundAt) return false;
    const elapsed = now.getTime() - lastInboundAt.getTime();
    return sender === 'human' ? elapsed < DAYS_7 : elapsed < HOURS_24;
  },
  async sendText(ctx, text, opts) {
    if (!ctx.credentials?.accessToken) throw new Error('Falta el token de acceso de Instagram.');
    if (!ctx.recipient.instagramUserId) throw new Error('El lead no tiene identificador de Instagram.');
    const host = ctx.config.apiHost ?? 'graph.instagram.com';
    const body: Record<string, unknown> = { recipient: { id: ctx.recipient.instagramUserId }, message: { text } };
    if (opts?.humanAgent) {
      body.messaging_type = 'MESSAGE_TAG';
      body.tag = 'HUMAN_AGENT';
    }
    const res = await graphRequest<SendResponse>(host, `${ctx.externalAccountId}/messages`, ctx.credentials.accessToken, { method: 'POST', body });
    return { externalId: res.message_id ?? null };
  },
};
