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
  /** Hora concreta que pide (“a las 9 de la mañana” → "09:00"); solo la heurística. */
  preferredTime?: string | null;
  /** Pide moverla solo porque da un día u hora (“mejor el miércoles”, “Vale, el lunes”), sin decir que quiere cambiarla. */
  rescheduleImplicit?: boolean;
  /** Día que dice que NO puede (“el lunes no puedo”): nunca es su preferencia. */
  excludedDate?: string | null;
  /** Rechaza los horarios que se le acaban de ofrecer (“el lunes no puedo”, “ninguna me va bien”, “¿no tienes otro día?”). */
  rejectsOffer?: boolean;
  /** Desiste de mover la llamada que ya tiene (“mejor la dejamos como estaba”, “déjala como está”). */
  keepsAppointment?: boolean;
  /** El mensaje habla de horarios (elige, duda, da un día u hora, pide otro) o responde a la oferta que KAI acaba de hacer. */
  aboutSchedule?: boolean;
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
  preferred_date: z.string().nullable().describe('YYYY-MM-DD si el lead indica un día concreto que le va bien (null si dice que ese día NO puede)'),
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
  // Ya es cliente (escribe desde otro número o canal): es para el entrenador, no para el embudo de venta.
  analysis.flags.outOfScope ||= RX_EXISTING_CLIENT.test(n);
  // Horarios: un día que dice que no puede nunca es su preferencia, y rechazar la oferta o desistir de mover la
  // llamada son frases muy concretas. Sin esto, KAI repetiría los mismos horarios en bucle.
  analysis.excludedDate = safety.excludedDate;
  if (analysis.preferredDate && analysis.preferredDate === safety.excludedDate) analysis.preferredDate = null;
  analysis.rejectsOffer = Boolean(safety.rejectsOffer) && !analysis.selectedSlotId;
  analysis.keepsAppointment = safety.keepsAppointment;
  analysis.aboutSchedule =
    Boolean(safety.aboutSchedule || analysis.selectedSlotId || analysis.preferredDate || analysis.preferredPartOfDay || analysis.flags.wantsReschedule) &&
    !safety.keepsAppointment;
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
    /\b(hablar|habla) (directamente )?con (una persona|un humano|una persona real|alguien (real|de verdad|del equipo|de carne y hueso)|el entrenador|la entrenadora|tu jefe|tu jefa|un responsable)\b|\b(pasame|pasadme|ponme) con (una persona|alguien|el entrenador|la entrenadora|tu jefe|tu jefa)\b|\bquiero que me (llame|atienda|escriba|conteste|responda) (el entrenador|la entrenadora|una persona|alguien|un humano)\b|\bme puede (atender|llamar|escribir) (alguien|una persona)\b/,
  asksIfBot:
    /\beres (un |una )?(?:(?:bot|robot|ia|inteligencia artificial|chatbot|automatic[oa])\b|(?:maquina|programa|asistente virtual)\s*\?)|\b(eres|sois) (una persona|un humano|humano|humana|real)( real)?\s*\?|\b(estoy )?habl(o|ando) con (un |una )?(bot|robot|maquina|ia|inteligencia artificial|chatbot|persona( real)?|humano|humana|programa)\b|\bes (un )?(bot|robot|chatbot)\b|\besto es (un )?(bot|chatbot|automatico)\b|\b(me )?(responde|contesta|escribe) (un |una )?(bot|robot|maquina|ia|persona( real)?|humano)\b|\bhay (una persona|alguien) (real )?(ahi|detras)\b/,
  medical:
    /diabet|insulin|hipertens|tension alta|colesterol|tiroid|hernia|lesion|lesionad|operacion(?! (bikini|biquini|verano|playa))|operad[oa]|me (operaron|han operado|van a operar|operan)\b|embaraz|lactancia|medicacion|medicamento|pastillas para|trastorno alimentari|anorexia|bulimia|dolor (en el|de) pecho|cardiac|(problemas?|enfermedad|soplo|operacion|insuficiencia|fallo) (de|del|en el) corazon|arritmia|infarto|marcapasos|asma|epilep|cancer|quimio|analitica|analisis de sangre|depresion|ansiolitic|antidepresiv/,
  // Enfado: insultos o quejas claras dirigidas al negocio (no “me siento pesada” ni “joder, qué difícil”).
  angry:
    /estafa|estafador|\btimo\b|timador|me (teneis|tienes|estais) (harto|harta|frito|frita)|\b(eres|sois|estas|estais|seas|seais|que|ser|vaya|menudo|menuda|menudos|menudas) (un |unos |una |unas |muy |tan |mas )?pesad[oa]s?\b(?! me (siento|noto|veo|encuentro))|\bdeja(d)? de (molestar|dar la lata)|\bspam\b|denunci|que os jodan|a la mierda|cabron|gilipollas|idiota|imbecil|subnormal|sinverguenza|ladrones|que asco de (servicio|empresa|atencion|trato)|vergonzos[oa]|una verguenza|me estais tomando el pelo/,
  // Pregunta el precio (“¿cuánto costaría?”, “¿cuánto me sale?”, “¿qué vale?”, “¿cuánto hay que pagar?”, “¿cuánto pago
  // al mes?”, “¿y cuánto dinero es?”, “¿cuánto me dijiste que costaba?”); no “lo que cuesta es levantarme”, “creo que
  // vale la pena”, “¿para qué vale la llamada?”, “¿cuánto tiempo es la llamada?” ni “¿cuánto estás dispuesto…?”.
  price:
    /\bcuanto (?:me |te |nos |os |le |les )?(?:cuesta|cuestan|costaria|costarian|costaba|costaban|vale|valen|valdria|valia|es|son|era|eran|seria|serian|cobras|cobrais|cobra|cobran|cobrarias|sale|salen|saldria|salia)\b|(?<!\bpara )\bque (?:vale|valdria|cuesta|costaria)\b(?! la pena)[^.!?\n]*\?|precio|tarifa|coste|\b(?:cual es|de cuanto es|cuanto es) la (?:cuota|mensualidad)\b|\bcuanto (?:me |te |nos |os |le |les )?(?:hay que|habria que|tengo que|tendria que|tendre que|tendriamos que|toca|tocaria) (?:pagar|invertir|abonar|gastar|poner)\b|\bcuanto (?:me |te |nos |os |le |les )?(?:pago|pagaria|pagamos|pagariamos|invierto|invertiria|invertiriamos|gastaria)\b|\bcuant[oa] (?:dinero|pasta|plata)\b[^.!\n]*\?|^\s*¿?\s*(?:y )?cuant[oa] (?:dinero|pasta|plata)\b|\bcuanto (?:me |nos )?(?:dijiste|dices|decias|has dicho|habias dicho|comentaste|pusiste|pone) que (?:cuesta|costaba|costaria|vale|valia|es|era|sale|salia|cobras|cobrabas)\b/,
  callYes: /(llamada|llamar|llamame|hablamos por telefono|videollamada|reunion|agendar|agenda|cita)\b/,
  /**
   * Pide la llamada de forma explícita (tras haberla rechazado, solo esto vuelve a abrir la agenda). También las formas
   * naturales de pedir hablar (“¿podemos hablar?”, “¿cuándo hablamos?”, “prefiero hablar por teléfono”), pero no
   * “hablamos por aquí”, “¿podemos hablar del precio?”, “ahora no podemos hablar”, “podemos hablar más tarde” ni
   * “¿se puede hacer sin hablar por teléfono?”.
   */
  callRequest:
    /\b(quiero|prefiero|me gustaria|podemos|podriamos|vamos a|mejor|al final) (si )?(hacer |tener |agendar |reservar )?(la |una )?(llamada|videollamada)\b|\b(hagamos|hacemos|agendamos|reservamos|agenda|reserva) (la |una )?(llamada|videollamada|cita)\b|\bllamame\b|\bagendamos\b|\bme apunto a la (llamada|videollamada)\b|(?<!\bno )\b(?:podemos|podriamos|podamos|pudieramos) hablar\b(?! (?:por (?:aqui|escrito|mensajes?|whatsapp|chat|instagram|insta|privado|dm)|de\b|del\b|sobre\b|con\b|mas tarde|luego|despues|en otro momento|otro rato))|\b(?:cuando|que dia|a que hora) (?:hablamos|nos llamamos)\b(?! (?:por (?:aqui|escrito|mensajes?|whatsapp|chat|instagram|insta|privado|dm)|de\b|del\b|sobre\b))|^\s*¿?\s*(?:(?:vale|ok|pues|entonces|genial|perfecto|venga)[,.!]?\s+)?¿?\s*hablamos\s*\?|\bquedamos para hablar\b|(?<!\b(?:no (?:puedo |quiero |me gusta |me apetece )?|sin ))\bhablar por telefono\b/,
  affirm: /^\s*(si|sip|vale|ok|okey|okay|perfecto|genial|claro|me encaja|me parece bien|venga|dale|por supuesto|de acuerdo|guay|bien|me vale)\b/,
  // Rechazar la llamada (“no quiero hacer la llamada”, “paso de llamadas”, “prefiero no hacer llamadas”, “¿se puede
  // hacer sin hablar por teléfono?”, “no tengo tiempo para llamadas”, “no puedo hacer llamadas”), pero no “prefiero no
  // decirlo” ni “ahora no puedo hablar”.
  declineCall:
    /\bno (?:me interesa|quiero|necesito|me apetece|hace falta|me hace falta|me hacen falta|veo necesaria)(?: hacer| tener| agendar| reservar)? (?:la |una |ninguna |las |mas )?(?:llamadas?|videollamadas?|reunion(?:es)?)\b|\bno tengo tiempo (?:para|de) (?:hacer |tener )?(?:la |una |ninguna |las |mas )?(?:llamadas?|videollamadas?)\b|\bno (?:puedo|quiero) (?:hacer |tener )?(?:llamadas|videollamadas)\b|\bprefiero (?:no (?:hacer|tener) (?:la |una |ninguna |las )?(?:llamadas?|videollamadas?)|no hablar por telefono|por escrito|por aqui|seguir por (?:aqui|escrito|mensaje|mensajes|whatsapp|chat)|hablarlo por aqui)\b|\bpaso de (?:la |las |hacer (?:la |una )?)?(?:llamadas?|videollamadas?)\b|\bnada de (?:llamadas|videollamadas)\b|\bsin (?:hacer |tener )?(?:la |una |ninguna )?(?:llamadas?|videollamadas?)\b|\bsin hablar(?:lo)? por telefono\b|\bno me gustan(?: nada| mucho)? las (?:llamadas|videollamadas)\b|\bno me gusta(?: nada| mucho)? (?:hablar por telefono|hacer llamadas)\b/,
  negotiation: /descuento|rebaja|mas barato|pagar a plazos|financiar|precio especial|me haces (un )?precio|me lo dejas en|regatear/,
  outOfScope: /factura|devolucion|reembolso|colabora(cion|r)|patrocin|trabajar con vosotros|empleo|curriculum|publicidad en tu/,
  technical: /no (me )?funciona el (enlace|link)|no puedo (entrar|abrir|acceder)|no carga|link roto|me da error/,
  reschedule:
    /(cambiar|mover|aplazar|reprogramar|retrasar|adelantar|cambiamos|movemos) (la |el |mi )?(llamada|cita|hora|dia|videollamada)|(?<!\bno )\b(?:la (?:podemos|podriamos|puedes|podrias|podeis|podriais|puede|podria|quiero|queria|querria|necesito|tengo que|tendria que|tendriamos que|habria que|hay que)|lo (?:podemos|podriamos|puedes|podrias|podeis|podriais)) (?:mover|cambiar|pasar|retrasar|adelantar|aplazar|reprogramar)\b|\b(pasar|pasamos|pasame) (la |mi )?(llamada|cita|videollamada)\b|\bno (voy a )?(puedo|podre|poder) (ir|asistir|conectarme|estar|llegar|a esa hora|ese dia|esa hora)|\bal final no (puedo|podre|voy a poder)\b|\bno voy a (poder|llegar)\b|\bno me va a dar tiempo\b|\bme (ha surgido|surgio|ha salido) (algo|un imprevisto|un problema)\b|\bimprevisto\b|\botro (dia|horario|hueco) para la (llamada|cita)\b|\bno me (viene|va|cuadra|encaja|pilla) bien\b|^\s*(?:(?:pues|uf|vaya|ay|lo siento|perdona)[,.!]?\s+)?(?:no[,.!]?\s+)*no puedo\s*[.!,]*\s*(lo siento|perdona|sorry)?[.!]*\s*$|\b(mejor|prefiero|preferiria|podemos|podriamos|puede ser|seria|hay) (en )?(otro|otra) (dia|hora|horario|momento)\b|\b(otro|otra) (dia|hora|horario|momento) (mejor|si puede ser|porfa|por favor)\b|(?<!\bno (?:quiero |hace falta |hay que |es necesario |vayas a )?)\b(?:muevela|muevelo|moverla|moverlo|cambiala|cambialo|cambiarla|cambiarlo|pasala|pasarla|retrasala|retrasarla|adelantala|adelantarla|aplazala|aplazarla|reprogramala|reprogramarla)\b|\b(?:a|para) otro dia\b|\b(?:una|media) hora (?:mas tarde|mas pronto|antes|despues)\b|\b(?:puede|podria|podemos|podriamos) (?:ser|hacerla|dejarla|ponerla|pasarla) (?:un poco |algo )?(?:mas tarde|mas pronto|antes|despues)\b/,
  // Cancelar la llamada, también con pronombre (“cancélala”, “quiero anularla”) o con la palabra sola (“Cancelar”),
  // pero no “no la canceles” ni “no quiero cancelarla”.
  cancel:
    /\b(cancelar|cancela|cancelad|cancelame|anular|anula|anulad|anulame) (la |el |mi )?(llamada|cita|videollamada|reunion)\b|\bya no (quiero|necesito) (la )?(llamada|cita|videollamada)\b|(?<!\bno (?:quiero |hace falta |hay que |es necesario |vayas a )?)\b(?:cancelala|cancelalo|cancelarla|cancelarlo|anulala|anulalo|anularla|anularlo)\b|^\s*(?:(?:si|vale|ok|pues|mejor)[,.!]?\s+)?(?:cancelar|cancela|cancelad|anular|anula)(?:,? (?:por favor|porfa))?\s*[.!]*\s*$/,
  question: /\?|^(como|cuando|cuanto|que|donde|por que|quien|cual)\b/,
};

