import type { LeadStatus } from '@shared';
import { dateTime } from './format';

/**
 * Próxima acción sugerida para un lead (lo que verá el entrenador en la bandeja).
 * timeZone: zona horaria del negocio, para que la hora de la llamada coincida con la de la Agenda.
 */
export function nextActionFor(
  lead: { status: LeadStatus; nextAction?: string | null; optedOut?: boolean },
  /** needsHumanReply: el último mensaje del lead está sin contestar y KAI no lo va a contestar (como en «Pendientes»). */
  conv?: { handoffActive?: boolean; aiEnabled?: boolean; needsHumanReply?: boolean } | null,
  upcoming?: { startsAt: string } | null,
  timeZone?: string,
  /** false = el piloto automático de KAI está en pausa: no va a contestar a nadie. */
  autopilotOn = true,
): string {
  if (lead.optedOut) return 'No contactar (pidió la baja)';
  if (conv?.handoffActive) return 'Responder tú (KAI te lo ha pasado)';
  // KAI está activo pero no tiene ninguna respuesta en marcha para ese mensaje (p. ej. llegó con KAI en pausa):
  // no se puede decir que «KAI responderá en breve».
  if (conv?.needsHumanReply && conv.aiEnabled !== false && autopilotOn && lead.status !== 'client')
    return 'Mensaje sin contestar: respóndele tú o deja que lo haga KAI';
  if (lead.nextAction) return lead.nextAction;
  if (upcoming) return `Llamada ${dateTime(upcoming.startsAt, timeZone)}`;
  if (conv && !conv.aiEnabled) return 'Conversación en tus manos';
  if (!autopilotOn && lead.status !== 'client' && lead.status !== 'lost') return 'KAI en pausa: responde tú';
  switch (lead.status) {
    case 'new':
      return 'KAI responderá en breve';
    case 'contacted':
    case 'conversing':
      return 'KAI está cualificando';
    case 'interested':
      return 'KAI sigue cualificando';
    case 'qualified':
      return 'KAI propondrá la llamada';
    case 'call_proposed':
      return 'Esperando que elija horario';
    case 'call_booked':
    case 'reminder_sent':
      return 'Prepara la llamada';
    case 'no_show':
      return 'Reagendar la llamada';
    case 'follow_up':
      return 'Seguimiento automático en curso';
    case 'client':
      return 'Cliente';
    case 'lost':
      return 'Perdido';
  }
}
