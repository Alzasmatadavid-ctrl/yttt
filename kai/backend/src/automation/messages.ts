/**
 * Textos de confirmación, recordatorios y no-show.
 * Se generan de forma determinista (no con IA) para que la fecha y la hora sean SIEMPRE exactas,
 * adaptando el tono (emojis, formalidad) a la configuración del entrenador.
 */
import { formatInZone, humanSlotLabel } from '../lib/time.js';
import { firstName, pick, hashString } from '../lib/text.js';
import type { AiTone } from '../lib/domain.js';

interface Ctx {
  leadName: string;
  trainerName: string;
  callLabel: string;
  startsAt: Date;
  timezone: string;
  meetingUrl?: string | null;
  tone: AiTone;
}

const e = (tone: AiTone, emoji: string) => (tone.emojiUsage === 'none' ? '' : ` ${emoji}`);

export function confirmationText(c: Ctx): string {
  const name = firstName(c.leadName);
  const when = formatInZone(c.startsAt, c.timezone, "cccc d 'de' LLLL 'a las' HH:mm");
  return `${name ? `${name}, ` : ''}te confirmo la ${c.callLabel} con ${c.trainerName} el ${when}${e(c.tone, '✅')}${c.meetingUrl ? ` Enlace: ${c.meetingUrl}` : ''} Si necesitas cambiarla, dímelo por aquí.`;
}

export function reminderText(c: Ctx, kind: '24h' | '1h'): string {
  const name = firstName(c.leadName);
  const seed = hashString(`${c.leadName}${c.startsAt.toISOString()}${kind}`);
  if (kind === '24h') {
    const label = humanSlotLabel(c.startsAt, c.timezone, new Date());
    const opener = pick(['¡Hola', 'Hola', 'Buenas'], seed);
    return `${opener}${name ? ` ${name}` : ''}! Te recuerdo que ${label} tienes la ${c.callLabel} con ${c.trainerName}${e(c.tone, '📅')}${c.meetingUrl ? ` Enlace: ${c.meetingUrl}` : ''} ¿Te sigue viniendo bien?`;
  }
  const time = formatInZone(c.startsAt, c.timezone, 'HH:mm');
  return `${name ? `${name}, ` : ''}en una hora (a las ${time}) es la ${c.callLabel} con ${c.trainerName}${e(c.tone, '🙌')}${c.meetingUrl ? ` Te dejo el enlace: ${c.meetingUrl}` : ' ¡Hablamos enseguida!'}`;
}

export function noShowText(c: Pick<Ctx, 'leadName' | 'callLabel' | 'tone'>): string {
  const name = firstName(c.leadName);
  const opener = c.tone.formality <= 2 ? `Ey${name ? ` ${name}` : ''}` : `Hola${name ? ` ${name}` : ''}`;
  return `${opener}, veo que finalmente no pudiste entrar a la ${c.callLabel}. ¿Todo bien? Si quieres, buscamos otro hueco.`;
}

/** Parámetros extra para plantillas de WhatsApp de recordatorio: {{2}} = fecha y hora. */
export function reminderTemplateParams(c: Pick<Ctx, 'startsAt' | 'timezone'>): string[] {
  return [formatInZone(c.startsAt, c.timezone, "cccc d 'de' LLLL 'a las' HH:mm")];
}
