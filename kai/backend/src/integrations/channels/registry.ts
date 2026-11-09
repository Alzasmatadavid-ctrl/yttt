import type { ChannelKey } from '../../lib/domain.js';
import { instagramChannel } from './instagram.channel.js';
import type { ChannelAdapter } from './types.js';
import { webChannel } from './web.channel.js';
import { whatsappChannel } from './whatsapp.channel.js';

const adapters: Record<ChannelKey, ChannelAdapter> = {
  whatsapp: whatsappChannel,
  instagram: instagramChannel,
  web: webChannel,
};

export function getChannelAdapter(key: ChannelKey): ChannelAdapter {
  const a = adapters[key];
  if (!a) throw new Error(`Canal no soportado: ${key}`);
  return a;
}

/** Permite sustituir un adaptador (p. ej. en tests). */
export function registerChannelAdapter(adapter: ChannelAdapter) {
  adapters[adapter.key] = adapter;
}
