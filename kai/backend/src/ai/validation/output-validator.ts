/**
 * Control de calidad ANTES de enviar cualquier mensaje de KAI.
 *
 * Capa 1 (determinista, siempre): reglas verificables con datos reales
 *   - una sola pregunta, longitud, formato de chat, emojis, palabras prohibidas
 *   - horarios: solo los ofrecidos por la agenda real (en la zona del negocio, o en la del país que se nombre)
 *   - precios: solo los configurados (en cifras o en letras)
 *   - enlaces: solo los permitidos
 *   - promesas de resultados, consejos médicos (fármacos, dosis, diagnósticos), presión, frases robóticas,
 *     seguimiento genérico
 *   - cifras de autoridad (años, clientes, “cientos de clientes”, kilos que perdió alguien, % de éxito, descuentos)
 *     y testimonios que no estén en el perfil del entrenador; con lo que ha dicho el lead (`leadText`), también
 *     cualquier cifra de kilos o % que no salga de sus datos ni de sus mensajes
 * Son patrones: cubren las formas habituales, no todas. Lo demás lo revisa la capa 2.
 * Capa 2 (opcional, IA rápida): ¿responde a lo último que dijo? ¿suena humano? ¿inventa algo?
 *
 * Si falla, el motor regenera la respuesta con estos motivos como feedback.
 */
import { DateTime } from 'luxon';
import { z } from 'zod';
import { questionCount, type AiTone } from '../../lib/domain.js';
import { countEmojis, fold, normalize } from '../../lib/text.js';
import { humanSlotLabel, placeZones, zonePlace } from '../../lib/time.js';
import { maxCharsFor, maxEmojisFor } from '../prompts/tone.js';
import type { LLMProvider } from '../providers/types.js';

export interface ValidationContext {
  tone: AiTone;
  wordsToAvoid: string[];
  timezone: string;
  allowedTimes: Date[];
  allowedPricesCents: number[];
  /** Monedas (ISO 4217) de los precios configurados. Si se indica, un importe en otra moneda es inventado. */
  currencies?: string[];
  allowedUrls: string[];
  /** Texto con los datos de autoridad reales (para permitir cifras que sí existen). */
  factsText: string;
  /**
   * Lo que ha contado el lead (sus mensajes, su cualificación, su memoria). KAI puede repetir sus cifras sin que
   * cuenten como inventadas: “esos 10 kilos”, “tu amigo que perdió 15 kilos”. Si se pasa, también se comprueba
   * cualquier cifra de kilos o de % (sin ello no se puede saber si la dijo el lead).
   */
  leadText?: string;
  isFollowUp?: boolean;
  /** Nombre del asistente (para no confundir su presentación con frases robóticas). */
  assistantName?: string;
  /** Mensajes que puede contener 2 preguntas (p. ej. confirmación + pregunta de cortesía): por defecto 1. */
  maxQuestions?: number;
  /** Últimos mensajes de KAI en la conversación (para no repetirse). */
  previousMessages?: string[];
  /** Momento de referencia para “hoy”, “mañana” y “pasado mañana”. Sin él, esas fechas relativas no se comprueban. */
  now?: Date;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
  /** Solo el juez con IA: no respondió (error de la API o formato no válido), así que el borrador NO se ha revisado. */
  unavailable?: boolean;
}

const RX_MARKDOWN = /\*\*|__|^#{1,6}\s|^\s*[-*•]\s+\S|^\s*\d+[.)]\s+\S/m;
const RX_ROBOTIC =
  /como (un )?(modelo de lenguaje|asistente virtual de ia)|no tengo (sentimientos|cuerpo)|estoy aqui para ayudarte|no dudes en (contactar|preguntar|escribir)|en que (mas )?puedo ayudarte hoy|espero que este mensaje te encuentre bien|como inteligencia artificial,? no puedo|¡?saludos cordiales/;
/** Verbos de resultado físico (para promesas: “vas a perder la barriga seguro”). */
const RESULT_VERBS = 'perder|bajar|adelgazar|quitarte|eliminar|conseguir|lograr|notar|ver resultados|reducir|transformar';
const RX_PROMISE = new RegExp(
  [
    String.raw`garantiz|te aseguro que (vas a|vas|lo vas)|100\s?%\s?(seguro|garantizado)|resultados? (asegurados?|garantizados?)`,
    String.raw`(perderas|bajaras|vas a perder|vas a bajar|conseguiras perder)\s+(\d+|unos|varios)\s*(kg|kilos)|seguro que (lo )?(consigues|vas a conseguir)|en \d+ (dias|semanas) (veras|tendras|perderas)`,
    // “vas a perder la barriga seguro”, “bajarás de talla sí o sí”, “sin duda vas a conseguirlo”.
    String.raw`\b(?:vas|va|van) a (?:${RESULT_VERBS})\b[^.!?\n]{0,50}\b(?:seguro|sin duda|si o si|sin falta)\b`,
    String.raw`\b(?:perderas|bajaras|adelgazaras|conseguiras|lograras|notaras|eliminaras|reduciras|te quitaras)\b[^.!?\n]{0,50}\b(?:seguro|sin duda|si o si)\b`,
    String.raw`\b(?:seguro que|sin duda|si o si)[, ]+(?:lo )?(?:vas|va) a (?:${RESULT_VERBS})\b`,
  ].join('|'),
);
/**
 * “Te prometo que lo vas a conseguir”: prometer en una frase que habla de resultados. “No te prometo resultados
 * mágicos” o “Te lo prometo: no te voy a llenar de mensajes” no prometen nada sobre el cuerpo del lead.
 */
