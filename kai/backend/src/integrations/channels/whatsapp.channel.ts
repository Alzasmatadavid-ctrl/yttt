import type { TemplateRef } from '../../lib/domain.js';
import { graphRequest } from '../meta/graph.js';
import { HOURS_24, type ChannelAdapter, type ChannelSendContext } from './types.js';

/**
 * WhatsApp Business Platform — Cloud API oficial de Meta.
 * Envío: POST /{phone-number-id}/messages
 * Regla clave: fuera de la ventana de 24 h solo se pueden enviar plantillas aprobadas.
 */
interface SendResponse {
  messages?: { id: string }[];
}

function recipientId(ctx: ChannelSendContext): string {
  const to = ctx.recipient.whatsappId ?? ctx.recipient.phone?.replace(/[^\d]/g, '');
  if (!to) throw new Error('El lead no tiene número de WhatsApp.');
  return to;
}

function token(ctx: ChannelSendContext) {
  if (!ctx.credentials?.accessToken) throw new Error('Falta el token de acceso de WhatsApp.');
  return ctx.credentials.accessToken;
}

export const whatsappChannel: ChannelAdapter = {
  key: 'whatsapp',
  label: 'WhatsApp',
  canSendFreeText(lastInboundAt, now = new Date()) {
    return Boolean(lastInboundAt && now.getTime() - lastInboundAt.getTime() < HOURS_24);
  },
  async sendText(ctx, text) {
    const res = await graphRequest<SendResponse>('graph.facebook.com', `${ctx.externalAccountId}/messages`, token(ctx), {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipientId(ctx), type: 'text', text: { preview_url: true, body: text } },
    });
    return { externalId: res.messages?.[0]?.id ?? null };
  },
  async sendTemplate(ctx, template: TemplateRef, params: string[]) {
    const res = await graphRequest<SendResponse>('graph.facebook.com', `${ctx.externalAccountId}/messages`, token(ctx), {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to: recipientId(ctx),
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.language },
          components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] : [],
        },
      },
    });
    return { externalId: res.messages?.[0]?.id ?? null };
  },
};
