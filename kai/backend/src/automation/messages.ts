/**
 * Textos de confirmación, recordatorios y no-show.
 * Se generan de forma determinista (no con IA) para que la fecha y la hora sean SIEMPRE exactas,
 * adaptando el tono (emojis, formalidad y trato de tú o de usted) a la configuración del entrenador.
 *
 * El entrenador puede sustituir cada texto por el suyo (Seguimientos → mensajes de la llamada) usando
 * variables que se rellenan con los datos reales de cada cita: {nombre}, {fecha}, {hora}, {llamada},
 * {entrenador} y {enlace}. Si lo deja vacío, se usa el texto por defecto de KAI.
 */
import { DateTime } from 'luxon';
import { formatInZone, humanSlotLabel } from '../lib/time.js';
import { firstName, pick, hashString } from '../lib/text.js';
import type { AiTone, AutomationConfig } from '../lib/domain.js';

interface Ctx {
  leadName: string;
  trainerName: string;
  callLabel: string;
  startsAt: Date;
  timezone: string;
  meetingUrl?: string | null;
  tone: AiTone;
}

/** Cierre de frase: el emoji hace de separador; sin emojis, un punto (“…a las 18:00. Si necesitas…”). */
const end = (tone: AiTone, emoji: string) => (tone.emojiUsage === 'none' ? '.' : ` ${emoji}`);

