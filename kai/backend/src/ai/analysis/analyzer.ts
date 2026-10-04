/**
 * Análisis de cada mensaje del lead: extrae cualificación, señales, memoria y alertas
 * (petición de humano, tema médico, enfado, baja, precio, objeciones, elección de horario…).
 *
 * Dos implementaciones con el mismo contrato:
 *  - LLM (modelo rápido con salida estructurada): comprensión real del lenguaje.
 *  - Heurística (reglas en español): modo simulación y red de seguridad.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { ConversationState, LeadQualification, LeadSignals, OfferedSlot } from '../../lib/domain.js';
import type { SetterState } from '../setter/strategy.js';
import { fold, normalize } from '../../lib/text.js';
import type { LLMProvider } from '../providers/types.js';
import type { BusinessContext, LeadRow, MessageRow } from '../context/context.js';
import { buildAnalysisSystemPrompt, formatTranscript } from '../prompts/analysis.prompt.js';

export interface LeadAnalysis {
  qualification: LeadQualification;
  signals: LeadSignals;
  memories: { kind: 'fact' | 'event' | 'preference' | 'constraint' | 'personal'; content: string; importance: number }[];
  flags: {
    humanRequest: boolean;
    asksIfBot: boolean;
    medical: boolean;
    angry: boolean;
    optOut: boolean;
    asksPrice: boolean;
    wantsCall: boolean;
    declinesCall: boolean;
    complexNegotiation: boolean;
    outOfScope: boolean;
    technicalIssue: boolean;
    wantsReschedule: boolean;
    wantsCancel: boolean;
    asksQuestion: boolean;
  };
  objectionKey: string | null;
  leadName: string | null;
  goalSummary: string | null;
  preferredDate: string | null;
  preferredPartOfDay: 'morning' | 'afternoon' | 'evening' | null;
  selectedSlotId: string | null;
  summary: string;
  engine: 'llm' | 'heuristic';
}

export interface AnalysisInput {
  biz: BusinessContext;
  lead: LeadRow;
  history: MessageRow[];
  pending: MessageRow[];
  state: ConversationState;
  now: Date;
}

const Level = z.enum(['high', 'medium', 'low']);

export const AnalysisSchema = z.object({
  qualification_updates: z.array(
    z.object({
      key: z.string().describe('Clave de la variable de cualificación'),
      value: z.string().describe('Lo que el lead ha dicho, resumido en una frase en español'),
      confidence: z.number().describe('Confianza entre 0 y 1'),
    }),
  ),
  signals: z.object({
    urgency: Level.nullable(),
    commitment: Level.nullable(),
    budget: z.enum(['yes', 'maybe', 'no']).nullable(),
    fit: z.enum(['yes', 'unknown', 'no']).nullable(),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'angry']).nullable(),
    intent: Level.nullable(),
  }),
  memories: z.array(
    z.object({
      kind: z.enum(['fact', 'event', 'preference', 'constraint', 'personal']),
      content: z.string(),
      importance: z.number().describe('1 (poco) a 3 (muy importante)'),
    }),
  ),
  flags: z.object({
    human_request: z.boolean(),
    asks_if_bot: z.boolean(),
    medical_issue: z.boolean(),
    angry: z.boolean(),
    opt_out: z.boolean(),
    asks_price: z.boolean(),
    wants_call: z.boolean(),
    declines_call: z.boolean(),
    complex_negotiation: z.boolean(),
    out_of_scope: z.boolean(),
    technical_issue: z.boolean(),
    wants_reschedule: z.boolean(),
    wants_cancel: z.boolean(),
    asks_question: z.boolean(),
  }),
  objection_key: z.string().nullable(),
  lead_name: z.string().nullable(),
  goal_summary: z.string().nullable(),
  preferred_date: z.string().nullable().describe('YYYY-MM-DD si el lead indica un día concreto'),
  preferred_part_of_day: z.enum(['morning', 'afternoon', 'evening']).nullable(),
  selected_slot_id: z.string().nullable(),
  summary: z.string(),
});

const LEVEL_KEYS = new Set(['urgency', 'commitment', 'budget', 'fit']);

export async function analyzeWithLLM(provider: LLMProvider, input: AnalysisInput): Promise<LeadAnalysis> {
  const result = await provider.structured({
    tier: 'fast',
    system: [{ text: buildAnalysisSystemPrompt(input), cache: false }],
    messages: [{ role: 'user', content: formatTranscript(input) }],
    schema: AnalysisSchema,
    maxTokens: 2000,
  });
  const nowIso = input.now.toISOString();
  const allowedKeys = new Set(input.biz.rules.map((r) => r.key));
  const qualification: LeadQualification = {};
  for (const u of result.qualification_updates) {
    if (!allowedKeys.has(u.key) || !u.value?.trim()) continue;
    qualification[u.key] = { value: u.value.trim().slice(0, 400), confidence: clamp01(u.confidence), updatedAt: nowIso };
  }
  const signals: LeadSignals = {};
  for (const [k, v] of Object.entries(result.signals)) if (v) (signals as Record<string, string>)[k] = v;
  for (const key of LEVEL_KEYS) {
    const level = (signals as Record<string, string | undefined>)[key];
    if (level && qualification[key]) qualification[key].level = level as never;
  }
  const offeredIds = new Set((input.state.offeredSlots ?? []).map((s) => s.id));
  const objectionKeys = new Set(input.biz.objections.map((o) => o.key));
  const analysis: LeadAnalysis = {
    qualification,
    signals,
    memories: result.memories.slice(0, 6).map((m) => ({ ...m, importance: Math.round(Math.min(3, Math.max(1, m.importance))) })),
    flags: {
      humanRequest: result.flags.human_request,
      asksIfBot: result.flags.asks_if_bot,
      medical: result.flags.medical_issue,
      angry: result.flags.angry || result.signals.sentiment === 'angry',
      optOut: result.flags.opt_out,
      asksPrice: result.flags.asks_price,
      wantsCall: result.flags.wants_call,
      declinesCall: result.flags.declines_call,
      complexNegotiation: result.flags.complex_negotiation,
      outOfScope: result.flags.out_of_scope,
      technicalIssue: result.flags.technical_issue,
      wantsReschedule: result.flags.wants_reschedule,
      wantsCancel: result.flags.wants_cancel,
      asksQuestion: result.flags.asks_question,
    },
    objectionKey: result.objection_key && objectionKeys.has(result.objection_key) ? result.objection_key : null,
    leadName: result.lead_name?.trim() || null,
    goalSummary: result.goal_summary?.trim().slice(0, 160) || null,
    preferredDate: result.preferred_date && /^\d{4}-\d{2}-\d{2}$/.test(result.preferred_date) ? result.preferred_date : null,
    preferredPartOfDay: result.preferred_part_of_day,
    selectedSlotId: result.selected_slot_id && offeredIds.has(result.selected_slot_id) ? result.selected_slot_id : null,
    summary: result.summary.slice(0, 500),
    engine: 'llm',
  };
  // Red de seguridad: estas señales nunca deben perderse aunque el modelo las pase por alto. Solo se suman
  // patrones de alta precisión: una baja es irreversible y un escalado detiene a KAI.
  // El horario elegido NO se completa con la heurística: reservar sin un “sí” claro es peor que volver a preguntar.
  const safety = analyzeHeuristically(input);
  const n = normalize(input.pending.map((m) => m.content).join('\n'));
  analysis.flags.optOut ||= RX_OPT_OUT_EXPLICIT.test(n);
  analysis.flags.humanRequest ||= safety.flags.humanRequest;
  analysis.flags.asksIfBot ||= safety.flags.asksIfBot;
  return analysis;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6);

// ───────────────────────────── Heurística en español ─────────────────────────────

/**
 * Peticiones inequívocas de no recibir más mensajes. Solo presente o imperativo (“no me escribas más”, “dame de baja”):
 * nunca pasado ni condicional (“no me escribiste”, “si no me escribes no me entero”) ni otras cosas (“no me mandes audios”).
 */
