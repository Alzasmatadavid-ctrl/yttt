/*
 * Mensajes de una conversación: ¿se intentó contestar al lead y no le llegó?
 */
import type { Message } from './types';

/** Mensajes automáticos que NO contestan al lead (los mismos que NON_REPLY_PURPOSES en el servidor). */
const NON_REPLY_PURPOSES = new Set(['confirmation', 'reminder', 'no_show', 'follow_up']);

/**
 * Respuesta al último mensaje del lead que no se pudo entregar (canal sin conectar, ventana de 24 h cerrada, error de
 * WhatsApp/Instagram…): en ese caso el problema es el envío, no que nadie haya contestado.
 * Devuelve el último intento fallido, o null si nadie ha intentado contestar o si alguna respuesta posterior sí salió.
 * `messages` va en orden cronológico (como lo devuelve el detalle de la conversación).
 */
export function unsentReply(messages: Pick<Message, 'direction' | 'senderType' | 'status' | 'error' | 'metadata'>[]): { reason: string | null } | null {
  let lastInbound = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'inbound') {
      lastInbound = i;
      break;
    }
  }
  if (lastInbound < 0) return null;
  let failed: { reason: string | null } | null = null;
  for (const m of messages.slice(lastInbound + 1)) {
    if (m.direction !== 'outbound') continue;
    const purpose = typeof m.metadata?.purpose === 'string' ? m.metadata.purpose : '';
    // Un recordatorio o un seguimiento no contesta al lead: que falle no es lo que le tiene esperando.
    if (m.senderType !== 'human' && NON_REPLY_PURPOSES.has(purpose)) continue;
    if (m.status !== 'failed' && m.status !== 'skipped') return null;
    failed = { reason: m.error };
  }
  return failed;
}
