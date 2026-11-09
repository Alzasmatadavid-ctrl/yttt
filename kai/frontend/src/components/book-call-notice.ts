/*
 * Aviso tras agendar una llamada a mano: qué le va a enviar KAI al lead. Si KAI no puede escribirle (no tiene ninguna
 * conversación con él o pidió la baja) o el entrenador tiene desactivados la confirmación y los recordatorios, no se
 * promete nada y se le pide que le avise él. Sin dependencias de React ni de '@shared' para poder probarlo aparte.
 */

/** Lo justo de una automatización de Ajustes (`/settings` → automations). */
export interface ReminderAutomationLike {
  type: string;
  enabled: boolean;
  config: { confirmation?: boolean; reminder24h?: boolean; reminder1h?: boolean };
}

/** Por qué KAI no podrá avisar al lead de la cita (o null si puede escribirle). */
export function cannotNotifyReason(opts: { hasConversation: boolean; optedOut: boolean }): string | null {
  if (opts.optedOut) return 'Este lead está dado de baja: KAI no le enviará la confirmación ni los recordatorios de la llamada.';
  if (!opts.hasConversation)
    return 'KAI no tiene ninguna conversación con este lead, así que no puede enviarle la confirmación ni los recordatorios de la llamada.';
  return null;
}

/**
 * Texto del aviso de «Llamada agendada». `willNotify` es lo que diga el servidor al reservar (si lo dice);
 * `automations`, las automatizaciones del negocio (undefined mientras no se conocen).
 * Los márgenes de los recordatorios son los mismos que usa el servidor al programarlos (24 h antes si quedan más de
 * 25 h; 1 h antes si quedan más de 65 minutos).
 */
export function bookedCallNotice(opts: {
  start: Date | string;
  now?: Date;
  hasConversation: boolean;
  optedOut: boolean;
  automations?: ReminderAutomationLike[] | null;
  willNotify?: boolean | null;
}): { text: string; tone: 'success' | 'info' } {
  const reason = cannotNotifyReason(opts);
  if (reason) return { text: `Llamada agendada. ${reason} Avísale tú.`, tone: 'info' };
  if (opts.willNotify === false) return { text: 'Llamada agendada. KAI no podrá avisar a este lead de la cita: avísale tú.', tone: 'info' };
  if (!opts.automations) return { text: 'Llamada agendada. KAI enviará al lead la confirmación y los recordatorios que tengas activados.', tone: 'success' };

  const reminders = opts.automations.find((a) => a.type === 'appointment_reminders');
  const on = (k: 'confirmation' | 'reminder24h' | 'reminder1h') => Boolean(reminders?.enabled) && reminders!.config[k] !== false;
  if (!on('confirmation') && !on('reminder24h') && !on('reminder1h'))
    return {
      text: 'Llamada agendada. Tienes desactivados la confirmación y los recordatorios (Setter IA → Seguimientos), así que KAI no le escribirá: avísale tú.',
      tone: 'info',
    };

  const msUntil = new Date(opts.start).getTime() - (opts.now ?? new Date()).getTime();
  const r24 = on('reminder24h') && msUntil > 25 * 3600_000;
  const r1 = on('reminder1h') && msUntil > 65 * 60_000;
  const parts: string[] = [];
  if (on('confirmation')) parts.push('la confirmación');
  if (r24 && r1) parts.push('los recordatorios');
  else if (r24) parts.push('un recordatorio el día antes');
  else if (r1) parts.push('un recordatorio una hora antes');
  if (!parts.length) return { text: 'Llamada agendada. Es muy pronto para enviarle recordatorios: avísale tú.', tone: 'info' };
  return { text: `Llamada agendada. KAI le enviará ${parts.join(' y ')}.`, tone: 'success' };
}