const RX_OPT_OUT_EXPLICIT =
  /^\s*(stop|baja|para ya|basta|unsubscribe)\s*[.!]*\s*$|\b(dame|dadme|darme|me doy) de baja\b|\bno me (escribas|escribais|escriba|escriban|mandes|mandeis|envies|envieis|contactes|contacteis|molestes|molesteis) (mas|nunca mas|nada mas)\b(?! tarde)|\bdeja(d|r)? de (escribirme|mandarme mensajes|enviarme mensajes|contactarme)\b|\bno quiero recibir (mas )?mensajes\b|\b(borra|borrad|elimina|eliminad) mis datos\b/;

const RX = {
  optOut: new RegExp(
    [
      RX_OPT_OUT_EXPLICIT.source,
      // “No me escribas.” / “no me escribáis por aquí” (como petición completa, sin “más tarde”, “ahora”…).
      String.raw`\bno me (escribas|escribais|escriban|contactes|contacteis|contacten)( por (aqui|whatsapp|instagram|insta))?\s*([.!,]|$)`,
      String.raw`\bno me (vuelvas|volvais|vuelvan) a (escribir|contactar|mandar)\b`,
      String.raw`\bno quiero que me (escribas|escribais|escriban|contactes|contacteis|mandes|mandeis|envies|envieis|sigas escribiendo|sigais escribiendo)\b(?! (mas )?(tarde|luego|ahora|hoy|a estas horas|por la (noche|manana)))`,
      String.raw`\bdeja(d|r)? de (escribir|mandarme|enviarme|molestar|molestarme)\b`,
      String.raw`\bno quiero saber nada mas\b`,
    ].join('|'),
  ),
  humanRequest:
    /\b(hablar|habla|hablo) (directamente )?con (una persona|un humano|una persona real|alguien (real|de verdad|del equipo|de carne y hueso)|el entrenador|la entrenadora|tu jefe|tu jefa|un responsable)\b|\bpersona real\b|\b(pasame|pasadme|ponme) con (una persona|alguien|el entrenador|la entrenadora|tu jefe|tu jefa)\b|\bquiero que me (llame|atienda|escriba|conteste|responda) (el entrenador|la entrenadora|una persona|alguien|un humano)\b|\bme puede (atender|llamar|escribir) (alguien|una persona)\b/,
  asksIfBot:
    /\beres (un |una )?(?:(?:bot|robot|ia|inteligencia artificial|chatbot|automatic[oa])\b|(?:maquina|programa|asistente virtual)\s*\?)|\b(eres|sois) (una persona|un humano|humano|humana|real)( real)?\s*\?|\bhablo con (un |una )?(bot|robot|maquina|ia|persona real|humano)\b|\besto es automatico\b|\b(me )?(responde|contesta|escribe) (un |una )?(bot|robot|maquina|ia)\b/,
  medical:
    /diabet|insulin|hipertens|tension alta|colesterol|tiroid|hernia|lesion|lesionad|operacion(?! (bikini|biquini|verano|playa))|operad[oa]|me (operaron|han operado|van a operar|operan)\b|embaraz|lactancia|medicacion|medicamento|pastillas para|trastorno alimentari|anorexia|bulimia|dolor (en el|de) pecho|cardiac|(problemas?|enfermedad|soplo|operacion|insuficiencia|fallo) (de|del|en el) corazon|arritmia|infarto|marcapasos|asma|epilep|cancer|quimio|analitica|analisis de sangre|depresion|ansiolitic|antidepresiv/,
  // Enfado: insultos o quejas claras dirigidas al negocio (no “me siento pesada” ni “joder, qué difícil”).
  angry:
    /estafa|estafador|\btimo\b|timador|me (teneis|tienes|estais) (harto|harta|frito|frita)|\b(eres|sois|estas|estais|seas|seais|que|ser|vaya|menudo|menuda|menudos|menudas) (un |unos |una |unas |muy |tan |mas )?pesad[oa]s?\b(?! me (siento|noto|veo|encuentro))|\bdeja(d)? de (molestar|dar la lata)|\bspam\b|denunci|que os jodan|a la mierda|cabron|gilipollas|idiota|imbecil|subnormal|sinverguenza|ladrones|que asco de (servicio|empresa|atencion|trato)|vergonzos[oa]|una verguenza|me estais tomando el pelo/,
  price: /cuanto (cuesta|vale|es|cobras|cobrais|sale)|precio|tarifa|que coste|coste|cuanto seria/,
  callYes: /(llamada|llamar|llamame|hablamos por telefono|videollamada|reunion|agendar|agenda|cita)\b/,
  /** Pide la llamada de forma explícita (tras haberla rechazado, solo esto vuelve a abrir la agenda). */
  callRequest:
    /\b(quiero|prefiero|me gustaria|podemos|podriamos|vamos a|mejor|al final) (si )?(hacer |tener |agendar |reservar )?(la |una )?(llamada|videollamada)\b|\b(hagamos|hacemos|agendamos|reservamos|agenda|reserva) (la |una )?(llamada|videollamada|cita)\b|\bllamame\b|\bagendamos\b|\bme apunto a la (llamada|videollamada)\b/,
  affirm: /^\s*(si|sip|vale|ok|okey|okay|perfecto|genial|claro|me encaja|me parece bien|venga|dale|por supuesto|de acuerdo|guay|bien|me vale)\b/,
  // Rechazar la llamada (no “prefiero no decirlo” ni “ahora no puedo hablar”).
  declineCall:
    /\bno (me interesa|quiero|necesito|hace falta|me hace falta) (la |una |ninguna )?(llamada|videollamada|reunion)\b|\bprefiero (no (hacer|tener) (la |una )?(llamada|videollamada)|no hablar por telefono|por escrito|seguir por (aqui|escrito|mensaje|mensajes|whatsapp|chat)|hablarlo por aqui)\b|\bnada de llamadas\b|\bsin llamadas?\b|\bno me gustan las llamadas\b/,
  negotiation: /descuento|rebaja|mas barato|pagar a plazos|financiar|precio especial|me haces (un )?precio|me lo dejas en|regatear/,
  outOfScope: /factura|devolucion|reembolso|colabora(cion|r)|patrocin|trabajar con vosotros|empleo|curriculum|publicidad en tu/,
  technical: /no (me )?funciona el (enlace|link)|no puedo (entrar|abrir|acceder)|no carga|link roto|me da error/,
  reschedule:
    /(cambiar|mover|aplazar|reprogramar|retrasar|adelantar|cambiamos|movemos) (la |el |mi )?(llamada|cita|hora|dia|videollamada)|\b(pasar|pasamos|pasame) (la |mi )?(llamada|cita|videollamada)\b|\bno (voy a )?(puedo|podre|poder) (ir|asistir|conectarme|estar|llegar|a esa hora|ese dia|esa hora)|\bal final no (puedo|podre|voy a poder)\b|\bno voy a (poder|llegar)\b|\bno me va a dar tiempo\b|\bme (ha surgido|surgio|ha salido) (algo|un imprevisto|un problema)\b|\bimprevisto\b|\botro (dia|horario|hueco) para la (llamada|cita)\b/,
  cancel: /\b(cancelar|cancela|cancelad|cancelame|anular|anula|anulad|anulame) (la |el |mi )?(llamada|cita|videollamada|reunion)\b|\bya no (quiero|necesito) (la )?(llamada|cita|videollamada)\b/,
  question: /\?|^(como|cuando|cuanto|que|donde|por que|quien|cual)\b/,
};