/** “Laura, te confirmo…” o, sin nombre, “Te confirmo…”. */
const withName = (name: string, rest: string) => (name ? `${name}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1));

/** El entrenador ha elegido tratar a los leads “de usted” (Ajustes de KAI → Tono). */
const isUsted = (tone: Pick<AiTone, 'addressing'> | null | undefined) => tone?.addressing === 'usted';

/** Elige la forma de tú o de usted según el tono configurado. */
const tuUsted = (tone: Pick<AiTone, 'addressing'> | null | undefined, tu: string, usted: string) => (isUsted(tone) ? usted : tu);

// ───────────── Textos editables ─────────────

export type AppointmentMessageKind = 'confirmation' | 'reminder24h' | 'reminder1h' | 'noShow';

/** Campo de la configuración de la automatización donde se guarda cada texto. */
export const APPOINTMENT_MESSAGE_FIELDS = {
  confirmation: 'confirmationMessage',
  reminder24h: 'reminder24hMessage',
  reminder1h: 'reminder1hMessage',
  noShow: 'noShowMessage',
} as const satisfies Record<AppointmentMessageKind, keyof AutomationConfig>;

export const MESSAGE_TEMPLATE_MAX_LENGTH = 700;

/** Variables disponibles y qué ponen (para mostrarlas en la interfaz). */
export const MESSAGE_VARIABLES = [
  { key: 'nombre', label: 'Nombre del lead', example: 'Laura' },
  { key: 'fecha', label: 'Día de la llamada', example: '«mañana» o «el jueves 9 de octubre»' },
  { key: 'hora', label: 'Hora de la llamada', example: '18:00' },
  { key: 'llamada', label: 'Cómo llamas a la llamada', example: 'llamada de valoración' },
  { key: 'entrenador', label: 'Tu nombre', example: 'Álex' },
  { key: 'enlace', label: 'Enlace de la videollamada (si la llamada no tiene, KAI lo quita del mensaje)', example: 'https://meet.google.com/…' },
] as const;

const VARIABLE_KEYS: readonly string[] = MESSAGE_VARIABLES.map((v) => v.key);

/** Variables obligatorias de cada texto: un recordatorio sin la hora no sirve. */
const REQUIRED_VARIABLES: Record<AppointmentMessageKind, string[]> = {
  confirmation: ['fecha', 'hora'],
  reminder24h: ['fecha', 'hora'],
  reminder1h: ['hora'],
  noShow: [],
};

/** Textos por defecto, para mostrarlos como punto de partida en la interfaz (tratando al lead de tú). */
export const DEFAULT_MESSAGE_TEMPLATES: Record<AppointmentMessageKind, string> = {
  confirmation: '{nombre}, te confirmo la {llamada} con {entrenador} {fecha} a las {hora} ✅\nEnlace: {enlace}\nSi necesitas cambiarla, dímelo por aquí.',
  reminder24h: '¡Hola {nombre}! Te recuerdo que {fecha} a las {hora} tienes la {llamada} con {entrenador} 📅\nEnlace: {enlace}\n¿Te sigue viniendo bien?',
  reminder1h: '{nombre}, en una hora (a las {hora}) es la {llamada} con {entrenador} 🙌\nTe dejo el enlace: {enlace}',
  noShow: 'Ey {nombre}, veo que finalmente no pudiste entrar a la {llamada}. ¿Todo bien? Si quieres, buscamos otro hueco.',
};

/** Los mismos textos tratando al lead de usted. */
export const DEFAULT_MESSAGE_TEMPLATES_USTED: Record<AppointmentMessageKind, string> = {
  confirmation: '{nombre}, le confirmo la {llamada} con {entrenador} {fecha} a las {hora} ✅\nEnlace: {enlace}\nSi necesita cambiarla, dígamelo por aquí.',
  reminder24h: '¡Hola {nombre}! Le recuerdo que {fecha} a las {hora} tiene la {llamada} con {entrenador} 📅\nEnlace: {enlace}\n¿Le sigue viniendo bien?',
  reminder1h: '{nombre}, en una hora (a las {hora}) es la {llamada} con {entrenador} 🙌\nLe dejo el enlace: {enlace}',
  noShow: 'Hola {nombre}, veo que finalmente no pudo entrar a la {llamada}. ¿Va todo bien? Si quiere, buscamos otro hueco.',
};

/** Textos por defecto según el trato elegido por el entrenador (de tú o de usted). */
export function defaultMessageTemplates(tone: Pick<AiTone, 'addressing'> | null | undefined): Record<AppointmentMessageKind, string> {
  return isUsted(tone) ? DEFAULT_MESSAGE_TEMPLATES_USTED : DEFAULT_MESSAGE_TEMPLATES;
}

const RX_VARIABLE = /\{([^{}\n]*)\}/g;
const RX_PRICE = /\d+(?:[.,]\d{1,2})?\s?(?:€|euros?\b|eur\b)|€\s?\d/i;
const RX_LITERAL_TIME = /\b(?:[01]?\d|2[0-3])[:.h][0-5]\d\b|\ba las \d{1,2}\b/i;

/** Problemas de un texto personalizado (vacío = sin problemas: se usará el texto por defecto). */
export function messageTemplateIssues(kind: AppointmentMessageKind, template: string): string[] {
  const text = template.trim();
  if (!text) return [];
  const issues: string[] = [];
  if (text.length > MESSAGE_TEMPLATE_MAX_LENGTH) issues.push(`El texto es demasiado largo (máximo ${MESSAGE_TEMPLATE_MAX_LENGTH} caracteres).`);
  const used = [...text.matchAll(RX_VARIABLE)].map((m) => m[1].trim().toLowerCase());
  const unknown = [...new Set(used.filter((v) => !VARIABLE_KEYS.includes(v)))];
  if (unknown.length) {
    issues.push(`${unknown.map((v) => `{${v}}`).join(', ')} no ${unknown.length > 1 ? 'son variables válidas' : 'es una variable válida'}. Puedes usar: ${VARIABLE_KEYS.map((v) => `{${v}}`).join(', ')}.`);
  }
  if (/[{}]/.test(text.replace(RX_VARIABLE, ''))) issues.push('Revisa las llaves: cada variable va entre { y }, por ejemplo {nombre}.');
  const missing = REQUIRED_VARIABLES[kind].filter((v) => !used.includes(v));
  if (missing.length) issues.push(`Incluye ${missing.map((v) => `{${v}}`).join(' y ')} para que el lead sepa exactamente cuándo es la llamada.`);
  if ((text.match(/\?/g) ?? []).length > 1) issues.push('Haz como máximo una pregunta en el mensaje.');
  const withoutVariables = text.replace(RX_VARIABLE, ' ');
  if (RX_LITERAL_TIME.test(withoutVariables)) issues.push('No escribas horas concretas: usa {hora}, que se rellena con la hora real de cada llamada.');
  if (RX_PRICE.test(withoutVariables)) issues.push('No incluyas precios en este mensaje.');
  return issues;
}

/** Revisa todos los textos personalizados de una configuración (para validar al guardar). */
export function automationMessageIssues(config: AutomationConfig): { field: string; issues: string[] }[] {
  const out: { field: string; issues: string[] }[] = [];
  for (const [kind, field] of Object.entries(APPOINTMENT_MESSAGE_FIELDS) as [AppointmentMessageKind, keyof AutomationConfig][]) {
    const value = config[field];
    if (typeof value !== 'string') continue;
    const issues = messageTemplateIssues(kind, value);
    if (issues.length) out.push({ field, issues });
  }
  return out;
}

/** “hoy”, “mañana”, “pasado mañana” o “el jueves 9 de octubre”, en la zona del negocio y respecto a `reference`. */
function dayLabel(startsAt: Date, timezone: string, reference: Date): string {
  const start = DateTime.fromJSDate(startsAt).setZone(timezone).setLocale('es');
  const diffDays = Math.round(start.startOf('day').diff(DateTime.fromJSDate(reference).setZone(timezone).startOf('day'), 'days').days);
  if (diffDays === 0) return 'hoy';
  if (diffDays === 1) return 'mañana';
  if (diffDays === 2) return 'pasado mañana';
  return `el ${start.toFormat("cccc d 'de' LLLL")}`;
}

const RX_LINK_VARIABLE = /\{\s*enlace\s*\}/i;

/**
 * La cita no tiene enlace: quita {enlace} y la etiqueta que lo presenta (“Enlace: {enlace}”,
 * “… 🙌 Te dejo el enlace: {enlace}”). Devuelve null si la línea se queda vacía.
 */
function withoutLink(line: string): string | null {
  const idx = line.search(RX_LINK_VARIABLE);
  if (idx === -1) return line.trim() ? line : null;
  let before = line.slice(0, idx);
  const after = line.slice(idx).replace(RX_LINK_VARIABLE, '');
  if (/:\s*$/.test(before)) {
    // Etiqueta = lo que hay desde el último final de frase (., !, ?, emoji) hasta los dos puntos.
    const m = /^(.*[.!?…\p{Extended_Pictographic}])?([^.!?…\p{Extended_Pictographic}]*):\s*$/u.exec(before);
    const label = m?.[2] ?? before;
    before = label.trim().length <= 40 ? (m?.[1] ?? '') : before.replace(/:\s*$/, '');
  }
  return withoutLink(before + after);
}

/**
 * Rellena un texto personalizado con los datos reales de la cita.
 * - Sin nombre del lead, “Hola {nombre}, …” queda “Hola, …”.
 * - Sin enlace, se quita {enlace} junto con su etiqueta (“Enlace: {enlace}”); si era una línea aparte, la línea entera.
 */
export function renderMessageTemplate(template: string, c: Partial<Ctx> & Pick<Ctx, 'leadName' | 'callLabel'>, reference: Date = new Date()): string {
  const tz = c.timezone ?? 'Europe/Madrid';
  const values: Record<string, string> = {
    nombre: firstName(c.leadName),
    fecha: c.startsAt ? dayLabel(c.startsAt, tz, reference) : '',
    hora: c.startsAt ? formatInZone(c.startsAt, tz, 'HH:mm') : '',
    llamada: c.callLabel,
    entrenador: c.trainerName ?? '',
    enlace: c.meetingUrl ?? '',
  };
  const lines = template
    .trim()
    .split('\n')
    .map((line) => (values.enlace || !RX_LINK_VARIABLE.test(line) ? line : withoutLink(line)))
    .filter((line): line is string => line !== null)
    .map((line) =>
      line
        .replace(RX_VARIABLE, (_m, key: string) => values[key.trim().toLowerCase()] ?? '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;:!?])/g, '$1')
        .replace(/([¡¿])[ \t]+/g, '$1')
        .replace(/^[\s,;:]+/, '')
        .trimEnd(),
    );
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Texto personalizado válido, o null si no hay (o no es válido: entonces se usa el texto por defecto). */
function customTemplate(kind: AppointmentMessageKind, custom: string | null | undefined): string | null {
  if (!custom || !custom.trim()) return null;
  return messageTemplateIssues(kind, custom).length ? null : custom;
}

/** Texto personalizado de la configuración de la automatización (o undefined si no hay). */
export function configuredMessage(config: AutomationConfig | null | undefined, kind: AppointmentMessageKind): string | undefined {
  const value = config?.[APPOINTMENT_MESSAGE_FIELDS[kind]];
  return typeof value === 'string' ? value : undefined;
}

// ───────────── Textos por defecto (y uso de los personalizados) ─────────────

export function confirmationText(c: Ctx, custom?: string | null): string {
  const template = customTemplate('confirmation', custom);
  if (template) return renderMessageTemplate(template, c);
  const name = firstName(c.leadName);
  const when = formatInZone(c.startsAt, c.timezone, "cccc d 'de' LLLL 'a las' HH:mm");
  return withName(
    name,
    `${tuUsted(c.tone, 'te', 'le')} confirmo la ${c.callLabel} con ${c.trainerName} el ${when}${end(c.tone, '✅')}${c.meetingUrl ? ` Enlace: ${c.meetingUrl}` : ''} ${tuUsted(c.tone, 'Si necesitas cambiarla, dímelo por aquí.', 'Si necesita cambiarla, dígamelo por aquí.')}`,
  );
}

export function reminderText(c: Ctx, kind: '24h' | '1h', custom?: string | null): string {
  const template = customTemplate(kind === '24h' ? 'reminder24h' : 'reminder1h', custom);
  if (template) return renderMessageTemplate(template, c);
  const name = firstName(c.leadName);
  const seed = hashString(`${c.leadName}${c.startsAt.toISOString()}${kind}`);
  const usted = isUsted(c.tone);
  if (kind === '24h') {
    const label = humanSlotLabel(c.startsAt, c.timezone, new Date());
    // “Buenas” es demasiado coloquial para quien trata al lead de usted.
    const opener = pick(usted ? ['¡Hola', 'Hola'] : ['¡Hola', 'Hola', 'Buenas'], seed);
    const body = usted
      ? `Le recuerdo que ${label} tiene la ${c.callLabel} con ${c.trainerName}`
      : `Te recuerdo que ${label} tienes la ${c.callLabel} con ${c.trainerName}`;
    return `${opener}${name ? ` ${name}` : ''}! ${body}${end(c.tone, '📅')}${c.meetingUrl ? ` Enlace: ${c.meetingUrl}` : ''} ${usted ? '¿Le sigue viniendo bien?' : '¿Te sigue viniendo bien?'}`;
  }
  const time = formatInZone(c.startsAt, c.timezone, 'HH:mm');
  return withName(
    name,
    `en una hora (a las ${time}) es la ${c.callLabel} con ${c.trainerName}${end(c.tone, '🙌')}${c.meetingUrl ? ` ${usted ? 'Le' : 'Te'} dejo el enlace: ${c.meetingUrl}` : ' ¡Hablamos enseguida!'}`,
  );
}

export function noShowText(c: Pick<Ctx, 'leadName' | 'callLabel' | 'tone'> & Partial<Ctx>, custom?: string | null): string {
  const template = customTemplate('noShow', custom);
  if (template) return renderMessageTemplate(template, c);
  const name = firstName(c.leadName);
  if (isUsted(c.tone)) {
    // De usted, siempre “Hola” (un “Ey” no encaja con ese trato).
    return `Hola${name ? ` ${name}` : ''}, veo que finalmente no pudo entrar a la ${c.callLabel}. ¿Va todo bien? Si quiere, buscamos otro hueco.`;
  }
  const opener = c.tone.formality <= 2 ? `Ey${name ? ` ${name}` : ''}` : `Hola${name ? ` ${name}` : ''}`;
  return `${opener}, veo que finalmente no pudiste entrar a la ${c.callLabel}. ¿Todo bien? Si quieres, buscamos otro hueco.`;
}

/** Parámetros extra para plantillas de WhatsApp de recordatorio: {{2}} = fecha y hora. */
export function reminderTemplateParams(c: Pick<Ctx, 'startsAt' | 'timezone'>): string[] {
  return [formatInZone(c.startsAt, c.timezone, "cccc d 'de' LLLL 'a las' HH:mm")];
}