/**
 * La palabra “llamada” va negada en la misma frase (“no tengo tiempo para una llamada”, “no sé si la llamada…”):
 * mencionarla así no es aceptarla.
 */
const RX_CALL_NEGATED = /\b(?:no|ni|nunca|tampoco)\b(?:\s+[^\s.!?,;]+){0,5}?\s+(?:llamadas?|llamar|videollamadas?|reunion(?:es)?)\b/;
/** Negaciones que en realidad son un sí (“no hay problema con la llamada”, “¿por qué no hacemos la llamada?”). */
const RX_NOT_A_NEGATION = /\bno (?:hay|tengo) (?:ningun )?problema\b|\bno pasa nada\b|\bno me importa\b|\bpor que no\b/g;
/**
 * Pide otro día u hora (“mejor el miércoles”, “el jueves a las 18:00 me iría mejor”, “¿puede ser a las 19:00?”, “¿me
 * podéis llamar a las 9?”, “llámame el martes”, “¿y si la hacemos el jueves?”).
 */
const RX_SCHEDULE_PREFERENCE =
  /\b(?:mejor|prefiero|preferiria|puede ser|podria ser|podemos|podriamos|si puede ser|seria posible|en vez de|en lugar de|me (?:iria|vendria|va|viene|encaja|cuadra|pilla) mejor)\b|\b(?:me )?(?:podeis|puedes|podrias|podriais|puede|podria) llamar(?:me)?\b|\b(?:llamame|llamadme|llameme)\b|\by si la (?:hacemos|hago|dejamos|ponemos|pasamos)\b/;
