import type { AiTone } from '../../lib/domain.js';

/** Traduce los controles visuales de tono a instrucciones claras para la IA. */
export function describeTone(t: AiTone): string {
  const formality = ['muy informal y cercano (como un colega)', 'informal y cercano', 'cercano pero cuidado', 'profesional', 'muy formal'][clamp(t.formality) - 1];
  const energy = ['calmado y pausado', 'tranquilo', 'equilibrado', 'enérgico y motivador', 'muy enérgico, con mucha chispa'][clamp(t.energy) - 1];
  const directness = ['muy suave y diplomático', 'suave', 'claro', 'directo', 'muy directo, sin rodeos'][clamp(t.directness) - 1];
  const emojis = { none: 'No uses emojis nunca.', low: 'Como mucho 1 emoji, y solo si encaja.', medium: 'Puedes usar hasta 2–3 emojis si encajan.', high: 'Usa emojis con naturalidad (hasta 3).' }[t.emojiUsage];
  const length = {
    short: 'Mensajes MUY cortos: 1–2 frases (máx. ~280 caracteres), como en un chat real.',
    medium: 'Mensajes cortos: 2–3 frases (máx. ~450 caracteres).',
    long: 'Mensajes de hasta 4–5 frases (máx. ~700 caracteres) cuando haga falta explicar algo.',
  }[t.messageLength];
  const addressing = t.addressing === 'usted' ? 'Trata al lead de usted.' : 'Tutea al lead.';
  return `Tono ${formality}, ${energy} y ${directness}. ${addressing} ${emojis} ${length}`;
}

export function maxCharsFor(t: AiTone): number {
  return { short: 320, medium: 520, long: 800 }[t.messageLength];
}

export function maxEmojisFor(t: AiTone): number {
  return { none: 0, low: 1, medium: 3, high: 4 }[t.emojiUsage];
}

const clamp = (n: number) => Math.min(5, Math.max(1, Math.round(n || 3)));