const RX_PROMISE_WORD = /(?<!\bno )\b(?:te|le|os) (?:lo )?prometo\b/;
const RX_PROMISE_TOPIC = new RegExp(
  String.raw`\b(?:${RESULT_VERBS}|conseguir\w*|consigu\w*|lograr\w*|logr\w*|resultados?|kilos?|kg|tallas?|barriga|grasa|peso|cuerpo|en forma|cambios?|cambiar\w*|funciona\w*)\b`,
);
function promisesResults(n: string): boolean {
  return n.split(/[.!?\n]+/).some((sentence) => RX_PROMISE_WORD.test(sentence) && RX_PROMISE_TOPIC.test(sentence));
}
/** Fármacos y suplementos que KAI nunca debe recomendar (ni decir que se dejen). */
const DRUGS =
  'ibuprofeno|paracetamol|naproxeno|aspirina|dexketoprofeno|diclofenaco|enantyum|nolotil|metamizol|voltaren|antiinflamatorios?|analgesicos?|relajantes? musculares?|corticoides?|metformina|ozempic|semaglutida|wegovy|mounjaro|tirzepatida|saxenda|liraglutida|orlistat|levotiroxina|eutirox|omeprazol|antidepresivos?|ansioliticos?|diazepam|lorazepam|melatonina|insulina|estatinas?|diureticos?|laxantes?|quemagrasas|termogenicos?|testosterona|esteroides?|anabolizantes?|clembuterol';
/** Problemas de salud que KAI no puede diagnosticar (“suena a resistencia a la insulina”). */
const CONDITIONS =
  'resistencia a la insulina|prediabetes|diabetes|hipotiroidismo|hipertiroidismo|problemas? de tiroides|tendinitis|tendinopatia|hernia(?: discal)?|ciatica|lumbalgia|fascitis|bursitis|condromalacia|artrosis|artritis|fibromialgia|esguince|rotura|sindrome|sop|ovario poliquistico|hipertension|apnea|celiaquia|intolerancia|anemia|higado graso|colon irritable|reflujo|gastritis|depresion|ansiedad|trastorno|lesion|contractura|sobrecarga';
const RX_MEDICAL = new RegExp(
  [
    String.raw`(deja|dejar|suspende|suspender|ajusta|ajustar|reduce|reducir|aumenta|aumentar|cambia|cambiar) (la |tu |de )?(medicacion|insulina|pastillas|dosis|tratamiento)|te diagnostic`,
    String.raw`(tienes|sufres|padeces) (diabetes|hipotiroidismo|una hernia|una lesion|resistencia a la insulina|sop)|eso es (una|un) (tendinitis|hernia|lesion|sindrome)`,
    // Recomendar (o retirar) un fármaco: “que tomes ibuprofeno”, “prueba con melatonina”. “Si toma…” describe, no recomienda.
    String.raw`(?<!\b(?:si|ya|como|cuando|mientras|porque|aunque) )\b(?:toma|tomes|tome|tomar|tomate|tomese|tomarte|tomarse|prueba con|pruebe con|usa|uses|use|usar|ponte|pongase|recomiendo|aconsejo|recomendaria|aconsejaria|te iria bien|le iria bien)\b[^.!?\n]{0,30}\b(?:${DRUGS})\b`,
    // Dosis.
    String.raw`\b\d+(?:[.,]\d+)?\s?(?:mg|miligramos|mcg|microgramos)\b`,
    // Diagnóstico a ojo: “suena a resistencia a la insulina”, “parece una tendinitis”, “eso es ansiedad”.
    String.raw`\b(?:me suena a|suena a|parece(?: ser)?|puede ser|podria ser|seguramente (?:es|sea|tengas)|probablemente (?:es|sea|tengas)|tiene pinta de|apunta a|eso es)\s+(?:una |un |la |el )?(?:${CONDITIONS})\b`,
  ].join('|'),
);
const RX_PRESSURE = new RegExp(
  [
    String.raw`ultima oportunidad|ultimas plazas|solo (por )?hoy|plazas (limitadas|contadas)|si no (te )?decides (ahora|hoy)|no lo pienses mas|oferta (exclusiva|limitada|solo para ti)|ahora o nunca|se acaba (hoy|manana)`,
    // Escasez: “solo me quedan dos plazas”, “queda una plaza”.
    String.raw`\bquedan? (?:solo |solamente |apenas |muy |ya )?(?:pocas|\d+|una|dos|tres|cuatro|cinco|un par de) plazas?\b`,
    // Caducidad y subidas de precio: “esta oferta caduca esta noche”, “el precio sube mañana”.
    String.raw`\b(?:oferta|precio|descuento|promocion|plaza) (?:caduca|expira|vence|se acaba)\b|\b(?:caduca|expira|vence) (?:hoy|esta noche|manana|en \d+ horas)\b|\bprecio (?:sube|subira|va a subir) (?:manana|pronto|la semana que viene)\b`,
    // Prisa y miedo: “decide hoy”, “lo vas a lamentar”, “antes de que sea tarde”.
    String.raw`\bdecide(?:te|lo)? (?:hoy|ya|ahora)\b|\btienes que decidir(?:te|lo)? (?:hoy|ya|ahora)\b|\blo vas a lamentar|\blo lamentaras|(?<!no )\bte vas a arrepentir|(?<!no )\bte arrepentiras|\bantes de que sea (?:demasiado )?tarde|\bno dejes pasar (?:esta|la) oportunidad`,
  ].join('|'),
);
const RX_GENERIC_FOLLOWUP = /solo (hago|te hago|queria hacer|para hacer) (un )?seguimiento|solo queria saber si (has visto|viste|leiste)|te escribo para hacer seguimiento|hago seguimiento/;
const RX_URL = /https?:\/\/[^\s)]+/gi;

type Span = { index: number; end: number };
const overlapsSpan = (m: Span, spans: Span[]) => spans.some((s) => m.index < s.end && s.index < m.end);