/** El mensaje es solo un día u hora (“El viernes”, “Mañana por la tarde”, “El jueves a las 18:00”). */
const RX_ONLY_DAY =
  /^\s*(?:(?:pues|vale|ok|y|entonces|venga)[,.]?\s+)?(?:el |este |para el |para )?(?:hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?:\s+(?:por|de) la (?:manana|tarde|noche))?(?:\s+a las \d{1,2}(?:[:.]\d{2})?)?\s*[.!?]*\s*$/;
const RX_EXPLICIT_TIME = /\ba las \d{1,2}(?:[:.]\d{2})?\b|\b\d{1,2}:\d{2}\b/;
/** Habla de su entrenamiento o su alimentación, no de la llamada (“me va mejor entrenar por la mañana”). */
const RX_NOT_ABOUT_CALL = /\b(?:entrenar|entreno|entrenamientos?|comer|cenar|desayunar|correr|gimnasio|gym|ejercicio|deporte|dieta)\b/;
/** “Sí”, “vale, por favor”: respuesta afirmativa sin nada más. */
const RX_YES_ONLY = /^\s*(?:si|sip|vale|ok|okey|venga|claro|de acuerdo)\b(?:[\s,.!]*(?:si|por favor|porfa|gracias|claro|venga|vale))*[\s.!]*$/;

