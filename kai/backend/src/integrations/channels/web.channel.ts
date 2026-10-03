import { randomUUID } from 'node:crypto';
import type { ChannelAdapter } from './types.js';

/** Canal interno del simulador: los mensajes se guardan pero no salen a ninguna red. */
export const webChannel: ChannelAdapter = {
  key: 'web',
  label: 'Simulador',
  canSendFreeText() {
    return true;
  },
  async sendText() {
    return { externalId: `web_${randomUUID()}` };
  },
};