const QUAL_PATTERNS: Record<string, RegExp> = {
  goal: /(perder|bajar|quitar(me)?|eliminar)\s+(\d+\s*(kg|kilos)|peso|grasa|barriga|tripa|michelines)|ganar (musculo|masa|fuerza)|definir|tonificar|ponerme en forma|estar en forma|recomposicion|mejorar (mi )?(fisico|salud|forma)|verme mejor/,
  problem:
    /no tengo tiempo|falta de tiempo|constancia|no soy constante|me cuesta|no se (que|como)|ansiedad|picoteo|lo dejo|abandono|me aburro|no veo resultados|desorganiz|trabajo mucho|horarios|como fatal|ceno mal/,
  motivation: /boda|verano|vacaciones|salud|mis hijos|mi hija|mi hijo|verme bien|sentirme bien|autoestima|el medico me|confianza|seguridad|espejo|ropa|playa|cumple/,
  previous_attempts: /he probado|probe|he hecho|hice|dieta|keto|ayuno|gimnasio|gym|app|otro entrenador|crossfit|nutricionista|contar calorias/,
  frustration: /frustr|harto|cansado de|nunca (me )?funciona|no me funcion|rebote|vuelvo a coger|recupero el peso|me desanimo/,
  current_situation: /ahora mismo|actualmente|entreno|no entreno|voy al gimnasio|camino|sedentari|trabajo (en|de)|peso \d+|mido/,
};

