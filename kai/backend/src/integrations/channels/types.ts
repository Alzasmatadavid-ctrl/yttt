import type { ChannelConfig, ChannelKey, TemplateRef } from '../../lib/domain.js';

export interface ChannelCredentials {
  accessToken: string;
}

export interface ChannelRecipient {
  whatsappId?: string | null;
  instagramUserId?: string | null;
  phone?: string | null;
}

export interface ChannelSendContext {
  externalAccountId: string;
  credentials: ChannelCredentials | null;
  config: ChannelConfig;
  recipient: ChannelRecipient;
}

export interface ChannelSendResult {
  externalId: string | null;
}

/**
 * Contrato de un canal de mensajería. Añadir un canal nuevo (Telegram, SMS, web chat…)
 * consiste en implementar esta interfaz y registrarla en `registry.ts`.
 */
export interface ChannelAdapter {
  key: ChannelKey;
  label: string;
  /** ¿Permite el canal enviar texto libre ahora? (WhatsApp/Instagram: 24 h desde el último mensaje del lead). */
  canSendFreeText(lastInboundAt: Date | null, now?: Date, sender?: 'kai' | 'human'): boolean;
  sendText(ctx: ChannelSendContext, text: string, opts?: { humanAgent?: boolean }): Promise<ChannelSendResult>;
  sendTemplate?(ctx: ChannelSendContext, template: TemplateRef, params: string[]): Promise<ChannelSendResult>;
}

export const HOURS_24 = 24 * 3600_000;
export const DAYS_7 = 7 * 24 * 3600_000;