// ───────────── Cifras (en dígitos o en letras) ─────────────

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
  mil: 1000,
};
const NUMBER_WORD = String.raw`(?:${Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|')})\b`;
/** Cifra en letras: “quince”, “doscientos”, “ciento cincuenta y siete”, “dos mil” (texto en minúsculas y sin tildes). */
const NUM_WORDS = String.raw`\b${NUMBER_WORD}(?:\s+(?:y\s+)?${NUMBER_WORD})*`;
/** Cifra en dígitos (“1.000”, “+500”, “2 mil”) o en letras. */
const NUM = String.raw`(?:(?<![\d.,])\+?\s?(?:\d{1,3}(?:\.\d{3})+(?!\d)|\d+)(?:\s+mil\b)?|${NUM_WORDS})`;

function wordsToNumber(phrase: string): number {
  let total = 0;
  let current = 0;
  for (const w of phrase.trim().split(/\s+/)) {
    if (w === 'y') continue;
    if (w === 'mil') {
      total += (current || 1) * 1000;
      current = 0;
    } else current += NUMBER_WORDS[w] ?? 0;
  }
  return total + current;
}

/** Valor de una cifra en dígitos o en letras (“+1.000” → 1000, “2 mil” → 2000, “quince” → 15). */
function numberValue(raw: string): number {
  const s = raw.replace(/^\+\s?/, '').trim();
  if (!/\d/.test(s)) return wordsToNumber(s);
  const [digits, mil] = s.split(/\s+/);
  return Number(digits.replace(/\./g, '')) * (mil === 'mil' ? 1000 : 1);
}

/** Números citados en un texto, en dígitos o en letras (“1.000” → 1000, “+500” → 500, “quinientos” → 500). */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d{1,3}(?:\.\d{3})+(?!\d)|\d+/g)) out.add(Number(m[0].replace(/\./g, '')));
  for (const m of text.matchAll(new RegExp(NUM, 'g'))) out.add(numberValue(m[0]));
  return out;
}

/** Aproximación delante de la cifra: “más de 500”, “casi quince”, “de media 8”. */
const ABOUT = String.raw`(?:(?:mas de|casi|unos|unas|hasta|cerca de|alrededor de|aproximadamente|nada menos que|de media|una media de|en promedio|un promedio de)\s+)*`;

/**
 * Tipo de cifra:
 *  - `authority`: datos del entrenador (clientes, años de experiencia, % de éxito, descuentos). Solo valen si están
 *    en sus datos: que el lead pregunte “¿tienes 500 clientes?” no los hace ciertos.
 *  - `result`: kilos, tallas o % de alguien. Valen si están en los datos del negocio o los ha dicho el lead
 *    (“esos 10 kilos”, “tu amigo perdió 15 kilos”), salvo que se atribuyan a clientes del entrenador.
 */
type ClaimKind = 'authority' | 'result';
const PEOPLE = 'clientes|clientas|alumnos|alumnas|personas|hombres|mujeres|transformaciones|casos de exito|historias de exito|atletas|deportistas';
/** Número de clientes o casos: “300 personas”, “más de doscientos clientes”. */
const RX_PEOPLE_COUNT = new RegExp(String.raw`(?<num>${NUM})\s+(?:${PEOPLE})\b`, 'g');
/** Cifras de autoridad o resultados de terceros (se comprueban siempre). */
const RX_CLAIMS: { rx: RegExp; kind: ClaimKind }[] = [
  { kind: 'authority', rx: RX_PEOPLE_COUNT },
  // Experiencia: “10 años de experiencia”, “quince años entrenando”, “desde hace 8 años ayudo…”.
  {
    kind: 'authority',
    rx: new RegExp(
      String.raw`(?<num>${NUM})\s+anos?\s+(?:que\s+)?(?:de (?:experiencia|trayectoria|carrera|profesion)|en (?:el sector|esto|este mundo|el mundo del fitness)|entrenando|ayudando|trabajando|dedicad[oa]s?|dedicandome|dedicandose|me dedico|nos dedicamos|se dedica|entreno|entrena|entrenamos|ayudo|ayuda|ayudamos|trabajo|trabaja|trabajamos|como (?:entrenador|entrenadora|coach|nutricionista|preparador|preparadora|profesional))\b`,
      'g',
    ),
  },
  // “Llevo 10 años…” (lo dice el entrenador o su equipo, no el lead).
  { kind: 'authority', rx: new RegExp(String.raw`\b(?:llevo|llevamos)\s+(?:ya\s+)?${ABOUT}(?<num>${NUM})\s+anos?\b`, 'g') },
  // Resultados de otros (testimonios): “perdió 12 kilos”, “han bajado de media 3 tallas”, “500 kilos perdidos”.
  {
    kind: 'result',
    rx: new RegExp(
      String.raw`\b(?:perdio|perdieron|perdi|perdimos|ha perdido|han perdido|he perdido|bajo|bajaron|ha bajado|han bajado|he bajado|se quito|se quitaron|me quite|se ha quitado|se han quitado|elimino|eliminaron|ha eliminado|han eliminado|redujo|redujeron|ha reducido|han reducido|(?:consiguio|consiguieron|logro|lograron) (?:perder|bajar|quitarse))\s+${ABOUT}(?<num>${NUM})\s*(?:kilos?|kg|kgs|centimetros|cm|tallas?|%|por ciento|puntos)`,
      'g',
    ),
  },
  { kind: 'result', rx: new RegExp(String.raw`(?<num>${NUM})\s*(?:kilos|kg) perdidos`, 'g') },
  // Estadísticas de éxito: “el 95% de mis clientes”, “una tasa de éxito del 90%”.
  {
    kind: 'authority',
    rx: new RegExp(String.raw`(?<num>${NUM})\s*(?:%|por ciento)\s+(?:de (?:exito|efectividad|eficacia|satisfaccion|acierto)|de (?:mis|nuestros|nuestras|sus|los|las) (?:${PEOPLE})|de la gente)`, 'g'),
  },
  { kind: 'authority', rx: new RegExp(String.raw`\b(?:exito|efectividad|eficacia|satisfaccion|acierto)\s+(?:es\s+)?(?:del?|de un)\s+(?<num>${NUM})\s*(?:%|por ciento)`, 'g') },
  // Descuentos (ofertas inventadas): “un 20% de descuento”, “descuento del 30%”.
  { kind: 'authority', rx: new RegExp(String.raw`(?<num>${NUM})\s*(?:%|por ciento)\s+(?:de )?(?:descuento|dto|rebaja)\b`, 'g') },
  { kind: 'authority', rx: new RegExp(String.raw`\b(?:descuento|rebaja)\s+(?:del?|de un)\s+(?<num>${NUM})\s*(?:%|por ciento)`, 'g') },
];
/**
 * Cualquier cifra de kilos o de % (“mucha gente pierde 2 o 3 kilos el primer mes”). Solo se comprueban si se sabe lo
 * que ha dicho el lead (`leadText`): sin eso, repetir su objetivo (“esos 10 kilos”) parecería inventado.
 * “100%” no cuenta (“100% online”).
 */
