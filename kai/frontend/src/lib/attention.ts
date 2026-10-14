/*
 * «Necesita tu atención» (pantalla Hoy): qué se pinta y cuántas cosas son.
 * Cada asunto sale una sola vez y el contador cuenta exactamente lo que se pinta.
 */
import type { Alert } from './types';

/** Avisos que se atienden contestando en su conversación: escalado, «Tu cliente te ha escrito» y contacto manual. */
const REPLY_ALERT_TYPES = new Set(['handoff', 'client_message', 'new_lead_manual']);
/**
 * Avisos de que un mensaje no se pudo enviar. Si esa conversación además espera respuesta es el mismo asunto (la
 * respuesta no llegó al lead) y el aviso dice por qué: la conversación no se repite como «espera tu respuesta».
 */
const SEND_FAILED_ALERT_TYPES = new Set(['delivery_blocked', 'integration_error']);

export function attentionItems<
  A extends { alert: Pick<Alert, 'type' | 'leadId' | 'conversationId'> },
  W extends { conversationId: string; leadId: string },
  R extends { id: string },
>(attention: { alerts: A[]; waiting: W[]; atRisk: R[] }) {
  const handoffs = attention.alerts.filter((a) => a.alert.type === 'handoff');
  const otherAlerts = attention.alerts.filter((a) => a.alert.type !== 'handoff');
  const replyAlerts = attention.alerts.filter((a) => REPLY_ALERT_TYPES.has(a.alert.type));
  const sendFailed = attention.alerts.filter((a) => SEND_FAILED_ALERT_TYPES.has(a.alert.type) && a.alert.conversationId);
  // Una conversación que ya sale como aviso no se repite como «espera tu respuesta» (el aviso lleva más contexto).
  const waiting = attention.waiting.filter(
    (w) => !replyAlerts.some((a) => a.alert.conversationId === w.conversationId) && !sendFailed.some((a) => a.alert.conversationId === w.conversationId),
  );
  // Un lead al que ya se le pide contestar (como «espera tu respuesta» o con el aviso que la sustituye) no se repite
  // como «a punto de perderse»: es la misma tarea.
  const leadsToAnswer = new Set<string | null>([...attention.waiting.map((w) => w.leadId), ...replyAlerts.map((a) => a.alert.leadId)]);
  const atRisk = attention.atRisk.filter((l) => !leadsToAnswer.has(l.id));
  return { handoffs, waiting, atRisk, otherAlerts, count: handoffs.length + waiting.length + atRisk.length + otherAlerts.length };
}