const URGENCY_HIGH = /cuanto antes|ya mismo|urgente|lo antes posible|este mes|en (\d+|un par de|dos|tres|cuatro) (semanas|meses)|boda|para (el )?verano|septiembre|octubre|noviembre|diciembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|quiero empezar ya|empezar ya/;
const URGENCY_MED = /este ano|pronto|en unos meses|a medio plazo/;
const URGENCY_LOW = /sin prisa|no tengo prisa|mas adelante|algun dia|el ano que viene/;
const COMMIT_HIGH = /estoy dispuest|lo que haga falta|comprometid|voy en serio|esta vez si|me lo tomo en serio|totalmente|por supuesto|quiero hacerlo bien|necesito un cambio/;
const COMMIT_LOW = /no se si podre|no creo que|ya veremos|no se si tengo tiempo|igual no/;
const BUDGET_YES = /puedo invertir|dispuest[oa] a invertir|tengo presupuesto|no hay problema con el (precio|dinero)|me lo puedo permitir|si (puedo|me lo puedo permitir)|invertir en mi/;
const BUDGET_NO = /no tengo dinero|no puedo pagar|no me lo puedo permitir|sin dinero|muy justo de dinero|no puedo gastar/;
const BUDGET_MAYBE = /depende del precio|segun (el|lo que) cueste|si no es muy caro|depende de cuanto/;
const UNDERAGE = /tengo (1[0-7]|[1-9]) anos|soy menor/;

