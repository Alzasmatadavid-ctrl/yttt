import { normalize } from '../lib/text.js';

/**
 * Peticiones de baja inequívocas (“dame de baja”, “no me escribáis más”, “STOP”…).
 *
 * Se usa al recibir un mensaje cuando KAI NO va a contestar (conversación en manos del entrenador,
 * piloto automático apagado…): la baja se registra igualmente. Es deliberadamente estricta, porque
 * una baja bloquea todos los envíos al lead, incluidos los del entrenador; los casos dudosos los
 * analiza KAI cuando está activo.
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  /^(stop|baja|unsubscribe|darme de baja|dame de baja|baja por favor|por favor baja)[\s.!]*$/,
  /\b(dame|darme|dadme|quiero darme|me quiero dar) de baja\b/,
  /\b(deja|dejad|dejen|deje) de (escribirme|enviarme mensajes|mandarme mensajes|molestarme)\b/,
  /\bno me (escribas|escribais|escriban|mandes|mandeis|envies|envieis) (mas|ningun|nada)\b/,
  /\bno (quiero|deseo) (recibir|que me (escribas|escribais|escriban|mandes|mandeis|envies|envieis)) (mas|ningun)\b/,
  /\bno quiero recibir (mas )?mensajes\b/,
  /\b(borra|borrad|borren|elimina|eliminad|eliminen) (todos )?mis datos\b/,
];

export function isOptOutRequest(text: string): boolean {
  const n = normalize(text)
    .replace(/[¡¿"“”«»]/g, '')
    .trim();
  if (!n || n.length > 300) return false;
  return OPT_OUT_PATTERNS.some((rx) => rx.test(n));
}
