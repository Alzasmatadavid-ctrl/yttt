import type { LeadStatus } from '@shared';
import { dateTime } from './format';

/** Próxima acción sugerida para un lead (lo que verá el entrenador en la bandeja). */
export function nextActionFor(
  lead: { status: LeadStatus; nextAction?: string | null; optedOut?: boolean },
  conv?: { handoffActive?: boolean; aiEnabled?: boolean } | null,
  upcoming?: { startsAt: string } | null,
): string {
  if (lead.optedOut) return 'No contactar (pidió la baja)';
  if (conv?.handoffActive) return 'Responder tú (KAI te lo ha pasado)';
  if (lead.nextAction) return lead.nextAction;
  if (upcoming) return `Llamada ${dateTime(upcoming.startsAt)}`;
  if (conv && !conv.aiEnabled) return 'Conversación en tus manos';
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