/** Directivas en las que el mensaje de KAI trata de la llamada: solo tras ellas un “sí” o un “vale” la aceptan. */
const CALL_DIRECTIVES = new Set(['propose_call', 'reassure_call', 'offer_slots', 'clarify_slot']);
/** Un “no” corto, sin más (“No”, “No, gracias”, “Que no”, “Paso”, “Mejor no”, “De momento no”). */
const RX_SHORT_NO =
  /^\s*(?:(?:pues|que|uf+|bueno|mm+|la verdad(?: es que)?|sinceramente)[,.!]?\s+)*(?:no|nop|nope|nah|paso|mejor no|de momento no|por ahora no|por el momento no|ahora no|ahora mismo no|creo que no|prefiero que no|no me encaja)(?:[\s,.!]+(?:no|gracias|muchas gracias|de momento|por ahora|por el momento|la verdad|lo siento|perdona|sorry))*[\s.!]*$/;
/**
 * “No” al recordatorio o a la confirmación de la llamada: un “no” suelto (“No”, “No, tengo médico”, “Pues no”) o que no
 * puede (“no me viene bien”, “no me es posible”); no “No se me olvida”, “No faltaré” ni “No te preocupes”.
 */
const RX_NO_TO_REMINDER =
  /^\s*(?:(?:pues|uf+|vaya|ay|lo siento|perdona|perdon|bueno|la verdad(?: es que)?|me temo que|creo que|al final)[,.!]?\s+)*(?:nop?e?(?:\s*$|\s*[^a-z0-9\s]|\s+(?:no|al final|lo siento|puedo|podre|podria|voy a poder|llego|creo|sera posible|me (?:va|viene|cuadra|encaja|pilla|es posible|da tiempo))\b))/;
/** Confirma que irá aunque empiece por “no” (“no te preocupes”, “no se me olvida”, “no faltaré”, “no, todo bien”). */
const RX_REMINDER_OK =
  /\bno (?:hay problema|pasa nada|te preocupes|problem)|todo (?:bien|perfecto|ok|correcto|en orden)|perfecto|genial|alli estare|ahi estare|estare (?:alli|ahi|puntual|conectad[oa])|cuenta conmigo|nos vemos|(?:se me|me) olvid|\bno (?:faltare|falto|fallo|fallare)\b|claro que no|sin problema|ningun problema|por supuesto|hablamos/;
/** Día (hoy, mañana, el lunes…) como palabra suelta, no “por la mañana”. */
const DAY_WORD = String.raw`(?:(?:el|este|para el|para)\s+)?(?<!\b(?:por la|de la|esta)\s)\b(?:pasado manana|manana|hoy|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b(?:\s+(?:por|de) la (?:manana|tarde|noche))?`;
/** Dice que ese día no puede (“el lunes no puedo”, “mañana no me va”, “el martes tampoco”, “no puedo el lunes”). */
const RX_DAY_REJECTED = new RegExp(
  `${DAY_WORD}(?:\\s*,?\\s*(?:ni|y|o)\\s+${DAY_WORD})*[\\s,]*(?:no (?:puedo|podre|podria|voy a poder|llego|me (?:va|viene|encaja|cuadra|pilla|sirve|vendria|iria)(?: bien)?)\\b|no(?=\\s*(?:[,.;!?…]|$|pero\\b|mejor\\b))|imposible\\b|tampoco\\b|me (?:va|viene|pilla) (?:fatal|mal)\\b|(?:lo )?tengo (?:complicado|imposible|fatal|lleno|ocupado)\\b|estoy (?:ocupad[oa]|liad[oa]|fuera)\\b)|\\bno (?:puedo|podre|podria|voy a poder|me (?:va|viene|encaja|cuadra|pilla|sirve)(?: bien)?)\\s+(?:ni\\s+)?${DAY_WORD}(?:\\s*,?\\s*(?:ni|y|o)\\s+${DAY_WORD})*`,
  'g',
);
/** Rechaza la oferta sin decir un día (“ninguna me va bien”, “¿no tienes otro día?”, “mejor otro día”). */
const RX_OFFER_REJECTED =
  /\b(?:ninguna|ninguno)\b(?! (?:duda|pregunta|problema))|\b(?:tienes|teneis|tendrias|tendriais|hay|habria|queda|quedan) (?:algun |alguna |algo )?(?:otro|otra|otros|otras|mas) (?:dia|dias|hora|horas|horario|horarios|hueco|huecos|opcion|opciones|fecha|fechas)\b|\b(?:mejor|prefiero|preferiria|puede ser|podria ser|seria|podemos|podriamos) (?:en )?(?:otro|otra) (?:dia|hora|horario|momento|fecha|semana)\b|\b(?:otro|otra) (?:dia|hora|horario|fecha) (?:mejor|si puede ser|porfa|por favor)\b|^\s*¿?\s*(?:y |o )?(?:otro|otra) (?:dia|hora|horario|fecha)\s*\?|\b(?:a|para) otro dia\b|\bno me (?:va|viene|encaja|cuadra|sirve|pilla) (?:bien )?(?:ninguna|ninguno|ese dia|esa hora|esas horas|ese horario|esos horarios)\b/;