const RX_CLAIMS_ANY: { rx: RegExp; kind: ClaimKind; generic: true }[] = [
  { kind: 'result', generic: true, rx: new RegExp(String.raw`(?<num>${NUM})\s*(?:kilos?|kg|kgs)\b`, 'g') },
  { kind: 'result', generic: true, rx: new RegExp(String.raw`(?<num>${NUM})\s*(?:%|por ciento)`, 'g') },
];
/** Cifras vagas de autoridad (“cientos de clientes”): valen si los datos del negocio dicen esa palabra o una cifra de clientes así. */
const RX_VAGUE_CROWD = new RegExp(String.raw`\b(?<w>decenas|cientos|centenares|miles)\s+de\s+(?:${PEOPLE})\b`, 'g');
const VAGUE_MIN: Record<string, number> = { decenas: 20, cientos: 200, centenares: 200, miles: 2000 };

/**
 * La cifra habla del lead o de alguien suyo (“si llevas 10 años entrenando”, “tu amigo perdió 15 kilos”): no es un dato
 * del entrenador y no se puede dar por inventada.
 */
const RX_LEAD_SIDE =
  /\b(?:llevas|lleves|llevabas|llevais|lleveis|sois|seais|tienes|tengas|teneis|tengais|perdiste|perdisteis|bajaste|bajasteis|si (?:ya )?(?:lleva|llevan|tiene|tienen)|usted(?:es)? (?:lleva|llevan|tiene|tienen)|(?:lleva|llevan|tiene|tienen) usted(?:es)?)\b|\btus? (?:amig|herman|prim|pareja|mujer|marido|novi|padre|madre|compan|vecin|cunad|soci|jefe|hij|famil|conocid)\w*/;
/** Años que el lead cuenta de sí mismo y que KAI le puede repetir: “3 años entrenando”, “20 años trabajando” (no “de experiencia”). */
const RX_YEARS_DOING = /\banos?\s+(?:que\s+)?(?<verb>entren|trabaj|dedic)\w*/;
const RX_YEARS = new RegExp(String.raw`(?<num>${NUM})\s+anos?\b`, 'g');
/** Quien lleva esos años es el entrenador o su equipo (“Álex lleva…”, “tengo…”, “mis…”), no el lead. */
const RX_TRAINER_YEARS = /\b(?:lleva|llevo|llevamos|llevan|tengo|tiene|tenemos|tienen|cuento|cuenta|contamos|sumo|suma|sumamos|mi|mis|nuestr[oa]s?|su|sus)\b/;
/** Hasta dónde se mira hacia atrás para saber si la cifra es del lead (“tienes delante a Álex, que lleva 15 años…” no lo es). */
const LEAD_SIDE_REACH = 40;
/** La cifra se atribuye a clientes del entrenador (“mis alumnos han perdido…”, “una clienta mía…”): solo valen sus datos. */
const RX_TRAINER_SIDE =
  /\b(?:(?:mis|nuestr[oa]s|sus) (?:clientes|clientas|alumnos|alumnas|chicos|chicas)|(?:mi|nuestr[oa]) (?:cliente|clienta|alumno|alumna)|(?:cliente|clienta|alumno|alumna)s? (?:mio|mia|mios|mias|nuestr[oa]s?)|(?:uno|una|otro|otra) de (?:mis|nuestr[oa]s|sus))\b/;

/** La parte de la frase que va antes de una posición (para saber de quién se habla). */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 100), index);
  const cut = Math.max(...[...before.matchAll(/[.!?\n;:]/g)].map((m) => m.index! + 1), 0);
  return before.slice(cut);
}

/** Anécdota de un cliente concreto con su resultado: “una clienta mía perdió…”, “uno de mis alumnos consiguió…”. */
const RX_TESTIMONIAL =
  /\b(?:(?:un|una|otro|otra) (?:cliente|clienta|alumno|alumna) (?:mio|mia|nuestro|nuestra|que (?:tengo|tenemos|tuve|tuvimos)|con (?:el|la) que (?:trabajo|trabajamos|trabaje))|(?:uno|una|otro|otra) de (?:mis|nuestros|nuestras|sus) (?:clientes|clientas|alumnos|alumnas))\b[^.!?\n]{0,80}\b(?:perdio|bajo|consiguio|logro|se quito|paso de|redujo|elimino|cambio|transformo|dejo de|recupero|ha perdido|ha bajado|ha conseguido|ha logrado|ha pasado de)\b/;
/** Los datos del negocio incluyen casos reales (“Juan perdió 15 kg”): entonces KAI puede contarlos. */
const RX_REAL_CASES = /\b(?:perdio|perdieron|bajo|bajaron|consiguio|consiguieron|logro|lograron|se quito|paso de|redujo|elimino|transformo|ha perdido|han perdido|ha bajado|han bajado|testimonio|caso de exito|casos de exito)\b/;

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

