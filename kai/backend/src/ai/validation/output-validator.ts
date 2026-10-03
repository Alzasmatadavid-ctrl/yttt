/**
 * Control de calidad ANTES de enviar cualquier mensaje de KAI.
 *
 * Capa 1 (determinista, siempre): reglas verificables con datos reales
 *   - una sola pregunta, longitud, formato de chat, emojis, palabras prohibidas
 *   - horarios: solo los ofrecidos por la agenda real
 *   - precios: solo los configurados
 *   - enlaces: solo los permitidos
 *   - promesas de resultados, consejos médicos, presión, frases robóticas, seguimiento genérico
 *   - cifras de autoridad/testimonios que no estén en el perfil del entrenador
 * Capa 2 (opcional, IA rápida): ¿responde a lo último que dijo? ¿suena humano? ¿inventa algo?
 *
 * Si falla, el motor regenera la respuesta con estos motivos como feedback.
 */
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AiTone } from '../../lib/domain.js';
import { countEmojis, normalize } from '../../lib/text.js';
import { maxCharsFor, maxEmojisFor } from '../prompts/tone.js';
import type { LLMProvider } from '../providers/types.js';

export interface ValidationContext {
  tone: AiTone;
  wordsToAvoid: string[];
  timezone: string;
  allowedTimes: Date[];
  allowedPricesCents: number[];
  allowedUrls: string[];
  /** Texto con los datos de autoridad reales (para permitir cifras que sí existen). */
  factsText: string;
  isFollowUp?: boolean;
  /** Nombre del asistente (para no confundir su presentación con frases robóticas). */
  assistantName?: string;
  /** Mensajes que puede contener 2 preguntas (p. ej. confirmación + pregunta de cortesía): por defecto 1. */
  maxQuestions?: number;
  /** Últimos mensajes de KAI en la conversación (para no repetirse). */
  previousMessages?: string[];
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

const RX_MARKDOWN = /\*\*|__|^#{1,6}\s|^\s*[-*•]\s+\S|^\s*\d+[.)]\s+\S/m;
const RX_ROBOTIC =
  /como (un )?(modelo de lenguaje|asistente virtual de ia)|no tengo (sentimientos|cuerpo)|estoy aqui para ayudarte|no dudes en (contactar|preguntar|escribir)|en que (mas )?puedo ayudarte hoy|espero que este mensaje te encuentre bien|como inteligencia artificial,? no puedo|¡?saludos cordiales/;
const RX_PROMISE =
  /garantiz|te aseguro que (vas a|vas|lo vas)|100\s?%\s?(seguro|garantizado)|resultados? (asegurados?|garantizados?)|(perderas|bajaras|vas a perder|vas a bajar|conseguiras perder)\s+(\d+|unos|varios)\s*(kg|kilos)|seguro que (lo )?(consigues|vas a conseguir)|en \d+ (dias|semanas) (veras|tendras|perderas)/;
const RX_MEDICAL =
  /(deja|dejar|suspende|suspender|ajusta|ajustar|reduce|reducir|aumenta|aumentar|cambia|cambiar) (la |tu |de )?(medicacion|insulina|pastillas|dosis|tratamiento)|te diagnostic|(tienes|sufres|padeces) (diabetes|hipotiroidismo|una hernia|una lesion|resistencia a la insulina|sop)|eso es (una|un) (tendinitis|hernia|lesion|sindrome)/;
const RX_PRESSURE =
  /ultima oportunidad|solo (por )?hoy|quedan (pocas|solo \d+) plazas|plazas limitadas|si no (te )?decides (ahora|hoy)|no lo pienses mas|oferta (exclusiva|limitada|solo para ti)|ahora o nunca|se acaba (hoy|manana)|precio sube (manana|pronto)/;
const RX_GENERIC_FOLLOWUP = /solo (hago|te hago|queria hacer|para hacer) (un )?seguimiento|solo queria saber si (has visto|viste|leiste)|te escribo para hacer seguimiento|hago seguimiento/;
// “A las 17” también al inicio de frase (i) y “a las 17.” con punto final: solo se descarta si sigue “:30”/“.30”.
const RX_TIME = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(h|hs|horas)?\b|\ba las ([01]?\d|2[0-3])(?![:.]?\d)(?:\s*(?:h|hs|horas)\b)?(?:\s*(y media|y cuarto|menos cuarto))?\b/gi;
const RX_PRICE = /(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(€|euros?|eur\b)|€\s?(\d+(?:[.,]\d{1,2})?)/gi;
const RX_URL = /https?:\/\/[^\s)]+/gi;
const RX_CLAIMED_NUMBERS = /(\+?\d[\d.]*)\s*(clientes|alumnos|personas|transformaciones|anos de experiencia|kilos perdidos|kg perdidos)/g;

const overlapsAny = (m: RegExpMatchArray, spans: RegExpMatchArray[]) =>
  spans.some((s) => m.index! < s.index! + s[0].length && s.index! < m.index! + m[0].length);

/** Números citados en los datos reales (“1.000” → 1000, “+500” → 500). */
function numbersIn(text: string): Set<number> {
  return new Set([...text.matchAll(/\d{1,3}(?:\.\d{3})+(?!\d)|\d+/g)].map((m) => Number(m[0].replace(/\./g, ''))));
}

/** ¿Es el mismo enlace? Admite que la IA omita los parámetros (?utm_…) o la barra final, pero no otra ruta. */
function sameUrl(candidate: string, allowed: string): boolean {
  if (candidate === allowed) return true;
  try {
    const a = new URL(candidate);
    const b = new URL(allowed);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '');
    const query = (u: URL) => [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort().join('&');
    return a.protocol === b.protocol && a.host === b.host && path(a) === path(b) && (!a.search || query(a) === query(b)) && (!a.hash || a.hash === b.hash);
  } catch {
    return false;
  }
}

function parsePriceToCents(raw: string): number | null {
  let s = raw.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function validateReply(text: string, ctx: ValidationContext): ValidationResult {
  const issues: string[] = [];
  const trimmed = text.trim();
  const n = normalize(trimmed);

  if (!trimmed) return { ok: false, issues: ['El mensaje está vacío.'] };
  const maxChars = maxCharsFor(ctx.tone);
  if (trimmed.length > maxChars) issues.push(`Es demasiado largo (${trimmed.length} caracteres; máximo ${maxChars}). Acórtalo.`);

  const questionMarks = (trimmed.match(/\?/g) ?? []).length;
  if (questionMarks > (ctx.maxQuestions ?? 1)) issues.push(`Hace ${questionMarks} preguntas. Haz solo UNA pregunta principal.`);

  if (ctx.previousMessages?.some((p) => normalize(p) === n)) issues.push('Repite exactamente un mensaje anterior. Reformúlalo de forma distinta y natural.');
  if (RX_MARKDOWN.test(trimmed)) issues.push('Usa formato de documento (listas, negritas o títulos). Escribe como en un chat.');
  if (RX_ROBOTIC.test(n)) issues.push('Suena a chatbot genérico. Reescríbelo con naturalidad, como una persona del equipo.');
  if (/<\/?[a-z_]+>|⟦|⟧|\[nota interna/i.test(trimmed)) issues.push('Incluye etiquetas o notas internas que el lead no debe ver.');

  const emojiCount = countEmojis(trimmed);
  const maxEmojis = maxEmojisFor(ctx.tone);
  if (emojiCount > maxEmojis) issues.push(maxEmojis === 0 ? 'El entrenador no usa emojis: quítalos.' : `Usa demasiados emojis (${emojiCount}; máximo ${maxEmojis}).`);

  for (const w of ctx.wordsToAvoid) {
    const nw = normalize(w);
    if (nw && new RegExp(`(^|[^a-z0-9])${nw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(n)) issues.push(`Usa la palabra prohibida “${w}”.`);
  }

  if (RX_PROMISE.test(n)) issues.push('Promete o garantiza resultados. KAI no puede prometer resultados físicos.');
  if (RX_MEDICAL.test(n)) issues.push('Da un consejo o diagnóstico médico. Deriva a un profesional sanitario.');
  if (RX_PRESSURE.test(n)) issues.push('Presiona con urgencia o escasez. Elimina cualquier presión.');
  if (ctx.isFollowUp && RX_GENERIC_FOLLOWUP.test(n)) issues.push('Es un seguimiento genérico. Usa algo concreto de la conversación (su objetivo, lo que contó).');

  // Importes y enlaces: las cifras que contienen no son horas (“19.50 €”, o un enlace de Calendly con “T18:00:00Z”).
  const urls = [...trimmed.matchAll(RX_URL)];
  const prices = [...trimmed.matchAll(RX_PRICE)].filter((p) => !overlapsAny(p, urls));

  // Horarios: solo los que salen de la agenda real.
  const allowed = ctx.allowedTimes.map((d) => DateTime.fromJSDate(d).setZone(ctx.timezone));
  for (const m of trimmed.matchAll(RX_TIME)) {
    if (overlapsAny(m, prices) || overlapsAny(m, urls)) continue;
    let hour: number;
    let minute: number;
    if (m[1] !== undefined) {
      hour = Number(m[1]);
      minute = Number(m[2]);
    } else {
      hour = Number(m[4]);
      const fraction = m[5]?.toLowerCase().replace(/\s+/g, ' ');
      minute = fraction === 'y media' ? 30 : fraction === 'y cuarto' ? 15 : fraction === 'menos cuarto' ? 45 : 0;
      if (fraction === 'menos cuarto') hour -= 1;
    }
    const matches = allowed.some((a) => a.minute === minute && (a.hour === hour || a.hour % 12 === hour % 12));
    if (!matches) {
      issues.push(`Menciona el horario “${m[0].trim()}”, que no ha salido de la agenda real. Usa get_available_slots y sus etiquetas exactas.`);
      break;
    }
  }

  // Precios: solo los configurados.
  for (const m of prices) {
    const cents = parsePriceToCents(m[1] ?? m[3] ?? '');
    if (cents === null) continue;
    if (!ctx.allowedPricesCents.some((p) => Math.abs(p - cents) <= 1)) {
      issues.push(`Menciona el importe “${m[0].trim()}”, que no coincide con ningún precio configurado. Usa solo precios reales.`);
      break;
    }
  }

  // Enlaces.
  for (const m of urls) {
    const url = m[0].replace(/[.,;!?]+$/, '');
    if (!ctx.allowedUrls.some((u) => sameUrl(url, u))) {
      issues.push('Incluye un enlace que no procede de la agenda ni de la configuración. No inventes enlaces.');
      break;
    }
  }

  // Cifras de autoridad / testimonios que no estén en los datos reales del entrenador.
  const facts = numbersIn(normalize(ctx.factsText));
  for (const m of n.matchAll(RX_CLAIMED_NUMBERS)) {
    const num = Number(m[1].replace(/[+.]/g, ''));
    if (!facts.has(num)) {
      issues.push(`Afirma “${m[0]}”, un dato que no aparece en el perfil del entrenador. No inventes cifras ni testimonios.`);
      break;
    }
  }

  return { ok: issues.length === 0, issues };
}

// ───────────── Capa 2: revisión con IA (opcional) ─────────────

const JudgeSchema = z.object({
  responds_to_last_message: z.boolean(),
  sounds_human: z.boolean(),
  invents_information: z.boolean(),
  pressures_lead: z.boolean(),
  breaks_business_rules: z.boolean(),
  issues: z.array(z.string()),
});

export async function judgeReply(
  provider: LLMProvider,
  input: { reply: string; lastLeadMessages: string; facts: string; objective: string },
): Promise<ValidationResult> {
  try {
    const verdict = await provider.structured({
      tier: 'fast',
      schema: JudgeSchema,
      maxTokens: 800,
      system: [
        {
          text: `Eres el control de calidad de un asistente de mensajería comercial para entrenadores personales.
Evalúa si el BORRADOR se puede enviar. Sé estricto pero razonable (no penalices estilo si cumple las reglas).
- responds_to_last_message: ¿reacciona a lo último que dijo el lead (o cumple el objetivo indicado si no hay mensaje)?
- sounds_human: ¿suena a una persona real por chat (no a un bot, no a un email)?
- invents_information: ¿afirma algo que NO está en los DATOS DISPONIBLES (precios, horarios, resultados, testimonios, servicios, credenciales)?
- pressures_lead: ¿presiona, manipula o crea urgencia falsa?
- breaks_business_rules: ¿promete resultados, da consejo médico o hace más de una pregunta?
En "issues" explica brevemente en español qué corregir (vacío si todo está bien).`,
        },
      ],
      messages: [
        {
          role: 'user',
          content: `DATOS DISPONIBLES:\n${input.facts}\n\nOBJETIVO DEL MENSAJE:\n${input.objective}\n\nÚLTIMOS MENSAJES DEL LEAD:\n${input.lastLeadMessages || '(ninguno: es un mensaje proactivo)'}\n\nBORRADOR:\n${input.reply}`,
        },
      ],
    });
    const issues = [...verdict.issues];
    if (!verdict.responds_to_last_message && issues.length === 0) issues.push('No responde a lo último que dijo el lead.');
    if (!verdict.sounds_human && issues.length === 0) issues.push('No suena humano.');
    if (verdict.invents_information && issues.length === 0) issues.push('Inventa información que no está en los datos.');
    if (verdict.pressures_lead && issues.length === 0) issues.push('Presiona al lead.');
    if (verdict.breaks_business_rules && issues.length === 0) issues.push('Incumple las reglas del negocio.');
    const ok = verdict.responds_to_last_message && verdict.sounds_human && !verdict.invents_information && !verdict.pressures_lead && !verdict.breaks_business_rules;
    return { ok, issues: ok ? [] : issues };
  } catch {
    // Si el juez falla, no bloqueamos: la capa determinista ya ha pasado.
    return { ok: true, issues: [] };
  }
}