const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };

function sentenceWith(text: string, rx: RegExp): string | null {
  const parts = text.split(/(?<=[.!?\n])\s+/);
  const norm = parts.map((p) => normalize(p));
  const i = norm.findIndex((p) => rx.test(p));
  return i >= 0 ? parts[i].trim().slice(0, 300) : null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿Aparece la expresión como palabras completas en el texto normalizado? (“caro” no está en “Carolina”). */
function containsPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalize(phrase);
  return Boolean(p) && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p)}(?![\\p{L}\\p{N}])`, 'u').test(normalizedText);
}

function levelFrom(n: string, high: RegExp, low: RegExp, med?: RegExp): 'high' | 'medium' | 'low' | null {
  if (high.test(n)) return 'high';
  if (low.test(n)) return 'low';
  if (med?.test(n)) return 'medium';
  return null;
}

export function resolvePreferredDate(n: string, now: Date, tz: string): string | null {
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const withoutPartOfDay = n.replace(/por la manana|de la manana|esta manana/g, ' ');
  if (/pasado manana/.test(withoutPartOfDay)) return today.plus({ days: 2 }).toISODate();
  if (/\bmanana\b/.test(withoutPartOfDay)) return today.plus({ days: 1 }).toISODate();
  if (/\bhoy\b|esta manana|esta tarde|esta noche/.test(n)) return today.toISODate();
  for (const [name, wd] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b(el )?${name}\\b`).test(n)) {
      let diff = (wd - today.weekday + 7) % 7;
      if (diff === 0) diff = 7;
      return today.plus({ days: diff }).toISODate();
    }
  }
  return null;
}

export function resolvePartOfDay(n: string): 'morning' | 'afternoon' | 'evening' | null {
  if (/por la manana|de la manana|a primera hora|esta manana/.test(n)) return 'morning';
  if (/por la tarde|esta tarde|de la tarde|despues de comer|mediodia/.test(n)) return 'afternoon';
  if (/por la noche|esta noche|de noche|despues de trabajar|ultima hora/.test(n)) return 'evening';
  return null;
}

/** Rechaza un horario o pide otro: en ese caso no se elige ninguno (mejor preguntar que reservar mal). */
const RX_SLOT_REJECTION =
  /\bno (puedo|podre|podria|me (va|viene|encaja|cuadra|sirve|vendria|iria))\b|\b(imposible|ninguna|ninguno)\b|\bme (va|viene|pilla) (fatal|mal)\b|\b(otro|otra) (dia|hora|momento|hueco|franja|semana|opcion)\b/;
/**
 * Dudas u obstáculos con el horario (“no sé si llego”, “a las 10:00 trabajo”, “tengo dentista”): no es una elección.
 * “Salgo del trabajo a las 18:00” sí puede serlo (el sustantivo “trabajo” con artículo no cuenta).
 */
const RX_SLOT_HESITATION =
  /\bno (se|estoy segur[oa]) si\b|\bno (llego|creo que llegue|creo que pueda)\b|\b(igual|a lo mejor|quizas?) no\b|\btengo (el |la |un |una |que ir al? |que ir a la )?(dentista|medico|medica|reunion|cita|clase|turno|entreno|partido|consulta|examen|comida|cena|evento|viaje|guardia)\b|(?<!\b(del|de|el|mi|al|tu|su|un) )\b(trabajo|curro)\b|\bestoy (trabajando|currando|ocupad[oa]|liad[oa])\b|\b(complicado|dificil|justo|justito)\b/;
/** Preguntas que en realidad eligen (“¿puede ser a las 18:00?”, “¿me apuntas a la primera?”). */
const RX_CHOICE_QUESTION = /\b(puede ser|podria ser|podemos (hacerla|quedar|dejarla)|me (apuntas|pones|reservas|guardas|coges)|apuntame|reservame|lo dejamos|la dejamos|quedamos)\b/;
const ORD = '(primer[ao]|1[aªoº]|segund[ao]|2[aªoº]|tercer[ao]|3[aªoº]|ultim[ao])';
/** Lo que puede seguir a un ordinal cuando el lead elige (“la segunda porfa”, “la primera me viene genial”). */
const AFTER_CHOICE =
  '(?=\\s*(?:$|[,.;:!?)]|(?:opcion|hueco|horario|porfa|por favor|gracias|mejor|entonces|pues|vale|perfecto|genial|plis|please|si|me (?:va|viene|encaja|cuadra|sirve|parece|quedo)|es (?:perfect[ao]|mejor|ideal|genial)|esta bien)\\b))';