/** No puede en lo que se le acaba de ofrecer (“no me viene bien”, “a esa hora no puedo”, “imposible”). */
const RX_PLAIN_SLOT_NO = /\bno (?:puedo|podre|podria|voy a poder|me (?:va|viene|encaja|cuadra|sirve|pilla|vendria|iria)(?: bien)?)\b|\bimposible\b|\bme (?:va|viene|pilla) (?:fatal|mal)\b/;
/** Desiste de mover la llamada (“mejor la dejamos como estaba”, “déjala como está”, “no hace falta moverla”). */
const RX_KEEP_BOOKED =
  /\b(?:la|lo) dejamos (?:como (?:esta|estaba|estaban|la teniamos|lo teniamos)|asi|igual|tal cual)\b|\bdejal[ao](?:\s*,?\s*(?:dejal[ao]|como (?:esta|estaba)|asi|igual|tal cual))*\s*(?:[,.!]|$)|\bdejal[ao] (?:como (?:esta|estaba)|asi|igual|tal cual)\b|\bmejor no (?:la|lo) (?:muevas|movemos|movais|cambies|cambiamos)\b|\bno (?:la|lo) (?:muevas|movais|cambies|cambieis|toques)\b|\bno hace falta (?:moverla|cambiarla|moverlo|cambiarlo|mover nada|cambiar nada)\b|\b(?:mantenemos|mantengo|me quedo con|mejor) (?:la de antes|la que (?:tenia|teniamos)|la (?:hora|cita|llamada) (?:de antes|que (?:tenia|teniamos))|el (?:dia|horario) (?:de antes|que (?:tenia|teniamos)))\b|\bal final (?:si )?(?:puedo|me (?:va|viene) bien)\b/;
/** Duda entre los horarios o los va a mirar (“no sé, déjame mirarlo”, “¿cuál me recomiendas?”, “esa”). */
const RX_ABOUT_SLOTS =
  /\b(?:dejame (?:mirarlo|verlo|pensarlo|mirar|ver|pensar)|lo miro|lo reviso|lo pienso|ya te (?:digo|confirmo)|te (?:digo|confirmo) (?:algo|luego|ahora|en un rato|mas tarde)|no (?:lo )?se|cual|esa|ese|opcion|opciones|horario|horarios|hueco|huecos|hora|horas)\b/;
/** “Vale”, “ok”, “sí”: un acuse sin más (tras la oferta, es una elección que hay que concretar). */
const RX_BARE_ACK = /^\s*(?:si|sip|vale|ok|okey|okay|venga|claro|bueno|de acuerdo|perfecto|genial|guay|dale|mm+|hm+)(?:[\s,.!]+(?:si|vale|ok|venga|claro|bueno|perfecto|genial))*[\s.!]*$/;
/**
 * Ya es cliente y escribe desde otro número o canal (“ya entreno contigo, ¿me pasas la rutina de esta semana?”): es para
 * el entrenador, no para el embudo. Solo frases inequívocas (no “si entreno contigo…” ni “mi rutina es sedentaria”).
 */
const RX_EXISTING_CLIENT =
  /\bya (?:soy|era) (?:tu |vuestr[oa] )?(?:cliente|alumn[oa])\b|\bsoy (?:tu|vuestr[oa]) (?:cliente|alumn[oa])\b|\bsoy cliente (?:tuy[oa]|vuestr[oa])\b|\bya entreno con(?:tigo| vosotros)\b|\b(?:llevo|estoy) (?:\S+ ){0,3}entrenando con(?:tigo| vosotros)\b|\bentreno con(?:tigo| vosotros) desde\b|\b(?:pasame|pasadme|me pasas|me pasais|mandame|mandadme|me mandas|me mandais|enviame|me envias|me puedes (?:pasar|mandar|enviar)) (?:mi (?:rutina|dieta|pauta|planificacion|plan|entreno|tabla)|la (?:rutina|dieta|pauta|planificacion|tabla) (?:de (?:esta|la) semana|de este mes|de hoy|de manana|nueva|actualizada)|el (?:plan|entreno) (?:de (?:esta|la) semana|de este mes|de hoy|de manana|nuevo|actualizado))\b/;
/** No responde a la pregunta del objetivo: risas, disculpas, “no sé, la verdad”, “quería info”… */
const RX_GOAL_FILLERS =
  /\b(?:(?:ja|je|ji)+|perdona|perdon|sorry|ok|okey|vale|ya|bueno|pues|nada(?: en (?:especial|concreto|particular))?|no (?:lo )?se|ni idea|no tengo ni idea|la verdad|hola|buenas|gracias|mm+|hm+|eh|ah|uf+|si|no|solo|queria|quiero|quisiera|pedir|mas|info|informacion|saber mas|que tal|lo que sea|cualquier cosa)\b/g;

/** Lo que ha contestado a “¿qué te gustaría conseguir?” no tiene contenido (solo muletillas, risas o “no sé”). */
function isGoalNonAnswer(n: string): boolean {
  return !n.replace(RX_GOAL_FILLERS, ' ').replace(/[^a-z0-9ñ\s]/g, ' ').trim();
}

