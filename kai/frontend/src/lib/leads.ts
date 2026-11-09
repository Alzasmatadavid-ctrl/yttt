import type { LeadStatus } from '@shared';
import { dateTime } from './format';

/**
 * Próxima acción sugerida para un lead (lo que verá el entrenador en la bandeja).
 * timeZone: zona horaria del negocio, para que la hora de la llamada coincida con la de la Agenda.
 */
export function nextActionFor(
  lead: { status: LeadStatus; nextAction?: string | null; optedOut?: boolean },
  /**
   * needsHumanReply: el último mensaje del lead está sin contestar y KAI no lo va a contestar (como en «Pendientes»).
   * replyUnsent: se intentó contestarle (KAI o el equipo) y la respuesta no se pudo enviar (ver unsentReply).
   */
  conv?: { handoffActive?: boolean; aiEnabled?: boolean; needsHumanReply?: boolean; replyUnsent?: boolean } | null,
  upcoming?: { startsAt: string } | null,
  timeZone?: string,
  /** false = el piloto automático de KAI está en pausa: no va a contestar a nadie. */
  autopilotOn = true,
): string {
  if (lead.optedOut) return 'No contactar (pidió la baja)';
  if (conv?.handoffActive) return 'Responder tú (KAI te lo ha pasado)';
  // La respuesta no le llegó (canal sin conectar, ventana de 24 h cerrada…): volver a pedírsela a KAI no basta.
  if (conv?.needsHumanReply && conv.replyUnsent) return 'Respuesta no enviada: revisa el motivo en la conversación';
  // El último mensaje del lead espera respuesta y KAI no lo va a contestar (lo mismo que «Pendientes»):
  // con el piloto automático en pausa no contesta a nadie; si está activo, no tiene ninguna respuesta en marcha
  // para ese mensaje (p. ej. llegó con KAI en pausa), así que no se puede decir que «KAI responderá en breve».
  if (conv?.needsHumanReply && conv.aiEnabled !== false && lead.status !== 'client')
    return autopilotOn ? 'Mensaje sin contestar: respóndele tú o deja que lo haga KAI' : 'KAI en pausa: responde tú';
  if (lead.nextAction) return lead.nextAction;
  if (upcoming) return `Llamada ${dateTime(upcoming.startsAt, timeZone)}`;
  if (conv && !conv.aiEnabled) return 'Conversación en tus manos';
  // Con KAI en pausa y nada que contestar (el último mensaje es nuestro, o hay una llamada en marcha), se dice en qué
  // punto está el lead; nunca que KAI va a escribir, ni «responde tú» si no hay ningún mensaje esperando.
  const paused = !autopilotOn;
  switch (lead.status) {
    case 'new':
      return paused ? 'KAI en pausa: escríbele tú' : 'KAI responderá en breve';
    case 'contacted':
    case 'conversing':
      return paused ? 'Esperando respuesta del lead (KAI en pausa)' : 'KAI está cualificando';
    case 'interested':
      return paused ? 'Esperando respuesta del lead (KAI en pausa)' : 'KAI sigue cualificando';
    case 'qualified':
      return paused ? 'Esperando respuesta del lead (KAI en pausa)' : 'KAI propondrá la llamada';
    case 'call_proposed':
      return 'Esperando que elija horario';
    case 'call_booked':
    case 'reminder_sent':
      return 'Prepara la llamada';
    case 'no_show':
      return 'Reagendar la llamada';
    case 'follow_up':
      return paused ? 'Esperando respuesta del lead (KAI en pausa)' : 'Seguimiento automático en curso';
    case 'client':
      return 'Cliente';
    case 'lost':
      return 'Perdido';
  }
}