/** “la segunda”, “el primero”, “opción tercera” (con artículo; no “un segundo”, “a primera hora” ni “la última vez”). */
const RX_ORDINAL_WITH_ARTICLE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:(?:la|el)\\s+(?:opcion\\s+)?|opcion\\s+)${ORD}${AFTER_CHOICE}`, 'u');
/** El mensaje entero es el ordinal (“Segunda”, “vale, primera porfa”); no “Primero dime cuánto cuesta”. */
const RX_ORDINAL_ALONE = new RegExp(
  `^(?:(?:pues|vale|ok|okey|si|bueno|genial|perfecto|mejor|prefiero|quiero|elijo|me quedo con)[\\s,.!]+)*${ORD}(?:\\s+opcion)?(?:[\\s,]+(?:porfa|por favor|gracias|please|plis))?[\\s.!]*$`,
);
const RX_OPTION_NUMBER = /\bopcion\s+(?:numero\s+)?([1-9])\b/;

/** Índice del horario elegido por su posición (−1 = el último), o null si no hay un ordinal de elección. */
function ordinalChoice(n: string): number | null {
  const opt = RX_OPTION_NUMBER.exec(n);
  if (opt) return Number(opt[1]) - 1;
  const m = RX_ORDINAL_WITH_ARTICLE.exec(n) ?? RX_ORDINAL_ALONE.exec(n);
  if (!m) return null;
  const word = m[1];
  if (/^(primer|1)/.test(word)) return 0;
  if (/^(segund|2)/.test(word)) return 1;
  if (/^(tercer|3)/.test(word)) return 2;
  return -1;
}

/** Intenta identificar qué horario de los ofrecidos ha elegido el lead. */
export function matchOfferedSlot(n: string, allOffered: OfferedSlot[], tz: string, now: Date = new Date(), lastOfferIds: string[] = []): string | null {
  if (!allOffered.length) return null;
  // Elegir un horario reserva la cita: ante un rechazo (“el jueves no puedo”, “otro día”), una duda u obstáculo
  // (“a las 18:00 no sé si llego”, “mañana tengo dentista”) o una pregunta sobre el horario (“¿las 18:00 es hora
  // de Madrid?”) no se elige nada: ante la duda, KAI pregunta cuál le viene mejor.
  if (RX_SLOT_REJECTION.test(n) || RX_SLOT_HESITATION.test(n)) return null;
  if (n.includes('?') && !RX_CHOICE_QUESTION.test(n)) return null;
  // Las referencias ordinales (“la primera”) apuntan a la ÚLTIMA oferta; las horas, preferentemente también.
  const latest = lastOfferIds.map((id) => allOffered.find((s) => s.id === id)).filter((s): s is OfferedSlot => Boolean(s));
  const offered = latest.length ? latest : allOffered;
  const ordinal = ordinalChoice(n);
  if (ordinal !== null) return (ordinal < 0 ? offered[offered.length - 1] : offered[ordinal])?.id ?? null;
  const times = [...n.matchAll(/\b(?:a las |las |la de las )?([01]?\d|2[0-3])(?:[:.h]([0-5]\d))?\s*(?:h|horas)?\b(?:\s*y media)?/g)];
  const onlyNumber = /^\s*\d{1,2}([:.]\d{2})?\s*$/.test(n);
  const mentionsTime = /\d/.test(n) && (/(a las|las|:|\bh\b|\dh\b|horas|y media)/.test(n) || onlyNumber);
  if (mentionsTime) {
    for (const m of times) {
      // Solo cuentan los números con forma de hora (“a las 10”, “18:00”, “10h”), no “tengo 18 años” ni “10 horas a la semana”.
      if (!onlyNumber && !/las|[:.]\d|\dh\b|y media/.test(m[0])) continue;
      const hour = Number(m[1]);
      const minute = /y media/.test(m[0]) ? 30 : m[2] ? Number(m[2]) : null;
      const matches = (pool: OfferedSlot[]) =>
        pool.filter((s) => {
          const local = DateTime.fromISO(s.start).setZone(tz);
          const hourOk = local.hour === hour || local.hour % 12 === hour % 12;
          return hourOk && (minute === null || local.minute === minute);
        });
      const candidates = matches(offered);
      if (candidates.length === 1) return candidates[0].id;
      const anyCandidates = matches(allOffered);
      if (candidates.length === 0 && anyCandidates.length === 1) return anyCandidates[0].id;
    }
  }
  const date = resolvePreferredDate(n, now, tz);
  if (date) {
    const sameDay = offered.filter((s) => DateTime.fromISO(s.start).setZone(tz).toISODate() === date);
    if (sameDay.length === 1 && (RX.affirm.test(n) || /\b(me viene|me va|me encaja|me cuadra|prefiero|mejor|esa|ese)\b/.test(n))) return sameDay[0].id;
  }
  if (offered.length === 1 && RX.affirm.test(n)) return offered[0].id;
  return null;
}

/** “Quiero hablar con Álex”, “pásame con Álex”: pide hablar con el entrenador por su nombre. */
function asksForTrainer(n: string, trainerName: string): boolean {
  const name = normalize(trainerName).split(' ')[0];
  if (!name || name.length < 3) return false;
  const who = escapeRegExp(name);
  return new RegExp(
    `\\b(quiero|puedo|podria|prefiero|preferiria|me gustaria|necesito) hablar (directamente )?con ${who}\\b|\\b(pasame|pasadme|ponme) con ${who}\\b|\\bquiero que me (llame|escriba|atienda|conteste) ${who}\\b`,
  ).test(n);
}

export function analyzeHeuristically(input: AnalysisInput): LeadAnalysis {
  const raw = input.pending.map((m) => m.content).join('\n');
  const n = normalize(raw);
  const tz = input.biz.business.timezone;
  const nowIso = input.now.toISOString();
  const qualification: LeadQualification = {};
  const signals: LeadSignals = {};
  const enabledKeys = new Set(input.biz.rules.map((r) => r.key));
  const wordCount = n.split(' ').filter(Boolean).length;
  const lastAsked = input.state.lastAskedKey;

  // 1) La respuesta directa a la última pregunta de KAI es la fuente más fiable.
  if (lastAsked && enabledKeys.has(lastAsked) && !input.lead.qualification[lastAsked]?.value && wordCount >= 2 && !RX.price.test(n) && !RX.optOut.test(n)) {
    qualification[lastAsked] = { value: raw.trim().slice(0, 300), confidence: 0.75, updatedAt: nowIso };
  }
  // 2) Información que el lead da por iniciativa propia.
  for (const [key, rx] of Object.entries(QUAL_PATTERNS)) {
    if (!enabledKeys.has(key) || qualification[key]) continue;
    if (key === 'goal') {
      // Objetivo: la frase concreta (“perder 10 kilos”), no el mensaje entero.
      const nfc = raw.normalize('NFC');
      const m = rx.exec(fold(nfc));
      if (m) qualification.goal = { value: nfc.slice(m.index, m.index + m[0].length).trim(), confidence: 0.7, updatedAt: nowIso };
      continue;
    }
    const s = sentenceWith(raw, rx);
    if (s) qualification[key] = { value: s, confidence: 0.6, updatedAt: nowIso };
  }
  const urgency = levelFrom(n, URGENCY_HIGH, URGENCY_LOW, URGENCY_MED);
  if (urgency) signals.urgency = urgency;
  else if (lastAsked === 'urgency' && wordCount >= 2) signals.urgency = 'medium';
  const commitment = levelFrom(n, COMMIT_HIGH, COMMIT_LOW);
  if (commitment) signals.commitment = commitment;
  else if (lastAsked === 'commitment' && RX.affirm.test(n)) signals.commitment = 'high';
  if (BUDGET_NO.test(n)) signals.budget = 'no';
  else if (BUDGET_YES.test(n) || (lastAsked === 'budget' && RX.affirm.test(n))) signals.budget = 'yes';
  else if (BUDGET_MAYBE.test(n)) signals.budget = 'maybe';
  if (UNDERAGE.test(n)) signals.fit = 'no';
  else if (qualification.goal || input.lead.qualification.goal) signals.fit = input.lead.signals.fit === 'no' ? 'no' : 'yes';
  for (const key of ['urgency', 'commitment', 'budget', 'fit'] as const) {
    const lvl = signals[key];
    if (!lvl || !enabledKeys.has(key)) continue;
    if (!qualification[key]) qualification[key] = { value: raw.trim().slice(0, 200), confidence: 0.6, updatedAt: nowIso, level: lvl };
    else qualification[key].level = lvl;
  }

  const angry = RX.angry.test(n);
  if (angry) signals.sentiment = 'angry';
  else if (/gracias|genial|perfecto|me encanta|guay|ilusion/.test(n)) signals.sentiment = 'positive';

  const memories: LeadAnalysis['memories'] = [];
  const memoryPatterns: [RegExp, LeadAnalysis['memories'][number]['kind'], number][] = [
    [/boda|comunion|bautizo|graduacion|viaje|vacaciones|crucero|despedida/, 'event', 3],
    [/hijos?|hijas?|mujer|marido|pareja|novi[oa]/, 'personal', 2],
    [/turnos|noches|viajo mucho|teletrabajo|horario|oficina|autonomo/, 'constraint', 2],
    [/tengo \d{2} anos|peso \d{2,3}|mido \d/, 'fact', 2],
    [/no me gusta|odio|prefiero|me encanta/, 'preference', 1],
    [/lesion|hernia|operad|rodilla|espalda|hombro/, 'constraint', 3],
  ];
  for (const [rx, kind, importance] of memoryPatterns) {
    const s = sentenceWith(raw, rx);
    if (s) memories.push({ kind, content: s, importance });
  }

  const offered = input.state.offeredSlots ?? [];
  const lastOutbound = [...input.history].reverse().find((m) => m.direction === 'outbound');
  const declinesCall = RX.declineCall.test(n);
  // Si el lead ya rechazó la llamada, un “vale” o un “me interesa” no la reabren: solo una petición explícita.
  const callDeclined = Boolean((input.state as SetterState).callDeclinedAt);
  const callWasProposed = !callDeclined && (Boolean(input.state.callProposedAt) || /llamada/.test(normalize(lastOutbound?.content ?? '')));
  const positive = RX.affirm.test(n) || /quiero empezar|cuanto antes|adelante|vamos alla|me interesa|claro que si|me apunto|hagamosla|cuando quieras|me parece genial|me parece perfecto/.test(n);
  const wantsCall =
    !declinesCall &&
    (callDeclined
      ? RX.callRequest.test(n)
      : RX.callYes.test(n) || (callWasProposed && positive) || Boolean(resolvePreferredDate(n, input.now, tz) && callWasProposed));

  // Una objeción es un freno a AVANZAR (llamada, precio, servicio). Si el lead está describiendo su
  // situación (responde a una pregunta de cualificación), “no tengo tiempo” es información, no objeción.
  const decisionStage = Boolean(input.state.callProposedAt || input.state.priceShared || (input.state.offeredSlots?.length ?? 0) > 0);
  const answeringDiscovery = Object.keys(qualification).length > 0;
  let objectionKey: string | null = null;
  for (const o of decisionStage || !answeringDiscovery ? input.biz.objections : []) {
    if (o.triggers.some((t) => containsPhrase(n, t))) {
      objectionKey = o.key;
      break;
    }
  }

  // “me llamo / soy” en cualquier mayúscula (“Me llamo Laura”); el nombre, en cambio, debe ir en mayúscula
  // para no capturar palabras comunes (“soy nueva”).
  const nameMatch = /(?<!\p{L})(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy)\s+(\p{Lu}\p{Ll}+)/u.exec(raw.normalize('NFC'));

  return {
    qualification,
    signals,
    memories,
    flags: {
      humanRequest: RX.humanRequest.test(n) || asksForTrainer(n, input.biz.trainer.displayName),
      asksIfBot: RX.asksIfBot.test(n),
      medical: RX.medical.test(n),
      angry,
      optOut: RX.optOut.test(n),
      asksPrice: RX.price.test(n),
      wantsCall,
      declinesCall,
      complexNegotiation: RX.negotiation.test(n),
      outOfScope: RX.outOfScope.test(n),
      technicalIssue: RX.technical.test(n),
      wantsReschedule: RX.reschedule.test(n),
      wantsCancel: RX.cancel.test(n),
      asksQuestion: RX.question.test(n),
    },
    objectionKey,
    leadName: nameMatch?.[1] ?? null,
    goalSummary: qualification.goal?.value?.slice(0, 160) ?? null,
    preferredDate: resolvePreferredDate(n, input.now, tz),
    preferredPartOfDay: resolvePartOfDay(n),
    selectedSlotId: matchOfferedSlot(n, offered, tz, input.now, input.state.lastOfferIds ?? []),
    summary: 'Análisis heurístico (modo simulación).',
    engine: 'heuristic',
  };
}

export async function analyzeLeadMessages(provider: LLMProvider | null, input: AnalysisInput): Promise<LeadAnalysis> {
  if (!provider) return analyzeHeuristically(input);
  try {
    return await analyzeWithLLM(provider, input);
  } catch {
    // Si la IA falla, nunca nos quedamos sin análisis: usamos las reglas.
    return analyzeHeuristically(input);
  }
}