// ───────────── Importes ─────────────

const AMOUNT = String.raw`\d{1,3}(?:[.,\s  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
/** Símbolos, códigos ISO y nombres de moneda (texto ya en minúsculas y sin tildes). */
const CURRENCY = String.raw`us\$|ca\$|mx\$|r\$|s\/|€|\$|£|(?:eur(?:os?)?|usd|mxn|ars|cop|clp|gbp|pen|chf|brl|cad|aud|uyu|dop|dolar(?:es)?|pesos?|soles?|francos?|reales)(?![a-z])`;
/** Importe con moneda delante o detrás: “197 €”, “€197”, “150 dólares”, “$150”, “1.500 MXN”. */
const RX_PRICE = new RegExp(String.raw`(?<![\w.,])(?<a1>${AMOUNT})\s?(?<c1>${CURRENCY})|(?<![a-z])(?<c2>${CURRENCY})\s?(?<a2>${AMOUNT})(?!\d)`, 'g');
/** Importe sin moneda pero presentado como precio: “cuesta 150 al mes”, “el precio es de 99”. */
const RX_PRICE_VERB = new RegExp(
  String.raw`\b(?:cuesta|cuestan|vale|valen|precio(?: es| de| es de)?|tarifa(?: es| de)?|cuota(?: es| de)?|inversion(?: es| de)?|pagas|pagarias)\s+(?:de\s+|unos\s+|solo\s+|solamente\s+)?(?<a3>${AMOUNT})(?![\d.,]*\s?(?:${CURRENCY}))(?!\s*(?:%|kilos?|kg|semanas?|mes(?:es)?\b|dias?|minutos?|horas?|sesiones?|clases?|personas?|anos?|veces))`,
  'g',
);

/**
 * Importe en letras con la moneda: “ciento cincuenta euros”, “dos mil pesos”, “15 mil pesos” (en plural: “un peso
 * saludable” o “no te cuesta ni un euro” no son un importe).
 */
const RX_PRICE_WORDS = new RegExp(String.raw`(?<w>(?<![\d.,])\d{1,3}\s+mil\b|${NUM_WORDS})\s+(?<c>euros|dolares|pesos|soles|francos)\b`, 'g');

const DOLLAR_LIKE = ['USD', 'MXN', 'ARS', 'COP', 'CLP', 'CAD', 'AUD', 'UYU', 'DOP', 'NZD'];

/** Monedas que puede representar un símbolo o nombre (“$” vale para dólares y pesos). */
function currenciesFor(marker: string): string[] {
  const m = marker.toLowerCase();
  if (m === '€' || m.startsWith('eur')) return ['EUR'];
  if (m === 'us$' || m === 'usd') return ['USD'];
  if (m.startsWith('dolar')) return ['USD', 'CAD', 'AUD', 'NZD'];
  if (m === 'ca$') return ['CAD'];
  if (m === 'mx$') return ['MXN'];
  if (m === 'r$' || m === 'reales') return ['BRL'];
  if (m === 's/' || m.startsWith('sol')) return ['PEN'];
  if (m === '£') return ['GBP'];
  if (m.startsWith('franco')) return ['CHF'];
  if (m.startsWith('peso')) return ['MXN', 'ARS', 'COP', 'CLP', 'UYU', 'DOP'];
  if (m === '$') return DOLLAR_LIKE;
  return [m.toUpperCase()];
}

/** “1.500”, “1,500.50”, “97,50”, “1 500” → céntimos. Un separador seguido de 3 cifras es de miles. */
function parsePriceToCents(raw: string): number | null {
  const s = raw.replace(/[\s  ]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let plain: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    plain = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const parts = s.split(lastDot >= 0 ? '.' : ',');
    plain = parts.length > 2 || parts[parts.length - 1].length === 3 ? parts.join('') : parts.join('.');
  } else {
    plain = s;
  }
  const n = Number(plain);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

interface PriceMention {
  index: number;
  end: number;
  text: string;
  cents: number | null;
  /** Monedas posibles según el símbolo; null si el importe no lleva moneda. */
  currencies: string[] | null;
}

function findPrices(f: string, original: string): PriceMention[] {
  const out: PriceMention[] = [];
  for (const m of f.matchAll(RX_PRICE)) {
    const g = m.groups!;
    out.push({
      index: m.index!,
      end: m.index! + m[0].length,
      text: original.slice(m.index!, m.index! + m[0].length),
      cents: parsePriceToCents(g.a1 ?? g.a2 ?? ''),
      currencies: currenciesFor(g.c1 ?? g.c2 ?? ''),
    });
  }
  for (const m of f.matchAll(RX_PRICE_WORDS)) {
    const index = m.index!;
    const end = index + m[0].length;
    if (out.some((p) => index < p.end && p.index < end)) continue;
    out.push({ index, end, text: original.slice(index, end), cents: numberValue(m.groups!.w) * 100, currencies: currenciesFor(m.groups!.c) });
  }
  for (const m of f.matchAll(RX_PRICE_VERB)) {
    const amount = m.groups!.a3;
    const index = m.index! + m[0].length - amount.length;
    const end = m.index! + m[0].length;
    if (out.some((p) => index < p.end && p.index < end)) continue;
    out.push({ index, end, text: original.slice(index, end), cents: parsePriceToCents(amount), currencies: null });
  }
  return out;
}

// ───────────── Horarios ─────────────

const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };
const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const WORD_HOURS: Record<string, number> = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };
const WEEKDAY_RX = Object.keys(WEEKDAYS).join('|');
const MONTH_RX = Object.keys(MONTHS).join('|');

/**
 * Posibles horas (texto en minúsculas y sin tildes, con las mismas posiciones que el original):
 *  - “18:00”, “18.30”;
 *  - “a las 18”, “sobre las 17”, “hacia las 6”, “las 18”, “a la 1”, “a las seis”;
 *  - “17h”, “17 h”, “17hs”.
 */
const RX_TIME_CANDIDATE = new RegExp(
  [
    String.raw`(?<![\d:.,])(?<hh>[01]?\d|2[0-3])[:.](?<mm>[0-5]\d)(?!\d)`,
    String.raw`\b(?:(?<prep>a|sobre|hacia|hasta|desde|entre|tipo|para) )?(?<art>las|la) (?<num>[01]?\d|2[0-3]|${Object.keys(WORD_HOURS).join('|')})\b(?![:.]\d)`,
    String.raw`(?<![\d:.,])(?<hh2>[01]?\d|2[0-3]) ?hs?\b`,
  ].join('|'),
  'g',
);
/** Lo que sigue a “las N” cuando N NO es una hora (“las 12 semanas”, “a las 3 sesiones”, “las 2 opciones”). */
const RX_NOT_TIME_AFTER =
  /^\s*(?:semanas?|dias?|mes(?:es)?\b|anos?|veces|sesiones?|clases?|kilos?|kg\b|personas?|clientes?|alumnos?|minutos?|euros?|eur\b|€|%|primer[ao]s?|ultim[ao]s?|opciones?|preguntas?|comidas?|series?|repeticiones?|rutinas?|plazas?|pasos?|cosas?|partes?|fases?|horas? (?:a la semana|semanales|al dia|diarias|de|despues|antes|libres|seguidas|que))/;
/** Lo que puede seguir a “las N” (sin “a/sobre/hacia…” delante) para que se lea como una hora. */
const RX_TIME_AFTER = new RegExp(
  String.raw`^\s*(?:$|[,.;:!?)]|hs?\b|y (?:media|cuarto)\b|menos cuarto\b|en punto\b|(?:de|por) la (?:manana|tarde|noche|madrugada)\b|[ouy] (?:a )?las?\b|del? (?:${WEEKDAY_RX}|dia)\b|(?:el|este|esta|hoy|manana|pasado|te|me|os|nos|le|les|si|entonces|vale|porfa|mejor|seria|estaria|perfecto|genial|tengo|hay|puedo|podemos|quedamos)\b)`,
);
/** Duraciones (“en 2h”, “cada 3 h”, “durante 1h”): no son horas del día. */
const RX_DURATION_BEFORE = /(?:\ben|cada|durante|unas?|unos|hace|dentro de|tras)\s*$/;
const RX_TIME_SUFFIX = /^(\s*(?:h|hs|horas)\b)?(\s*(y media|y cuarto|menos cuarto))?(\s*en punto)?(\s*(?:de|por) la (manana|tarde|noche|madrugada))?/;

interface TimeMention {
  index: number;
  end: number;
  text: string;
  hour: number;
  minute: number;
  /** La hora se puede leer en formato 24 h sin ambigüedad (“18:00”, “6 de la tarde”). */
  exact: boolean;
}

function findTimes(f: string, original: string): TimeMention[] {
  const out: TimeMention[] = [];
  for (const m of f.matchAll(RX_TIME_CANDIDATE)) {
    const g = m.groups!;
    const index = m.index!;
    let end = index + m[0].length;
    let hour: number;
    let minute = 0;
    if (g.hh !== undefined) {
      hour = Number(g.hh);
      minute = Number(g.mm);
    } else if (g.num !== undefined) {
      const isWord = g.num in WORD_HOURS;
      hour = isWord ? WORD_HOURS[g.num] : Number(g.num);
      const rest = f.slice(end);
      if (g.art === 'la' && hour !== 1) continue; // “la 18” no es una hora; “a la 1”, “a la una” sí
      if (g.art === 'las' && g.num === 'una') continue;
      if (RX_NOT_TIME_AFTER.test(rest)) continue;
      // Sin preposición (o con la hora en letra), solo cuenta si lo que sigue tiene forma de hora.
      if ((!g.prep || isWord) && !RX_TIME_AFTER.test(rest) && !(g.prep && /^\s*horas?\b/.test(rest))) continue;
    } else {
      if (RX_DURATION_BEFORE.test(f.slice(Math.max(0, index - 14), index))) continue;
      hour = Number(g.hh2);
    }
    if (out.some((t) => index < t.end && t.index < end)) continue;
    const suffix = RX_TIME_SUFFIX.exec(f.slice(end))!;
    end += suffix[0].length;
    const fraction = suffix[3];
    if (fraction === 'y media') minute = 30;
    else if (fraction === 'y cuarto') minute = 15;
    else if (fraction === 'menos cuarto') {
      minute = 45;
      hour = (hour + 23) % 24;
    }
    let exact = hour >= 13 || hour === 0;
    const partOfDay = suffix[6];
    if (partOfDay) {
      if ((partOfDay === 'tarde' || partOfDay === 'noche') && hour < 12) hour += 12;
      exact = true;
    }
    out.push({ index, end, text: original.slice(index, end).trim(), hour, minute, exact });
  }
  return out;
}

/** Día al que se refiere el texto: fecha concreta (hoy/mañana), día de la semana y/o día del mes. */
interface DayRef {
  index: number;
  end: number;
  relativeDays?: number;
  weekday?: number;
  dayOfMonth?: number;
  month?: number;
}

const RX_DAY_REF = new RegExp(
  String.raw`\b(?:(?<pasado>pasado manana)|(?<hoy>hoy|esta (?:tarde|noche|manana))|(?<!(?:la|esta|pasado) )(?<manana>manana)|(?:el )?(?<wd>${WEEKDAY_RX})(?: (?:dia )?(?<wdnum>\d{1,2}))?(?: de (?<wdmon>${MONTH_RX}))?|el (?:dia )?(?<dnum>\d{1,2})(?! ?(?:[:.]\d|hs?\b|%|€|euros?))(?: de (?<dmon>${MONTH_RX}))?|(?<dnum2>\d{1,2}) de (?<dmon2>${MONTH_RX}))\b`,
  'g',
);

function findDayRefs(f: string): DayRef[] {
  const refs: DayRef[] = [];
  for (const m of f.matchAll(RX_DAY_REF)) {
    const g = m.groups!;
    const ref: DayRef = { index: m.index!, end: m.index! + m[0].length };
    if (g.pasado) ref.relativeDays = 2;
    else if (g.hoy) ref.relativeDays = 0;
    else if (g.manana) ref.relativeDays = 1;
    else if (g.wd) {
      ref.weekday = WEEKDAYS[g.wd];
      if (g.wdnum) ref.dayOfMonth = Number(g.wdnum);
      if (g.wdmon) ref.month = MONTHS[g.wdmon];
    } else {
      ref.dayOfMonth = Number(g.dnum ?? g.dnum2);
      const mon = g.dmon ?? g.dmon2;
      if (mon) ref.month = MONTHS[mon];
    }
    if (ref.dayOfMonth !== undefined && (ref.dayOfMonth < 1 || ref.dayOfMonth > 31)) continue;
    refs.push(ref);
  }
  return refs;
}

/**
 * Zona a la que se atribuye una hora de forma explícita: “a las 18:00 (hora de España)”, “en México, a las 10:00”,
 * “las 10:00 en México”. Así KAI puede dar la hora de un lead de otro país (y se comprueba en su zona). null si no se dice.
 */
function zoneFor(time: TimeMention, f: string, places: Map<string, string>, placeRx: string): string | null {
  const after = new RegExp(String.raw`^[\s,]*\(?\s*(?:(?:hora|horario) (?:de|del|en) |en |de )(?:la |el )?(${placeRx})\b`).exec(f.slice(time.end));
  if (after) return places.get(after[1]) ?? null;
  const before = new RegExp(String.raw`\ben (${placeRx})\b[^.!?¿\n;()]{0,30}$`).exec(f.slice(Math.max(0, time.index - 60), time.index));
  return before ? (places.get(before[1]) ?? null) : null;
}

/** Día que acompaña a una hora: el que va justo después (“a las 18:00 del jueves”) o el más cercano antes, en la misma frase. */
function dayFor(time: TimeMention, refs: DayRef[], f: string): DayRef | null {
  const after = refs.find((r) => r.index >= time.end && /^\s*,?\s*(?:del?|el|este|esta|para el|para)?\s*$/.test(f.slice(time.end, r.index)));
  if (after) return after;
  const sentenceStart = Math.max(...[...f.slice(0, time.index).matchAll(/[.!?\n](?=\s|$)/g)].map((b) => b.index! + 1), 0);
  const before = refs.filter((r) => r.end <= time.index && r.index >= sentenceStart);
  return before.length ? before[before.length - 1] : null;
}

function sameDay(a: DateTime, ref: DayRef, today: DateTime | null): boolean | null {
  if (ref.relativeDays !== undefined) {
    if (!today) return null; // sin “ahora” de referencia no se puede comprobar
    if (a.toISODate() !== today.plus({ days: ref.relativeDays }).toISODate()) return false;
  }
  if (ref.weekday !== undefined && a.weekday !== ref.weekday) return false;
  if (ref.dayOfMonth !== undefined && a.day !== ref.dayOfMonth) return false;
  if (ref.month !== undefined && a.month !== ref.month) return false;
  return true;
}

export function validateReply(text: string, ctx: ValidationContext): ValidationResult {
  const issues: string[] = [];
  const trimmed = text.trim();
  const n = normalize(trimmed);

  if (!trimmed) return { ok: false, issues: ['El mensaje está vacío.'] };
  const maxChars = maxCharsFor(ctx.tone);
  if (trimmed.length > maxChars) issues.push(`Es demasiado largo (${trimmed.length} caracteres; máximo ${maxChars}). Acórtalo.`);

  const questions = questionCount(trimmed);
  if (questions > (ctx.maxQuestions ?? 1)) issues.push(`Hace ${questions} preguntas. Haz solo UNA pregunta principal.`);

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

  if (RX_PROMISE.test(n) || promisesResults(n)) issues.push('Promete o garantiza resultados. KAI no puede prometer resultados físicos.');
  if (RX_MEDICAL.test(n)) issues.push('Da un consejo o diagnóstico médico. Deriva a un profesional sanitario.');
  if (RX_PRESSURE.test(n)) issues.push('Presiona con urgencia o escasez. Elimina cualquier presión.');
  if (ctx.isFollowUp && RX_GENERIC_FOLLOWUP.test(n)) issues.push('Es un seguimiento genérico. Usa algo concreto de la conversación (su objetivo, lo que contó).');

  // Importes y enlaces: las cifras que contienen no son horas (“19.50 €”, o un enlace de Calendly con “T18:00:00Z”).
  // Se analizan sobre el texto en minúsculas y sin tildes, que conserva las mismas posiciones que el original.
  const f = fold(trimmed);
  const urls = [...trimmed.matchAll(RX_URL)];
  const urlSpans = urls.map((u) => ({ index: u.index!, end: u.index! + u[0].length }));
  const prices = findPrices(f, trimmed).filter((p) => !overlapsSpan(p, urlSpans));

  // Horarios: solo los que salen de la agenda real, y el día también debe coincidir (“el sábado a las 18:00”).
  // Se leen en la zona del negocio, salvo que el mensaje diga de qué país es la hora (lead de otro país).
  const places = placeZones([ctx.timezone]);
  const placeRx = [...places.keys()]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const dayRefs = findDayRefs(f);
  for (const t of findTimes(f, trimmed)) {
    if (overlapsSpan(t, prices) || overlapsSpan(t, urlSpans)) continue;
    const zone = zoneFor(t, f, places, placeRx) ?? ctx.timezone;
    const inZone = zone === ctx.timezone ? '' : ` (hora de ${zonePlace(zone)})`;
    const allowed = ctx.allowedTimes.map((d) => DateTime.fromJSDate(d).setZone(zone));
    const today = ctx.now ? DateTime.fromJSDate(ctx.now).setZone(zone).startOf('day') : null;
    let sameTime = allowed.filter((a) => a.minute === t.minute && (t.exact ? a.hour === t.hour : a.hour === t.hour || a.hour % 12 === t.hour % 12));
    // Un horario que ya ha pasado no se puede ofrecer (aunque se ofreciera ayer).
    if (ctx.now && sameTime.length && sameTime.every((a) => a.toMillis() <= ctx.now!.getTime())) {
      issues.push(`Menciona el horario “${t.text}”${inZone}, que ya ha pasado. Consulta get_available_slots y ofrece horarios futuros.`);
      break;
    }
    if (ctx.now) sameTime = sameTime.filter((a) => a.toMillis() > ctx.now!.getTime());
    if (sameTime.length === 0) {
      issues.push(`Menciona el horario “${t.text}”${inZone}, que no ha salido de la agenda real. Usa get_available_slots y sus etiquetas exactas.`);
      break;
    }
    const day = dayFor(t, dayRefs, f);
    if (day && !sameTime.some((a) => sameDay(a, day, today) !== false)) {
      const said = trimmed.slice(Math.min(day.index, t.index), Math.max(day.end, t.end)).trim();
      const real = sameTime.map((a) => `“${humanSlotLabel(a.toJSDate(), ctx.timezone, ctx.now ?? new Date())}”`).join(' o ');
      issues.push(`Menciona “${said}”, pero ese día no hay ningún horario ofrecido a esa hora (el horario real es ${real}). Usa las etiquetas exactas de get_available_slots.`);
      break;
    }
  }

  // Precios: solo los configurados y en su moneda.
  for (const p of prices) {
    if (p.currencies && ctx.currencies?.length && !p.currencies.some((c) => ctx.currencies!.includes(c))) {
      issues.push(`Menciona el importe “${p.text}” en una moneda distinta a la configurada (${ctx.currencies.join(', ')}). Usa solo los precios reales, en su moneda.`);
      break;
    }
    if (p.cents === null) continue;
    if (!ctx.allowedPricesCents.some((c) => Math.abs(c - p.cents!) <= 1)) {
      issues.push(`Menciona el importe “${p.text}”, que no coincide con ningún precio configurado. Usa solo precios reales.`);
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

  // Cifras de autoridad / testimonios que no estén en los datos reales del entrenador ni los haya dicho el lead.
  const factsText = normalize(ctx.factsText);
  const facts = numbersIn(factsText);
  const leadN = ctx.leadText === undefined ? '' : normalize(ctx.leadText);
  const withLead = ctx.leadText === undefined ? facts : new Set([...facts, ...numbersIn(leadN)]);
  // “Después de 3 años entrenando por tu cuenta…”: repite los años que contó el lead (mismo número y mismo verbo).
  const repeatsLeadYears = (value: number, claimText: string) => {
    const verb = RX_YEARS_DOING.exec(claimText)?.groups?.verb;
    return Boolean(verb) && [...leadN.matchAll(RX_YEARS)].some((y) => numberValue(y.groups!.num) === value) && new RegExp(String.raw`\b${verb}`).test(leadN);
  };
  const rules: { rx: RegExp; kind: ClaimKind; generic?: true }[] = ctx.leadText === undefined ? RX_CLAIMS : [...RX_CLAIMS, ...RX_CLAIMS_ANY];
  const claim = rules
    .flatMap(({ rx, kind, generic }) => [...n.matchAll(rx)].map((m) => ({ m, kind, generic })))
    .find(({ m, kind, generic }) => {
      const value = numberValue(m.groups!.num);
      const clause = clauseBefore(n, m.index!);
      if (RX_LEAD_SIDE.test(clause.slice(-LEAD_SIDE_REACH))) return false; // habla del lead o de alguien suyo
      if (generic && value === 100 && /%|por ciento/.test(m[0])) return false; // “100% online” (pero no “el 100% de mis clientes”)
      if (repeatsLeadYears(value, m[0]) && !RX_TRAINER_YEARS.test(clause.slice(-LEAD_SIDE_REACH))) return false;
      const known = kind === 'authority' || RX_TRAINER_SIDE.test(clause) ? facts : withLead;
      return !known.has(value);
    });
  const crowd = [...factsText.matchAll(RX_PEOPLE_COUNT)].map((m) => numberValue(m.groups!.num));
  const vague = [...n.matchAll(RX_VAGUE_CROWD)].find(
    (m) => !RX_LEAD_SIDE.test(clauseBefore(n, m.index!).slice(-LEAD_SIDE_REACH)) && !factsText.includes(m.groups!.w) && !crowd.some((v) => v >= VAGUE_MIN[m.groups!.w]),
  );
  if (claim) issues.push(`Afirma “${claim.m[0].trim()}”, un dato que no aparece en el perfil del entrenador. No inventes cifras ni testimonios.`);
  else if (vague) issues.push(`Afirma “${vague[0]}”, un dato que no aparece en el perfil del entrenador. No inventes cifras ni testimonios.`);
  else if (RX_TESTIMONIAL.test(n) && !RX_REAL_CASES.test(factsText))
    issues.push('Cuenta el caso de un cliente que no aparece en el perfil del entrenador. No inventes testimonios ni resultados de clientes.');

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
    // Si el juez falla, no bloquea por sí mismo (la capa determinista ya ha pasado), pero lo dice: quien lo llama
    // decide si eso basta (el setter no envía un borrador sin revisar; ver judgeWithRetry).
    return { ok: true, issues: [], unavailable: true };
  }
}