/** Hora concreta del mensaje en formato HH:mm (“a las 9 de la mañana” → 09:00, “a las 6 de la tarde” → 18:00). */
function resolvePreferredTime(n: string): string | null {
  const m = /\ba las (\d{1,2})(?:[:.](\d{2}))?\b(\s*y media)?|\b(\d{1,2}):(\d{2})\b/.exec(n);
  if (!m) return null;
  let hour = Number(m[1] ?? m[4]);
  const minute = m[2] ? Number(m[2]) : m[3] ? 30 : m[5] ? Number(m[5]) : 0;
  if (hour < 12 && /\b(?:de|por) la (?:tarde|noche)\b/.test(n)) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const QUAL_PATTERNS: Record<string, RegExp> = {
  goal: /(perder|bajar|quitar(me)?|eliminar|soltar)\s+(?:de\s+)?(?:(?:unos|unas|algo de|un poco de|un par de|algun|algunos|al menos|por lo menos|mas de|como|entre|esos|estos|los|mis|la|el|mi)\s+)?((?:\d+(?:[.,]\d+)?(?:\s*(?:-|a|o)\s*\d+)?\s*)?(kg|kilos|kilitos)|peso|grasa|barriga|tripa|panza|michelines)|adelgazar|ganar (musculo|masa|fuerza)|definir|tonificar|ponerme (en forma|fuerte)|estar en forma|recomposicion|mejorar (mi )?(fisico|salud|forma)|verme mejor/,
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
export function matchOfferedSlot(
  n: string,
  allOffered: OfferedSlot[],
  tz: string,
  now: Date = new Date(),
  lastOfferIds: string[] = [],
  /** El último mensaje de KAI fue la oferta de horarios: solo entonces un número suelto (“18”) puede ser una elección. */
  opts: { offerIsLastMessage?: boolean } = {},
): string | null {
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
  const mentionsTime = /\d/.test(n) && (/(a las|las|:|\bh\b|\dh\b|horas|y media|\d (de|por) la (manana|tarde|noche))/.test(n) || onlyNumber);
  if (mentionsTime) {
    for (const m of times) {
      // Solo cuentan los números con forma de hora (“a las 10”, “18:00”, “10h”), no “tengo 18 años” ni “10 horas a la semana”.
      const partOfDayAfter = /^\s*(de|por) la (manana|tarde|noche)\b/.test(n.slice(m.index! + m[0].length));
      if (!onlyNumber && !partOfDayAfter && !/las|[:.]\d|\dh\b|y media/.test(m[0])) continue;
      // “5” como respuesta a otra pregunta (¿cuántos días entrenas?) no es una elección de horario.
      if (onlyNumber && !opts.offerIsLastMessage) return null;
      let hour = Number(m[1]);
      const minute = /y media/.test(m[0]) ? 30 : m[2] ? Number(m[2]) : null;
      const afternoon = /\b(de|por) la (tarde|noche)\b/.test(n);
      if (afternoon && hour < 12) hour += 12;
      // “a las 6” puede ser las 6:00 o las 18:00; “6” o “6:00” a secas, solo la hora exacta.
      const loose = !afternoon && /\blas\b/.test(m[0]) && hour <= 12;
      const matches = (pool: OfferedSlot[]) =>
        pool.filter((s) => {
          const local = DateTime.fromISO(s.start).setZone(tz);
          const hourOk = local.hour === hour || (loose && local.hour % 12 === hour % 12);
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
  // Un “vale” elige el único horario solo si responde a la oferta: tras “mejor la dejamos como estaba” y la respuesta
  // de KAI, un “vale, gracias” no mueve la llamada.
  if (offered.length === 1 && RX.affirm.test(n) && opts.offerIsLastMessage !== false) return offered[0].id;
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

  // 1) La respuesta directa a la última pregunta de KAI es la fuente más fiable… si de verdad la responde:
  // un mensaje que solo pregunta (“¿estoy hablando con un bot?”) no es una respuesta, y si habla claramente
  // de otra variable (“trabajo muchas horas y como fatal” cuando se le preguntó el objetivo) se guarda en esa.
  const sentences = raw.split(/(?<=[.!?\n])\s+/).map((t) => t.trim()).filter(Boolean);
  const onlyQuestion = sentences.length > 0 && sentences.every((t) => t.endsWith('?'));
  // El objetivo es lo que más pesa (resúmenes, mensajes, puntuación): solo se toma como objetivo lo que lo parece.
  const aboutOtherKey = Object.entries(QUAL_PATTERNS).some(([k, rx]) => k !== 'goal' && enabledKeys.has(k) && rx.test(n));
  // Muletillas, risas o “no sé, la verdad” no son un objetivo (la ficha lo mostraría como objetivo y como «Encaje: sí»).
  const answersLastAsked = lastAsked !== 'goal' || QUAL_PATTERNS.goal.test(n) || (!aboutOtherKey && !isGoalNonAnswer(n));
  // Ya es cliente (escribe desde otro número o canal): su mensaje es para el entrenador y no se cualifica.
  const existingClient = RX_EXISTING_CLIENT.test(n);
  // Tampoco responde a la pregunta quien pide hablar con una persona («prefiero hablar con David directamente»),
  // pregunta si es un bot o habla de la llamada («no quiero hacer la llamada»): la ficha mostraría eso como su
  // objetivo (y, con él, «Encaje: sí»).
  const aboutTheConversation =
    RX.humanRequest.test(n) ||
    asksForTrainer(n, input.biz.trainer.displayName) ||
    RX.asksIfBot.test(n) ||
    RX.callRequest.test(n) ||
    RX.declineCall.test(n) ||
    existingClient;
  if (
    lastAsked &&
    enabledKeys.has(lastAsked) &&
    !input.lead.qualification[lastAsked]?.value &&
    wordCount >= 2 &&
    !onlyQuestion &&
    answersLastAsked &&
    !aboutTheConversation &&
    !RX.price.test(n) &&
    !RX.optOut.test(n)
  ) {
    qualification[lastAsked] = { value: raw.trim().slice(0, 300), confidence: 0.75, updatedAt: nowIso };
  }
  // 2) Información que el lead da por iniciativa propia.
  for (const [key, rx] of Object.entries(QUAL_PATTERNS)) {
    if (!enabledKeys.has(key) || qualification[key] || existingClient) continue;
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
  let fitFromGoal = false;
  if (UNDERAGE.test(n)) signals.fit = 'no';
  else if (qualification.goal || input.lead.qualification.goal) {
    signals.fit = input.lead.signals.fit === 'no' ? 'no' : 'yes';
    fitFromGoal = true;
  }
  for (const key of ['urgency', 'commitment', 'budget', 'fit'] as const) {
    const lvl = signals[key];
    if (!lvl || !enabledKeys.has(key)) continue;
    if (key === 'fit' && fitFromGoal) {
      // Encaje deducido del objetivo, no de este mensaje: la prueba es el objetivo. Si no, la ficha mostraría como
      // «Encaje» cualquier frase posterior (“¿qué incluye el programa?”), y se reescribiría en cada mensaje. Si el
      // objetivo cambia en este mensaje (lo corrige o lo concreta), el encaje se actualiza con él.
      const newGoal = qualification.goal?.value.slice(0, 200);
      const prevFit = input.lead.qualification.fit;
      if (prevFit?.level === lvl && (!newGoal || prevFit.value === newGoal)) continue;
      const goal = qualification.goal?.value ?? input.lead.qualification.goal?.value ?? raw.trim();
      if (!qualification.fit) qualification.fit = { value: goal.slice(0, 200), confidence: 0.6, updatedAt: nowIso, level: lvl };
      continue;
    }
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
  const lastOfferIds = input.state.lastOfferIds ?? [];
  const offerIsLastMessage = Boolean(
    lastOutbound &&
      lastOfferIds.some((id) => {
        const slot = offered.find((o) => o.id === id);
        if (!slot) return false;
        const local = DateTime.fromISO(slot.start).setZone(tz);
        return lastOutbound.content.includes(local.toFormat('HH:mm')) || lastOutbound.content.includes(local.toFormat('H:mm'));
      }),
  );
  // “No” como respuesta al recordatorio o a la confirmación de la llamada: no puede ir. Las confirmaciones que empiezan
  // por “no” (“No se me olvida 😉”, “No faltaré, gracias”, “No te preocupes, allí estaré”) no cuentan.
  const lastKind = typeof lastOutbound?.metadata?.kind === 'string' ? lastOutbound.metadata.kind : '';
  const noToReminder =
    ['reminder_24h', 'reminder_1h', 'confirmation'].includes(lastKind) && wordCount <= 8 && RX_NO_TO_REMINDER.test(n) && !RX_REMINDER_OK.test(n);
  // Un día que dice que no puede (“el lunes no puedo”) nunca es su preferencia: se guarda aparte.
  const rejectedDays = (n.match(RX_DAY_REJECTED) ?? []).join(' ');
  const nPreference = rejectedDays ? n.replace(RX_DAY_REJECTED, ' ') : n;
  const excludedDate = rejectedDays ? resolvePreferredDate(rejectedDays, input.now, tz) : null;
  const preferredDate = resolvePreferredDate(nPreference, input.now, tz);
  const preferredPartOfDay = resolvePartOfDay(nPreference);
  const preferredTime = resolvePreferredTime(nPreference);
  // Con la llamada agendada, pedir otro día u hora con naturalidad (“mejor el miércoles”, “el jueves a las 18:00 me
  // iría mejor”, “¿me podéis llamar a las 9?”, o solo “el viernes”) es moverla. Solo cuenta en ese contexto (la
  // estrategia lo usa si hay cita y comprueba que no sea el mismo día y hora que ya tiene: “Vale, el lunes”).
  const asksOtherTime =
    Boolean(preferredDate || preferredPartOfDay || RX_EXPLICIT_TIME.test(nPreference)) &&
    (RX_SCHEDULE_PREFERENCE.test(nPreference) || RX_ONLY_DAY.test(nPreference)) &&
    !RX_NOT_ABOUT_CALL.test(n);
  // Desiste de moverla (“mejor la dejamos como estaba”): no es pedir otro horario.
  const keepsAppointment = RX_KEEP_BOOKED.test(n);
  const explicitReschedule = RX.reschedule.test(n) || noToReminder;
  const wantsReschedule = !keepsAppointment && (explicitReschedule || asksOtherTime);
  // Respuesta a «¿quieres que cancele la llamada o prefieres que la movamos?»: un “sí” o volver a decir que no la
  // quiere es cancelarla (pedir moverla ya lo detecta wantsReschedule).
  const askedCancelOrMove = lastOutbound?.metadata?.directive === 'confirm_cancel';
  const confirmsCancel = askedCancelOrMove && !wantsReschedule && (RX_YES_ONLY.test(n) || RX.declineCall.test(n));
  const wantsCancel = RX.cancel.test(n) || confirmsCancel;
  // ¿El último mensaje de KAI trataba de la llamada (la propuesta, sus dudas, los horarios)? Solo entonces un “sí” o
  // un “vale” la aceptan: un “vale” a otra pregunta (compromiso, una objeción, “seguimos en contacto”) no es aceptarla.
  // Si el mensaje no lleva directiva (lo escribió el entrenador, un seguimiento…), basta con que se propusiera.
  const lastDirective = typeof lastOutbound?.metadata?.directive === 'string' ? lastOutbound.metadata.directive : '';
  const lastText = normalize(lastOutbound?.content ?? '');
  const callLabel = normalize(input.biz.settings.callLabel ?? '');
  const lastMentionsCall = /llamada/.test(lastText) || Boolean(callLabel && lastText.includes(callLabel));
  const lastAboutCall = lastDirective
    ? CALL_DIRECTIVES.has(lastDirective) || (lastDirective !== 'continue_without_call' && lastMentionsCall)
    : Boolean(input.state.callProposedAt) || lastMentionsCall;
  // Un “no” corto a «¿te encaja la llamada?» es rechazarla (“No”, “No, gracias”, “Que no”, “Paso”).
  const askedAboutCall =
    ['propose_call', 'reassure_call'].includes(lastDirective) || (!lastDirective && lastMentionsCall && lastText.includes('?') && !offerIsLastMessage);
  const declinesAfterProposal = askedAboutCall && RX_SHORT_NO.test(n);
  // Pedir cancelar la llamada (“ya no quiero la cita”) también es no querer la llamada, nunca pedirla.
  const declinesCall = RX.declineCall.test(n) || wantsCancel || declinesAfterProposal;
  // Si el lead ya rechazó la llamada, un “vale” o un “me interesa” no la reabren: solo una petición explícita.
  const callDeclined = Boolean((input.state as SetterState).callDeclinedAt);
  const callWasProposed = !callDeclined && lastAboutCall;
  const positive = RX.affirm.test(n) || /quiero empezar|cuanto antes|adelante|vamos alla|me interesa|claro que si|me apunto|hagamosla|cuando quieras|me parece genial|me parece perfecto/.test(n);
  // Mencionar la llamada cuenta como un sí, salvo que vaya negada (“no tengo tiempo para una llamada”).
  const mentionsCall = RX.callYes.test(n) && !RX_CALL_NEGATED.test(n.replace(RX_NOT_A_NEGATION, ' '));
  const wantsCall =
    !declinesCall &&
    (callDeclined
      ? RX.callRequest.test(n)
      : RX.callRequest.test(n) || mentionsCall || (callWasProposed && positive) || Boolean(preferredDate && callWasProposed));

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

  // Horarios ofrecidos: ¿elige uno, los rechaza (“el lunes no puedo”, “ninguna me va bien”, “¿no tienes otro día?”) o
  // habla de otra cosa (“gracias”, otro tema)? Repetir los mismos horarios a quien no puede o ya no los quiere es un bucle.
  const selectedSlotId = matchOfferedSlot(n, offered, tz, input.now, lastOfferIds, { offerIsLastMessage });
  const latestOffer = lastOfferIds.map((id) => offered.find((o) => o.id === id)).filter((s): s is OfferedSlot => Boolean(s));
  const offeredDays = new Set(latestOffer.map((s) => DateTime.fromISO(s.start).setZone(tz).toISODate()));
  const rejectsOffer =
    latestOffer.length > 0 &&
    !selectedSlotId &&
    !keepsAppointment &&
    (Boolean(excludedDate && offeredDays.has(excludedDate)) || RX_OFFER_REJECTED.test(n) || (offerIsLastMessage && RX_PLAIN_SLOT_NO.test(nPreference)));
  const aboutSchedule =
    !keepsAppointment &&
    Boolean(
      selectedSlotId ||
        rejectsOffer ||
        ordinalChoice(n) !== null ||
        preferredDate ||
        excludedDate ||
        preferredPartOfDay ||
        RX_EXPLICIT_TIME.test(n) ||
        RX_SCHEDULE_PREFERENCE.test(n) ||
        RX.reschedule.test(n) ||
        RX_SLOT_REJECTION.test(n) ||
        RX_SLOT_HESITATION.test(n) ||
        RX_ABOUT_SLOTS.test(n) ||
        (offerIsLastMessage && RX_BARE_ACK.test(n)),
    );

  return {
    qualification,
    signals,
    memories,
    flags: {
      // “¿Estoy hablando con una persona real?” pregunta si es un bot; “quiero hablar con una persona real” pide a alguien.
      humanRequest: RX.humanRequest.test(n) || asksForTrainer(n, input.biz.trainer.displayName) || (/\bpersona real\b/.test(n) && !RX.asksIfBot.test(n)),
      asksIfBot: RX.asksIfBot.test(n),
      medical: RX.medical.test(n),
      angry,
      optOut: RX.optOut.test(n),
      asksPrice: RX.price.test(n),
      wantsCall,
      declinesCall,
      complexNegotiation: RX.negotiation.test(n),
      // Un cliente que escribe desde otro número o canal: se le pasa al entrenador (fuera del alcance de KAI).
      outOfScope: RX.outOfScope.test(n) || existingClient,
      technicalIssue: RX.technical.test(n),
      wantsReschedule,
      wantsCancel,
      asksQuestion: RX.question.test(n),
    },
    objectionKey,
    leadName: nameMatch?.[1] ?? null,
    goalSummary: qualification.goal?.value?.slice(0, 160) ?? null,
    preferredDate,
    preferredPartOfDay,
    selectedSlotId,
    summary: 'Análisis heurístico (modo simulación).',
    engine: 'heuristic',
    preferredTime,
    rescheduleImplicit: wantsReschedule && !explicitReschedule,
    excludedDate,
    rejectsOffer,
    keepsAppointment,
    aboutSchedule,
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
