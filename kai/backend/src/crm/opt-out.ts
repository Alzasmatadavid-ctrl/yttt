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

/** Palabras de cortesía o despedida («gracias», «igualmente», «vale», «un saludo», «adiós»…). */
const COURTESY_WORDS = new Set(
  (
    'gracias muchas muchisimas mil por todo igualmente igual tambien lo mismo digo a y ti tu vosotros usted os de nada ok okay okey oki vale perfecto ' +
    'genial estupendo entendido entendida acuerdo bien muy pues guay si claro adios chao ciao bye hasta luego pronto otra nos vemos ' +
    'saludo saludos un una abrazo abrazos besos beso cuidate cuidaos buenas buenos buen noches tardes dias dia que te vaya vayan ' +
    'animo mucho thanks thank you jaja jajaja jeje jejeje'
  ).split(' '),
);

/**
 * Mensaje que solo es cortesía o despedida, sin nada que contestar: «Gracias», «Vale, igualmente», «👍», «🙏🏻»…
 * Se usa con los leads dados de baja: lo habitual es que contesten «Gracias» a la despedida de KAI, y eso no es
 * «volver a escribir» (no tiene que salir en «Pendientes» ni generar un aviso). Es estricta: una pregunta o
 * cualquier palabra fuera de la lista ya no cuenta como cortesía.
 */
export function isCourtesyOnly(text: string): boolean {
  if (!text.trim() || text.length > 80 || text.includes('?')) return false;
  const words = normalize(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // Solo emojis o signos («👍», «🙏», «!!»): una reacción a la despedida.
  if (words.length === 0) return true;
  return words.length <= 8 && words.every((w) => COURTESY_WORDS.has(w));
}
