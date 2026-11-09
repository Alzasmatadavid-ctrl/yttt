/**
 * Agentes que redactan los mensajes de KAI. Mismo contrato, dos implementaciones:
 *  - LlmSetterAgent: IA real con herramientas (agenda, reservas, escalado).
 *  - RuleBasedSetterAgent: motor de reglas (modo simulación, sin API key). Útil para probar
 *    todo el sistema de punta a punta y como referencia de comportamiento.
 */
import { DateTime } from 'luxon';
import { firstName, hashString, normalize, pick } from '../../lib/text.js';
import { BILLING_PERIOD_LABELS, formatMoney, questionCount, type ConversationState } from '../../lib/domain.js';
import { humanSlotLabel, leadZone, zonePlace } from '../../lib/time.js';
import type { ChatBlock, ChatMessage, LLMProvider, ToolResultBlock } from '../providers/types.js';
import { textOf } from '../providers/types.js';
import type { BusinessContext, ConversationContext, LeadContext } from '../context/context.js';
import { buildSetterStablePrompt, buildSetterTurnContext } from '../prompts/setter.prompt.js';
import { maxCharsFor } from '../prompts/tone.js';
import type { SetterToolbox } from '../tools/setter-tools.js';
import { recentOffer, slotStillBookable, type Directive, type SetterState } from './strategy.js';
import { env } from '../../config/env.js';

export type AgentMode = 'reply' | 'follow_up' | 'first_contact';

export interface AgentTurnInput {
  biz: BusinessContext;
  leadCtx: LeadContext;
  convCtx: ConversationContext;
  state: ConversationState;
  directive: Directive;
  now: Date;
  feedback: string[];
  toolbox: SetterToolbox | null;
  mode: AgentMode;
  extraNote?: string;
  /** Primer mensaje de KAI en la conversación (debe saludar y presentarse). */
  firstMessage?: boolean;
  /** Datos del seguimiento (paso, enfoque…) cuando mode = follow_up. */
  followUp?: { step: number; totalSteps: number; angle: string; hoursSilent: number };
}

export interface AgentTurnOutput {
  text: string;
  meta: Record<string, unknown>;
}

export interface SetterAgent {
  name: string;
  respond(input: AgentTurnInput): Promise<AgentTurnOutput>;
}

const NOTE = (text: string) => `⟦NOTA INTERNA DEL SISTEMA — no es un mensaje del lead⟧ ${text}`;

/** Convierte el historial del CRM en turnos user/assistant para la IA. */
export function historyToMessages(convCtx: ConversationContext, mode: AgentMode, closingNote: string): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (const m of convCtx.history) {
    const role = m.direction === 'inbound' ? 'user' : 'assistant';
    // Plantilla de WhatsApp: lo que el lead vio es la plantilla (no el texto que KAI habría escrito), así que
    // todavía no ha leído la presentación de KAI como asistente virtual.
    const text = m.contentType === 'template' ? `${m.content} (plantilla de WhatsApp: el lead aún no ha visto tu presentación)` : m.content;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role && typeof last.content === 'string') last.content = `${last.content}\n${text}`;
    else msgs.push({ role, content: text });
  }
  if (msgs.length === 0 || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: NOTE('Inicio de la conversación.') });
  if (mode !== 'reply' || msgs[msgs.length - 1].role === 'assistant') {
    msgs.push({ role: 'user', content: NOTE(closingNote) });
  }
  return msgs;
}

export class LlmSetterAgent implements SetterAgent {
  name = 'llm';
  constructor(private readonly provider: LLMProvider) {}

  async respond(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const followNote = input.followUp
      ? `El lead no responde desde hace unas ${Math.round(input.followUp.hoursSilent)} horas. Escribe el seguimiento ${input.followUp.step} de ${input.followUp.totalSteps}. Enfoque: ${input.followUp.angle}`
      : '';
    const system = [
      { text: buildSetterStablePrompt(input.biz), cache: true },
      {
        text: buildSetterTurnContext({
          biz: input.biz,
          leadCtx: input.leadCtx,
          channel: input.convCtx.conversation.channel,
          state: input.state,
          directive: input.directive,
          now: input.now,
          feedback: input.feedback,
          extraNote: [
            input.extraNote,
            followNote,
            input.firstMessage && input.directive.kind !== 'greet_and_ask' && input.directive.kind !== 'first_contact'
              ? 'Es tu PRIMER mensaje en esta conversación: empieza con un saludo breve y preséntate según las reglas de transparencia.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }),
      },
    ];
    const closing =
      input.mode === 'first_contact'
        ? 'El lead acaba de llegar y aún no ha escrito. Escribe el primer mensaje siguiendo el objetivo indicado.'
        : input.mode === 'follow_up'
          ? 'El lead no ha respondido. Escribe ahora el mensaje de seguimiento siguiendo el objetivo indicado.'
          : 'Escribe la siguiente respuesta al lead siguiendo el objetivo indicado.';
    const messages = historyToMessages(input.convCtx, input.mode, closing);
    const tools = input.mode === 'reply' && input.toolbox ? input.toolbox.definitions() : undefined;

    let iterations = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let model = '';
    while (iterations < 6) {
      iterations++;
      const res = await this.provider.chat({ tier: 'main', system, messages, tools, maxTokens: 4096, effort: env.AI_SETTER_EFFORT });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cacheReadTokens += res.usage.cacheReadTokens;
      model = res.model;
      if (res.stopReason === 'refusal') throw new Error('La IA rechazó generar la respuesta.');
      const calls = res.blocks.filter((b) => b.type === 'tool_call');
      if (calls.length === 0 || !input.toolbox) {
        if (res.stopReason === 'max_tokens') throw new Error('La respuesta de la IA quedó cortada.');
        return { text: cleanReply(textOf(res.blocks)), meta: { agent: this.name, model, iterations, usage } };
      }
      messages.push({ role: 'assistant', content: res.blocks as ChatBlock[], providerRaw: res.raw });
      const results: ToolResultBlock[] = [];
      for (const call of calls) {
        if (call.type !== 'tool_call') continue;
        const r = await input.toolbox.run(call.name, call.input);
        results.push({ type: 'tool_result', toolCallId: call.id, content: r.content, isError: r.isError });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new Error('La IA no terminó la respuesta tras varias herramientas.');
  }
}

const CLOSING_QUOTE: Record<string, string> = { '"': '"', '“': '”', '«': '»' };

/**
 * ¿El texto entero va entre un mismo par de comillas? Un mensaje que empieza y termina con dos citas
 * distintas (“"Poco a poco" es mi lema… "lo conseguí"”) no está envuelto: no se debe recortar.
 */
function isWrappedInQuotes(t: string): boolean {
  const close = CLOSING_QUOTE[t.charAt(0)];
  if (!close || t.length < 2 || !/["”»]$/.test(t)) return false;
  const open = t.charAt(0);
  const inner = t.slice(1, -1);
  if (open === close) return !inner.includes(open);
  let depth = 0;
  for (const ch of inner) {
    if (ch === open) depth++;
    else if (ch === close && --depth < 0) return false;
  }
  return depth === 0;
}

/** Limpia artefactos típicos (comillas envolventes, prefijos tipo “KAI:”). */
export function cleanReply(text: string): string {
  let t = text.trim();
  t = t.replace(/^(kai|asistente|respuesta|mensaje)\s*:\s*/i, '');
  if (isWrappedInQuotes(t)) t = t.slice(1, -1).trim();
  return t;
}

// ───────────────────────────── Motor de reglas (simulación) ─────────────────────────────

const ACKS: Record<string, string[]> = {
  goal: ['Genial, es un objetivo muy claro.', 'Perfecto, tiene todo el sentido.', 'Me gusta que lo tengas tan claro.'],
  current_situation: ['Vale, gracias por contármelo.', 'Entendido.', 'Te entiendo.'],
  problem: ['Entiendo, es algo muy habitual.', 'Tiene sentido, te entiendo.', 'Normal, le pasa a muchísima gente.'],
  motivation: ['Me encanta que tengas un motivo tan claro.', 'Eso es muy importante.', 'Qué buen motivo.'],
  previous_attempts: ['Vale, gracias por contármelo.', 'Entendido.', 'Ok, eso me ayuda a entenderte.'],
  frustration: ['Normal que te frustre.', 'Lo entiendo perfectamente.', 'Es muy frustrante, sí.'],
  urgency: ['Entendido.', 'Perfecto.', 'Vale, lo tengo en cuenta.'],
  commitment: ['Eso es clave.', 'Perfecto, eso marca la diferencia.', 'Genial.'],
  budget: ['Perfecto, gracias por la sinceridad.', 'Entendido.', 'Vale, gracias.'],
  default: ['Perfecto.', 'Entiendo.', 'Vale.'],
  // Ha dicho que no, duda o no ha respondido a lo preguntado: nada de “¡Genial!” ni de elogiar lo que no ha dicho.
  neutral: ['Entendido.', 'De acuerdo.', 'Vale.'],
};

/** Mensajes que no responden a nada: «ok», «vale», «ya», «jaja», «mmm»… (texto ya normalizado). */
const RX_BARE_ACK =
  /^(?:(?:ok(?:ey|i|a)?|okay|vale|va|venga|si|sip|ya|aja|aham?|bueno|claro|genial|perfecto|de acuerdo|entendido|guay|bien|ja(?:ja)*|je(?:je)*|ji(?:ji)*|mm+|hm+|ah|oh|eh)[\s,.!…]*)+$/;
/** Empieza diciendo que no o dudando: «No», «Que no», «Mmm, no estoy seguro», «Ni idea»… (texto ya normalizado). */
const RX_SAYS_NO = /^(?:(?:pues|que|uf+|buf+|mm+|hm+|bueno|la verdad(?: es que)?|sinceramente)[\s,.!…]+)*(?:no(?![a-zñ])|nop\b|nah\b|ni idea|tampoco|para nada|en absoluto|lo dudo)/;
/** Dice que no puede (un día, una hora): «el lunes no puedo», «a esa hora no me va bien», «imposible» (texto normalizado). */
const RX_CANT_MAKE = /\bno (?:puedo|podre|podria|voy a poder|llego|me (?:va|viene|encaja|cuadra|pilla|sirve))\b|\bimposible\b|\bme (?:va|viene|pilla) (?:fatal|mal)\b/;
/** Pregunta quién le escribe: «¿con quién hablo?», «¿quién eres?», «¿cómo te llamas?», «¿eres el entrenador?» (normalizado). */
const RX_ASKS_WHO =
  /\b(?:con quien (?:hablo|estoy hablando|tengo el gusto)|quien (?:eres|sois|me escribe|me habla|me contesta|me responde|es)|de parte de quien|como te llamas|como os llamais|como se llama usted|cual es tu nombre|eres (?:tu )?(?:el|la) (?:entrenador|entrenadora|coach))\b/;
/** Pide que le aclare o repita lo que se le acaba de preguntar: «¿a qué te refieres?», «¿me lo explicas mejor?» (normalizado). */
const RX_ASKS_CLARIFY =
  /\b(?:refieres|referis|repet\w*|repit\w*|no (?:te |lo )?entiendo|no (?:lo )?pillo|que quieres decir|que significa|como dices|por que me (?:lo )?preguntas|para que me (?:lo )?preguntas|a que viene|en que sentido|perdona que|explic\w* mejor|me lo (?:explicas|puedes explicar))\b/;
/** Cuándo (día u hora): «¿cuándo sería?», «¿es a las 18:00?», «¿era mañana?», «¿el miércoles?» (normalizado). */
const RX_WHEN =
  /\b(?:cuando|que dias?|que horarios?|horarios?|a que hora|que hora|a las|huecos?|disponibilidad|agenda|que fechas?|fecha|esta semana|semana que viene|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|hoy|el (?:dia )?\d{1,2}|mas (?:tarde|temprano|pronto)|otr[oa] (?:dia|hora|horario|momento))\b/;
/** Pregunta por la modalidad: «¿es online?», «¿presencial?», «¿dónde se entrena?» (no «¿estás online?»; normalizado). */
const RX_MODALITY =
  /(?<!\b(?:estas|estais|sigues|seguis) )\b(?:online|on line|presencial(?:es)?|en persona|a distancia|semipresencial|hibrido|en remoto|desde casa)\b|\bdonde (?:es|seria|entrenas|entrenais|entrenamos|estais|estas|se entrena)\b/;
/** Final de las respuestas honestas cuando KAI no tiene el dato (se quita al recordárselas: «Como te decía, …»). */
const UNSURE_TAIL = '; prefiero no decirte nada inexacto.';

/** Directivas en las que se responde antes a una pregunta del lead que el texto principal no cubre. */
const ANSWERS_QUESTIONS = ['greet_and_ask', 'ask_qualification', 'continue_without_call', 'reassure_call', 'post_booking', 'propose_call'];

/** Último recurso para no repetir literalmente un mensaje reciente: arranques neutros, válidos casi en cualquier contexto. */
const REPEAT_OPENERS = ['Entendido.', 'De acuerdo.', 'Vale.'];
const RX_LEADING_INTERJECTION = /^¡?(?:perfecto|genial|claro|vale|entendido|de acuerdo|sin problema|entiendo|gracias a ti)[.!]\s+/i;

/**
 * Si el mensaje coincide con uno de los últimos (los que compara el control de calidad), se cambia su arranque.
 * Los textos del motor de reglas son plantillas: sin esto, el control de calidad lo rechazaría siempre igual en los
 * tres intentos y la conversación se escalaría sin responder al lead.
 */
export function avoidRepeating(text: string, recentMessages: string[], maxChars: number, seed = 0): string {
  const key = (v: string) => normalize(v.replace(/\s+/g, ' ').trim());
  const recent = new Set(recentMessages.map(key));
  if (!recent.has(key(text))) return text;
  const body = text.replace(RX_LEADING_INTERJECTION, '');
  for (let i = 0; i < REPEAT_OPENERS.length; i++) {
    const opener = REPEAT_OPENERS[(Math.abs(seed) + i) % REPEAT_OPENERS.length];
    // Nada de «Entendido. Entendido, no te voy a insistir…».
    if (key(body).startsWith(key(opener).replace(/\.$/, ''))) continue;
    const candidate = `${opener} ${body}`;
    if (!recent.has(key(candidate)) && candidate.length <= maxChars) return candidate;
  }
  return text;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** “pasado mañana a las 10:00 o a las 17:00” en vez de repetir el día. */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  const parts = labels.map((l) => /^(.*) a las (\d{1,2}:\d{2})$/.exec(l));
  if (parts.every(Boolean) && parts.every((p) => p![1] === parts[0]![1])) {
    const times = parts.map((p) => `a las ${p![2]}`);
    return `${parts[0]![1]} ${times.slice(0, -1).join(', ')} o ${times[times.length - 1]}`;
  }
  return `${labels.slice(0, -1).join(', ')} o ${labels[labels.length - 1]}`;
}

/** Parte de un mensaje del motor de reglas: la primera opción es la completa; las siguientes, cada vez más cortas ('' = se omite). */
export interface MessagePart {
  key: string;
  options: string[];
}

/**
 * Une las partes de un mensaje y, si no cabe en el máximo de caracteres del tono, va acortando las opcionales en el
 * orden indicado (de la menos a la más importante) hasta que quepa. Así un mensaje compuesto (saludo, transparencia,
 * “qué incluye” y respuesta) no supera el límite: el control de calidad lo rechazaría siempre igual y se escalaría.
 * Cada paso es la clave de una parte (se acorta hasta su última opción) o [clave, nivel] (solo hasta ese nivel).
 */
export function fitParts(parts: MessagePart[], shortenOrder: (string | [string, number])[], maxChars: number): string {
  const level = parts.map(() => 0);
  const join = () =>
    parts
      .map((p, i) => p.options[level[i]] ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  let text = join();
  for (const step of shortenOrder) {
    if (text.length <= maxChars) break;
    const [key, upTo] = typeof step === 'string' ? [step, Infinity] : step;
    const i = parts.findIndex((p) => p.key === key);
    if (i < 0) continue;
    const last = Math.min(upTo, parts[i].options.length - 1);
    while (text.length > maxChars && level[i] < last) {
      level[i]++;
      text = join();
    }
  }
  return text;
}

/**
 * Presentación como asistente virtual para el PRIMER mensaje de KAI (transparencia, disclosureMode = first_message).
 * Vacía si el entrenador ha elegido no presentarse salvo que pregunten.
 */
export function disclosureIntro(biz: BusinessContext): string {
  const s = biz.settings;
  if (s.disclosureMode !== 'first_message') return '';
  const trainer = biz.trainer.displayName || 'el entrenador';
  const assistant = s.assistantName || 'KAI';
  return s.persona === 'trainer' ? `Te escribe ${assistant}, el asistente virtual de ${trainer}.` : `Soy ${assistant}, el asistente virtual del equipo de ${trainer}.`;
}

/** Saludo del primer mensaje de KAI: “¡Hola Laura! Soy KAI, el asistente virtual del equipo de Álex.” */
export function firstMessageGreeting(biz: BusinessContext, leadName: string | null | undefined): string {
  const t = biz.settings.tone;
  const greeting = t.formality <= 2 && t.energy >= 4 ? '¡Ey' : '¡Hola';
  const name = firstName(leadName);
  const intro = disclosureIntro(biz);
  return `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''}`;
}

export class RuleBasedSetterAgent implements SetterAgent {
  name = 'rules';

  async respond(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const { biz, leadCtx, directive, state } = input;
    const s = biz.settings;
    const lead = leadCtx.lead;
    const name = firstName(lead.name);
    const trainer = biz.trainer.displayName || 'el entrenador';
    const assistant = s.assistantName || 'KAI';
    const emoji = (e: string) => (s.tone.emojiUsage === 'none' ? '' : ` ${e}`);
    // Horas que lee el lead: si escribe desde otro país, con la zona del negocio y su hora (“18:00 (hora de España; en México, a las 10:00)”).
    const slotLabel = (start: string | Date) => humanSlotLabel(start, biz.business.timezone, input.now, { leadPhone: lead.whatsappId ?? lead.phone });
    const seed = hashString(`${lead.id}:${input.convCtx.history.length}:${input.feedback.length}`);
    const pendingText = input.convCtx.pendingInbound.map((m) => m.content.toLowerCase()).join(' ');
    // Felicitar o reconocer un acontecimiento solo la primera vez: repetirlo en cada mensaje suena a robot.
    const previousOut = input.convCtx.history.filter((m) => m.direction === 'outbound').map((m) => m.content.toLowerCase());
    const alreadySaid = (phrase: string) => previousOut.some((t) => t.includes(phrase));
    // Variantes: se evita repetir literalmente un mensaje anterior (el control de calidad lo rechazaría). Si ya se
    // usaron todas, al menos una que no esté entre los últimos mensajes (los que compara el control de calidad).
    const said = new Set(previousOut.map((t) => normalize(t)));
    const recent = new Set(previousOut.slice(-4).map((t) => normalize(t)));
    const fresh = (variants: string[]) => {
      const key = (v: string) => normalize(v.replace(/\s+/g, ' ').trim());
      const unused = variants.filter((v) => !said.has(key(v)));
      const notRecent = variants.filter((v) => !recent.has(key(v)));
      return pick(unused.length ? unused : notRecent.length ? notRecent : variants, seed);
    };
    // Igual, pero en el orden indicado: el texto habitual primero y las variantes solo si ya se usó.
    const firstFresh = (variants: string[]) => variants.find((v) => !said.has(normalize(v.replace(/\s+/g, ' ').trim()))) ?? fresh(variants);
    const event = eventPhrase(leadCtx.memories.find((m) => m.kind === 'event')?.content);
    const eventAck =
      /\b(me caso|boda|casarme)\b/.test(pendingText) && !alreadySaid('enhorabuena por la boda')
        ? `¡Enhorabuena por la boda!${emoji('🎉')}`
        : /\b(vacaciones|viaje)\b/.test(pendingText) && !alreadySaid('qué buen plan')
          ? '¡Qué buen plan!'
          : /\b(hij[oa]s?|beb[eé])\b/.test(pendingText) && !alreadySaid('qué bonito motivo')
            ? 'Qué bonito motivo.'
            : null;
    // Si el lead solo ha preguntado algo, no se “agradece la respuesta” (no ha respondido a nada).
    const leadOnlyAsked = Boolean(pendingText.trim()) && pendingText.trim().endsWith('?');
    // Si solo da las gracias (p. ej. tras confirmarle algo), se le contesta a eso y no con un “Entiendo.”.
    const np = normalize(pendingText);
    const onlyThanks = /^\s*(?:(?:vale|ok|genial|perfecto)[,.!]?\s+)?(?:muchas )?gracias\b[\s,.!]*(?:a ti|por todo)?[\s.!]*$/.test(np);
    // El reconocimiento depende de lo que ha contestado: un «ok» o un emoji no responden a nada (no se elogia lo que no
    // ha dicho) y un «no» o una duda no reciben un “¡Genial!”. Solo si el análisis guardó la variable preguntada se
    // usa el reconocimiento propio de esa variable.
    const bareAck = Boolean(np) && (RX_BARE_ACK.test(np) || !/[\p{L}\p{N}]/u.test(np));
    const leadSaysNo = RX_SAYS_NO.test(np);
    // No puede en lo que se le propone, aunque no empiece por «no» («El lunes no puedo», «a esa hora imposible»).
    const leadCantMake = leadSaysNo || RX_CANT_MAKE.test(np);
    const askedKey = state.lastAskedKey;
    const answeredAsked = Boolean(askedKey) && Boolean(lead.qualification[askedKey!]?.value || (lead.signals as Record<string, unknown>)[askedKey!]);
    // Vuelve a hacer la misma pregunta porque no la ha contestado: se reformula (repetirla tal cual suena a robot).
    const repeatsQuestion = Boolean(directive.questionKey) && directive.questionKey === askedKey && !answeredAsked;
    // Tema de salud con el escalado médico desactivado (nota del motor): el aviso sanitario ya se envió antes en la
    // conversación, así que se le recuerda que eso lo consulte con su médico (sin reconocimientos positivos). Si el
    // aviso se acaba de enviar en un mensaje aparte, no se repite.
    const lastMsg = input.convCtx.history[input.convCtx.history.length - 1];
    const medicalTopic = /tema de salud|consejos m[eé]dicos/i.test(input.extraNote ?? '');
    const medicalNoticeJustSent =
      /acabas de enviarle/i.test(input.extraNote ?? '') || (lastMsg?.direction === 'outbound' && ['medical_notice', 'medical_redirect'].includes(String(lastMsg.metadata?.kind ?? '')));
    const medicalNotes =
      medicalTopic && !medicalNoticeJustSent
        ? [
            fresh([
              'Sobre eso, lo mejor es que lo consultes con tu médico o con un profesional sanitario: yo no puedo aconsejarte sobre salud ni medicación.',
              'Eso tiene que valorarlo tu médico o un profesional sanitario; yo no puedo darte consejos de salud ni de medicación.',
            ]),
          ]
        : [];
    const ack =
      eventAck ??
      (leadOnlyAsked || medicalNotes.length
        ? ''
        : onlyThanks
          ? 'Gracias a ti.'
          : leadSaysNo || medicalTopic
            ? pick(ACKS.neutral, seed)
            : !askedKey
              ? bareAck
                ? ''
                : pick(ACKS.default, seed)
              : answeredAsked
                ? pick(ACKS[askedKey] ?? ACKS.default, seed)
                : bareAck
                  ? ''
                  : pick(ACKS.neutral, seed));
    // “¿Qué incluye?”, “¿cómo funciona?”: se responde con lo que el entrenador ha configurado.
    const svc0 = biz.services[0];
    const asksWhatIncludes = /\b(que|qu[eé]) (incluye|trae|tiene el (programa|plan|servicio))\b|\ben que consiste\b|\bcomo funciona\b|\bcomo (es|seria) (el|tu) (programa|plan|servicio|metodo)\b/.test(np);
    // De más a menos completa: si el mensaje no cabe, se citan menos elementos de lo que incluye.
    const includedItems = (svc0?.includes ?? []).slice(0, 3).map((i) => lowerFirst(i));
    const includesAnswers =
      asksWhatIncludes && svc0
        ? includedItems.length
          ? includedItems.map((_, k) => `${svc0.name} incluye ${listEs(includedItems.slice(0, includedItems.length - k))}.`)
          : [svc0.description ? `${svc0.name}: ${svc0.description.trim().replace(/[.!]*$/, '.')}` : `Te lo explica ${trainer} en detalle según tu caso.`]
        : [];
    const greeting = s.tone.formality <= 2 && s.tone.energy >= 4 ? '¡Ey' : '¡Hola';
    const intro = disclosureIntro(biz);
    const setterState = state as SetterState;
    const callDeclined = Boolean(setterState.callDeclinedAt);
    // Pregunta si es un bot: transparencia. Si este mensaje ya lleva la presentación (primer mensaje), no se repite
    // “soy KAI, el asistente…”. Las opciones siguientes, más cortas, se usan si el mensaje no cabe.
    const trainerFirst = firstName(biz.trainer.displayName) || trainer;
    const presentsNow = Boolean(intro) && (directive.kind === 'greet_and_ask' || Boolean(input.firstMessage));
    const botNotes = !input.extraNote?.includes('si eres un bot')
      ? []
      : presentsNow
        ? [
            `Y sí, te soy sincero: soy un asistente automatizado, y si prefieres hablar directamente con ${trainer} te lo paso.`,
            `Y sí, soy un asistente automatizado; si lo prefieres, te paso con ${trainerFirst}.`,
            'Y sí, soy un asistente automatizado.',
          ]
        : [
            `Te soy sincero: soy ${assistant}, el asistente automatizado del equipo de ${trainer}, y si prefieres hablar directamente con ${trainer} te lo paso.`,
            `Te soy sincero: soy ${assistant}, el asistente automatizado del equipo de ${trainer}; si lo prefieres, te paso con ${trainerFirst}.`,
            `Te soy sincero: soy ${assistant}, el asistente automatizado del equipo de ${trainer}.`,
          ];
    // Preguntas del lead (cada una desde su «¿»): «Quiero perder 10 kilos. ¿Es online o presencial?» → «¿Es online o presencial?».
    const leadQuestions = input.convCtx.pendingInbound
      .flatMap((m) => m.content.match(/[^.!?\n]*\?/g) ?? [])
      .map((q) => normalize(q.includes('¿') ? q.slice(q.lastIndexOf('¿')) : q).replace(/[¿?]/g, '').trim())
      .filter(Boolean);
    // Charla («¿qué tal?», «¿vale?», «¿en serio?»): no es una duda que haya que resolver.
    const smallTalk = (q: string) =>
      q.split(' ').length <= 2 || (q.split(' ').length <= 4 && /^(?:y )?(?:que tal|como estas|como va|como andas|y tu|en serio|de verdad|verdad|si|no|vale|ok|perdona|perdon|me explico|me entiendes|sabes|no crees|seguro|tu crees|y eso|hola)\b/.test(q));
    const leadAsks = leadQuestions.some((q) => !smallTalk(q));
    const booked = Boolean(leadCtx.upcomingAppointment);
    const callFacts = s.callDescription.trim() ? cap(s.callDescription.trim().replace(/[.!]*$/, '.')) : '';
    const unsure = booked
      ? `Eso te lo concreta ${trainerFirst} en la ${s.callLabel}${UNSURE_TAIL}`
      : `Eso te lo puede concretar mejor ${trainerFirst}${UNSURE_TAIL}`;
    // Pregunta quién le escribe: se le presenta aunque el entrenador haya elegido presentarse solo si se lo preguntan
    // (se lo están preguntando).
    const whoAmI = s.persona === 'trainer' ? `Te escribe ${assistant}, el asistente virtual de ${trainer}.` : `Soy ${assistant}, el asistente virtual del equipo de ${trainer}.`;
    const trainerKey = normalize(trainerFirst).replace(/[^a-z0-9ñ]/g, '');
    const meetingUrl = leadCtx.upcomingAppointment?.meetingUrl;
    /**
     * Respuesta breve y fiel a lo configurado para una pregunta que el texto principal no cubre: modalidad, duración del
     * programa o datos de la llamada. Sin dato, se le dice con honestidad que lo concreta el entrenador. null = no hace
     * falta (precio, “qué incluye”, si es un bot y horarios se responden aparte; la charla no es una duda).
     */
    const answerTo = (q: string): string | null => {
      // «¿Con quién es la llamada?», «¿quién me llamará?»: eso sí se sabe.
      if (/\bquien\b/.test(q) && /\b(?:llamada|videollamada|llama|llamara|llamaras|llamar|llamarme)\b/.test(q) && !/\bcomo (?:te|os|se) llam/.test(q)) return `La ${s.callLabel} es con ${trainer}.`;
      // «¿Con quién hablo?», «¿quién eres?», «¿cómo te llamas?», «¿eres Álex?»: se presenta (antes que la charla: «¿quién
      // eres?» es corta, pero no es charla). Si este mensaje ya lleva la presentación (o la nota de transparencia), no hace falta.
      if (RX_ASKS_WHO.test(q) || (trainerKey && new RegExp(`\\beres (?:tu )?${trainerKey}\\b`).test(q))) return presentsNow || botNotes.length ? null : whoAmI;
      // «¿Es online?» es corta, pero no es charla: se responde con la modalidad configurada.
      if (smallTalk(q) && !RX_MODALITY.test(q)) return null;
      // Pide que le aclare o repita lo que le acaba de preguntar («¿a qué te refieres?», «¿me repites la pregunta?»): el
      // texto principal se lo vuelve a plantear; «eso te lo concreta el entrenador» no tendría sentido.
      if (RX_ASKS_CLARIFY.test(q)) return null;
      // Si es un bot o si hay alguien al otro lado: lo responde la nota de transparencia (o el texto principal).
      if (/\b(bot|robot|ia|inteligencia artificial|persona real|una persona|humano|maquina|automatic\w*|automatizad\w*|asistente|chatgpt|hay alguien|alguien (?:ahi|detras))\b/.test(q)) return null;
      // Cuándo sería la llamada (día, hora, horarios) o si es tal día u hora («¿la llamada es a las 18:00?»): lo responde
      // el texto principal (horarios o la cita que ya tiene); «prefiero no decirte nada inexacto» no tendría sentido.
      if (/\b(llamada|videollamada|llam\w*)\b/.test(q) && RX_WHEN.test(q)) return null;
      if (/\b(llamada|videollamada|llamais|llamas|llamara|llamaras|llamarme|zoom|meet|telefono)\b/.test(q)) {
        if (/\b(cuesta|precio|coste|costo|pagar|paga|gratis|gratuit[ao]|cobr\w*)\b/.test(q)) return null;
        const asksDuration = /\bcuanto (?:dura|tiempo|rato)\b|\bduracion\b|\bcuantos minutos\b/.test(q);
        const asksPurpose = /\bpara que\b|\ben que consiste\b|\bde que (?:va|trata)\b|\bque (?:se hace|hacemos|haremos|vemos|veremos|se habla|hablamos|hablaremos)\b/.test(q);
        // La de reassure_call ya explica para qué es la llamada: solo falta la duración, si la pregunta.
        if (asksPurpose && directive.kind !== 'reassure_call')
          return asksDuration
            ? `La ${s.callLabel} dura ${s.callDurationMinutes} minutos y es para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos.`
            : `La ${s.callLabel} es para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos.${callFacts ? ` ${callFacts}` : ''}`;
        if (asksDuration) return `La ${s.callLabel} dura ${s.callDurationMinutes} minutos.`;
        if (asksPurpose) return null;
        // Ya tiene la llamada con enlace de videollamada: cómo se hace («¿me llamáis o llamo yo?») sí se sabe.
        if (meetingUrl) return `La ${s.callLabel} es por videollamada; te conectas a la hora acordada desde este enlace: ${meetingUrl}`;
        return callFacts || `Los detalles de la ${s.callLabel} te los concreta ${trainerFirst}${UNSURE_TAIL}`;
      }
      if (RX_MODALITY.test(q)) {
        const m = biz.trainer.modality;
        return m === 'presencial' ? 'Es presencial.' : m === 'hibrido' ? 'Es híbrido: una parte presencial y otra online.' : 'Es online.';
      }
      if (/\bcuanto (?:tiempo )?(?:dura|duraria)\b|\bduracion\b|\bcuantas semanas\b|\bcuantos meses\b/.test(q)) {
        return svc0?.durationWeeks ? `${svc0.name} dura ${svc0.durationWeeks} semanas.` : unsure;
      }
      if (asksWhatIncludes || /\b(cuentame|me cuentas|me explicas|explicame|info|informacion)\b/.test(q)) return null;
      if (/\b(cuanto|precio|precios|coste|costo|cuesta|cuestan|costaria|vale|valdria|cobras|cobrais|tarifa|cuota|pagar|pago|dinero|euros|presupuesto|gratis|gratuit[ao]|descuento|oferta)\b/.test(q)) return null;
      if (RX_WHEN.test(q)) return null;
      // Ayuda o encaje («¿me podéis ayudar?», «¿funcionaría conmigo?»): lo trata la estrategia (objeciones, llamada).
      if (/\b(ayud\w*|funcion\w*|sirve|serviria|merece la pena|vale la pena)\b/.test(q)) return null;
      return unsure;
    };
    // Vuelve a preguntar lo mismo: no se le reenvía la misma respuesta (avoidRepeating solo le pondría un «Vale.»
    // delante); se le recuerda con otras palabras, una distinta cada vez.
    const saidBefore = (t: string) => previousOut.some((p) => normalize(p).includes(normalize(t)));
    const answerVariants = (a: string) => {
      if (a.endsWith(UNSURE_TAIL)) {
        const core = lowerFirst(a.slice(0, -UNSURE_TAIL.length));
        return [a, `Como te decía, ${core}.`, `Siento no poder concretártelo yo: ${core}.`];
      }
      // Con un enlace al final, el recordatorio va delante (detrás del enlace, la coma o el punto lo romperían).
      if (/https?:\/\/\S+$/.test(a)) return [a, `Como te decía, ${lowerFirst(a)}`, `Lo dicho, ${lowerFirst(a)}`];
      const bare = a.replace(/[.!]+$/, '');
      return [a, `${bare}, como te decía.`, `${bare}; te lo confirmo de nuevo.`];
    };
    const notRepeated = (a: string) => {
      const variants = answerVariants(a);
      return variants[Math.min(variants.map(saidBefore).lastIndexOf(true) + 1, variants.length - 1)];
    };
    const answerParts =
      ANSWERS_QUESTIONS.includes(directive.kind) && !medicalNotes.length
        ? leadQuestions
            .map(answerTo)
            .filter((a): a is string => Boolean(a))
            .slice(0, 1)
            .map(notRepeated)
        : [];

    if (input.mode === 'follow_up' && input.followUp) {
      const goal = lead.goalSummary || lead.qualification.goal?.value;
      const goalRef = goal ? goalPhrase(goal) : null;
      const lastQuestion = directive.question;
      // Si el lead nunca ha contestado (formulario, anuncio), no hay “lo que me contaste”: se retoma el primer mensaje.
      const leadHasWritten = input.convCtx.history.some((m) => m.direction === 'inbound');
      const hello = name ? `Hola ${name}, ` : 'Hola, ';
      const { step, totalSteps } = input.followUp;
      let fu: string;
      if (totalSteps >= 2 && step >= totalSteps) {
        // La despedida, solo en el último seguimiento.
        fu = `${name ? `${name}, ` : ''}no quiero ser pesado${emoji('🙂')} Si en algún momento quieres retomar${goalRef ? ` lo de ${goalRef}` : ' la conversación'}, aquí estaré. ¡Mucho ánimo!`;
      } else if (step <= 1) {
        fu = leadHasWritten
          ? `${hello}me quedé pensando en lo que me contaste${goalRef ? ` de ${goalRef}` : ''}. ${lastQuestion ?? '¿Seguimos con ello?'}`
          : goalRef
            ? `${hello}te escribo de nuevo por lo de ${goalRef}, que nos indicaste al dejar tus datos. ${lastQuestion ?? '¿Sigues con ganas de ponerte con ello?'}`
            : `${hello}te escribo de nuevo por si se te pasó mi mensaje. ${lastQuestion ?? '¿Qué te gustaría conseguir?'}`;
      } else {
        fu = fresh([
          `${name ? `${name}, ` : ''}${event ? `teniendo en cuenta ${event}, ` : ''}sigo por aquí por si quieres retomarlo${goalRef ? ` y ver cómo plantear lo de ${goalRef}` : ''}. ${callDeclined ? '¿Te apetece que lo sigamos viendo por aquí?' : '¿Te viene bien que lo hablemos esta semana?'}`,
          `${hello}paso por aquí por si te ha surgido alguna duda${goalRef ? ` sobre lo de ${goalRef}` : ''}. ¿Te echo una mano con algo?`,
          `${hello}¿cómo lo llevas${goalRef ? ` con lo de ${goalRef}` : ''}? Si te apetece, lo retomamos cuando quieras.`,
        ]);
      }
      return { text: fu.replace(/\s+/g, ' ').trim(), meta: { agent: this.name } };
    }

    const q = directive.question ? cap(directive.question) : '';
    let text: string;
    /** Versiones más cortas del texto principal (de más a menos completa), por si el mensaje compuesto no cabe. */
    let shorter: string[] = [];
    switch (directive.kind) {
      case 'first_contact':
        {
          const goal = lead.goalSummary || lead.qualification.goal?.value;
          const goalRef = goal ? goalPhrase(goal) : null;
          const interest = goalRef ? `Vi que quieres ${goalRef}` : `Vi que te interesa ${biz.trainer.methodName ? `el método ${biz.trainer.methodName}` : 'entrenar con nosotros'}`;
          text = `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''} ${interest}${emoji('👋')} ${q || '¿Qué te gustaría conseguir?'}`;
        }
        break;
      case 'greet_and_ask':
        // El saludo, la presentación y el “Gracias por escribir” se añaden al final (ver fitParts).
        text = q || '¿Qué te gustaría conseguir exactamente?';
        break;
      case 'ask_qualification': {
        // No ha contestado a la pregunta anterior y se le vuelve a hacer: con otras palabras, no tal cual.
        const ask = repeatsQuestion && q ? fresh([`Y cuéntame, ${lowerQuestion(q)}`, `Para orientarte bien, ${lowerQuestion(q)}`, `Solo para entenderte mejor: ${lowerQuestion(q)}`]) : q;
        text = `${ack} ${ask}`.trim();
        if (ack && ask) shorter = [ask];
        break;
      }
      case 'handle_objection': {
        // La misma objeción por tercera vez: no se vuelve a sondear (sería insistir); se respeta y se deja la puerta abierta.
        // La estrategia lo marca (closesObjection) y el motor lo recuerda en el estado: después no se le vuelve a vender
        // la llamada ni se le escribe un seguimiento.
        const key = directive.objection?.key;
        if (directive.closesObjection || (key && (state.objectionsHandled ?? []).filter((k) => k === key).length >= 2)) {
          text = fresh([
            'Lo entiendo, y no quiero insistir. Si en algún momento quieres retomarlo, aquí me tienes.',
            'Te entiendo, de verdad, y lo respeto. Cuando te venga mejor, me escribes y lo vemos con calma.',
            'Entendido, no te voy a insistir. Si más adelante te encaja, estaré por aquí para lo que necesites.',
          ]);
          break;
        }
        // El ejemplo del entrenador, salvo que ya se usara (o que tenga más de una pregunta).
        const example = directive.objection?.exampleResponse?.trim();
        const generic = fresh([
          'Te entiendo perfectamente. ¿Qué es lo que más te frena ahora mismo?',
          'Tiene todo el sentido que te lo plantees. ¿Qué necesitarías para verlo más claro?',
          'Es normal tener dudas con esto. ¿Qué te gustaría saber antes de decidir nada?',
          'Lo entiendo, de verdad. ¿Hay algo concreto que te preocupe y que te pueda aclarar?',
          'Me parece lógico que lo pienses. ¿Qué te ayudaría a decidirlo con tranquilidad?',
        ]);
        if (example && questionCount(example) <= 1 && !said.has(normalize(example))) {
          text = example;
          shorter = [generic];
        } else text = generic;
        break;
      }
      case 'price_contextualize':
        text = `Claro. Antes de decirte qué opción tendría sentido para ti, quiero entender un poco tu situación para no recomendarte algo que no encaje. ${q || '¿Qué te gustaría conseguir exactamente?'}`;
        shorter = [`Claro. Para no recomendarte algo que no encaje, antes quiero entender tu situación. ${q || '¿Qué te gustaría conseguir exactamente?'}`];
        break;
      case 'share_price': {
        const svc = biz.services[0];
        // Si ya se le dio el precio y vuelve a preguntar, se le recuerda con otras palabras: repetir el mismo texto
        // haría que el control de calidad lo rechazara (y la conversación se escalaría sin responderle).
        const again = Boolean(state.priceShared);
        if (directive.withoutCall) {
          // No encaja: se le da el precio con honestidad, sin proponer la llamada.
          const price = svc && svc.priceCents > 0 ? `${formatMoney(svc.priceCents, svc.currency)} ${BILLING_PERIOD_LABELS[svc.billingPeriod] ?? ''}`.trim() : null;
          const variants = price
            ? [
                `Claro, te lo digo: ${svc!.name} cuesta ${price}. Por lo que me cuentas, igual ahora no es lo que más te encaja, pero prefiero que tengas la información.`,
                `Como te decía, ${svc!.name} son ${price}. Aun así, por lo que me cuentas, ahora mismo no creo que sea lo más adecuado para ti.`,
                `Te lo confirmo: son ${price}. Siendo sincero, por lo que me has contado, ahora mismo no creo que sea lo que más te conviene.`,
              ]
            : [
                `El precio lo concreta ${trainer} según el caso de cada persona. Por lo que me cuentas, igual ahora no es lo que más te encaja, pero prefiero ser sincero contigo.`,
                `Como te decía, el precio lo concreta ${trainer} según cada caso. Siendo sincero, por lo que me cuentas, ahora mismo no creo que sea lo más adecuado para ti.`,
              ];
          text = again ? fresh([...variants.slice(1), variants[0]]) : variants[0];
        } else if (!svc || svc.priceCents <= 0) {
          text = booked
            ? again
              ? fresh([
                  `Como te decía, el precio lo concreta ${trainer} según tu caso; en la ${s.callLabel} lo veréis en detalle.`,
                  `El importe depende de lo que necesites, así que te lo concreta ${trainer} en la ${s.callLabel}.`,
                ])
              : `El precio lo concreta ${trainer} según tu caso, porque depende de lo que necesites. Lo veréis en detalle en la ${s.callLabel}.`
            : callDeclined
              ? again
                ? fresh([
                    `Como te decía, el precio depende de lo que necesites y lo concreta ${trainer}. Cuéntame qué buscas y te oriento por aquí.`,
                    `El importe lo concreta ${trainer} según cada caso. Si me cuentas qué buscas, te oriento por aquí.`,
                  ])
                : `El precio lo concreta ${trainer} según tu caso, porque depende de lo que necesites. Si quieres, cuéntame qué buscas y te oriento por aquí.`
              : again
                ? fresh([
                    `Como te comentaba, el precio lo concreta ${trainer} según lo que necesites. ¿Quieres que lo veáis en la ${s.callLabel}?`,
                    `El importe depende de tu caso y te lo concreta ${trainer}. ¿Te parece si lo veis en una ${s.callLabel} de ${s.callDurationMinutes} minutos?`,
                  ])
                : `El precio lo concreta ${trainer} según tu caso, porque depende de lo que necesites. ¿Te parece si lo veis en una ${s.callLabel} de ${s.callDurationMinutes} minutos?`;
        } else {
          const items = svc.includes.slice(0, 3).map((i) => lowerFirst(i));
          const includes = items.length ? ` Incluye ${items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items[0]}.` : '';
          const price = `${formatMoney(svc.priceCents, svc.currency)} ${BILLING_PERIOD_LABELS[svc.billingPeriod] ?? ''}`.trim();
          // Sin la lista de lo que incluye, por si el mensaje no cabe.
          const withIncludes = (t: string) => {
            if (includes) shorter = [t.replace(includes, '')];
            return t;
          };
          // Ya tiene horarios ofrecidos (y aún no ha elegido): se retoman en vez de volver a proponerle la llamada.
          const offerLabels = recentOffer(state, input.now, biz.minNoticeMinutes ?? 0).map((o) => slotLabel(o.start));
          const offerAsk = offerLabels.length ? (offerLabels.length === 1 ? `¿Te viene bien ${offerLabels[0]}?` : `¿Te viene mejor ${joinLabels(offerLabels)}?`) : '';
          // «¿Y tiene algún coste?» justo después de proponerle la llamada (u ofrecerle horarios) pregunta por la llamada.
          // Que la llamada es gratis solo se dice si el entrenador lo ha puesto en su descripción; si no, se aclara
          // que el precio que se le da es el del programa.
          const asksCallCost =
            !booked &&
            !callDeclined &&
            leadQuestions.some(
              (lq) =>
                (/\b(llamada|videollamada|valoracion)\b/.test(lq) && /\b(cuesta|precio|coste|costo|pagar|paga|gratis|gratuit[ao]|cobr\w*)\b/.test(lq)) ||
                ((offerLabels.length > 0 || Boolean(state.callProposedAt)) &&
                  /^(?:y )?(?:(?:tiene|hay|lleva|supone) (?:algun |un )?(?:coste|costo|precio|pago)\b|(?:es|seria) (?:gratis|gratuit[ao])\b|(?:hay que|tengo que) pagar|se paga\b|cuesta algo\b)/.test(lq)),
            );
          const callFree = /\b(gratis|gratuit[ao]|sin coste|sin costo|no tiene coste|no cuesta)\b/.test(normalize(s.callDescription));
          if (booked)
            text = again
              ? fresh([
                  `Como te comentaba, ${svc.name} son ${price}. En la ${s.callLabel} lo veréis en detalle con ${trainer}.`,
                  `Te lo confirmo: ${svc.name} son ${price}. ${cap(trainer)} te lo explica todo en la ${s.callLabel}.`,
                ])
              : withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} En la ${s.callLabel} lo veréis en detalle con ${trainer}.`);
          else if (asksCallCost) {
            text = `${
              callFree
                ? `La ${s.callLabel} no tiene coste. Si después decidís trabajar juntos, ${svc.name} cuesta ${price}.`
                : `El precio que te puedo dar es el del programa: ${svc.name} cuesta ${price}. Lo de la ${s.callLabel} te lo concreta ${trainerFirst}; prefiero no decirte nada inexacto.`
            } ${offerAsk || '¿Qué te parece?'}`;
            shorter = [`${callFree ? `La ${s.callLabel} no tiene coste; el programa, ${price}.` : `El precio del programa es ${price}.`} ${offerAsk || '¿Qué te parece?'}`];
          } else if (state.priceShared)
            // Vuelve a preguntarlo: el mismo importe con otras palabras (con suficientes variantes para no repetir
            // ninguna de las últimas respuestas, que el control de calidad rechazaría).
            text = fresh(
              offerAsk
                ? [`Como te comentaba, ${svc.name} son ${price}. ${offerAsk}`, `Te lo confirmo: son ${price}. ${offerAsk}`, `Son ${price}, tal y como te decía. ${offerAsk}`]
                : [
                    `Como te comentaba, ${svc.name} son ${price}. ¿Qué duda te queda para ver si encaja contigo?`,
                    `Te lo confirmo: ${svc.name} son ${price}. ¿Hay algo de lo que incluye que quieras que te aclare?`,
                    `Son ${price}, tal y como te decía. Si quieres, te cuento lo que necesites para ver si encaja contigo.`,
                    `${svc.name} cuesta ${price}, como te comentaba. ¿Te ayudo con alguna otra duda?`,
                    `El precio es el que te decía: ${price}. Si te queda alguna duda, aquí me tienes.`,
                  ],
            );
          else if (callDeclined) text = withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} ¿Qué te parece?`);
          else if (offerAsk) text = withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} ${offerAsk}`);
          // La llamada ya se le propuso: no se le vuelve a presentar como si fuera nueva.
          else if (state.callProposedAt) text = withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} ¿Qué te parece?`);
          else text = withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} ¿Te gustaría verlo con ${trainer} en una ${s.callLabel} para ver si encaja contigo?`);
        }
        break;
      }
      case 'propose_call': {
        // La memoria guarda la frase del lead: se menciona el acontecimiento, no se cita literalmente.
        const lead_in = event ? `Teniendo en cuenta ${event}, ` : 'Por lo que me cuentas, ';
        text = `${lead_in}creo que tendría sentido que lo vierais en una ${s.callLabel} de ${s.callDurationMinutes} minutos con ${trainer} para revisar tu caso. ¿Te encaja?`;
        shorter = [`Creo que tendría sentido verlo en una ${s.callLabel} de ${s.callDurationMinutes} minutos con ${trainer}. ¿Te encaja?`];
        break;
      }
      case 'offer_slots':
      case 'reschedule': {
        if (!input.toolbox) throw new Error('Sin acceso a la agenda.');
        // Al mover la llamada «una hora más tarde» o «un poco antes»: horarios posteriores (o anteriores) a la que
        // tiene, empezando por ese mismo día. Ofrecerle uno anterior cuando pide más tarde no tendría sentido.
        const current = directive.kind === 'reschedule' ? leadCtx.upcomingAppointment : null;
        const pn = normalize(pendingText);
        const shift = !current ? null : /\bmas tarde\b|\bhoras? despues\b/.test(pn) ? 'later' : /\bmas (?:pronto|temprano)\b|\b(?:horas?|poco) antes\b/.test(pn) ? 'earlier' : null;
        const sameDay = current && shift ? DateTime.fromJSDate(current.startsAt).setZone(biz.business.timezone).toISODate() : null;
        // «¿Podemos pasarla a otro día?» sin decir cuál: desde el día siguiente al de la llamada que tiene (otra hora
        // de ese mismo día no es lo que pide).
        const otherDay = current && !shift && !directive.slotQuery?.date && /\b(?:otro dia|otra fecha|dia distinto)\b/.test(pn);
        const fromNextDay = otherDay && current ? DateTime.fromJSDate(current.startsAt).setZone(biz.business.timezone).plus({ days: 1 }).startOf('day').minus({ milliseconds: 1 }) : null;
        const r = await input.toolbox.run('get_available_slots', {
          date: directive.slotQuery?.date ?? sameDay ?? null,
          part_of_day: directive.slotQuery?.partOfDay ?? 'any',
          ...(current && shift === 'later' ? { later_than: current.startsAt.toISOString() } : {}),
          ...(current && shift === 'earlier' ? { earlier_than: current.startsAt.toISOString() } : {}),
          ...(fromNextDay ? { later_than: fromNextDay.toUTC().toISO() } : {}),
          // Días que ha dicho que no puede o cuyos horarios acaba de rechazar: no se le vuelven a ofrecer.
          ...(directive.slotQuery?.excludeDates?.length ? { exclude_dates: directive.slotQuery.excludeDates } : {}),
          // Horas que ha dicho que no puede («a las 10 no puedo», «no puedo antes de las 18:00»).
          ...(directive.slotQuery?.excludeTimes?.length ? { exclude_times: directive.slotQuery.excludeTimes } : {}),
          // Hora concreta que pide («a las 10»): los huecos más cercanos a ella.
          ...(directive.slotQuery?.time ? { near_time: directive.slotQuery.time } : {}),
        });
        const data = JSON.parse(r.content) as { slots?: { label: string }[]; note?: string; calendar_unavailable?: boolean };
        const labels = (data.slots ?? []).map((x) => x.label);
        // Acaba de rechazar los horarios ofrecidos («el lunes no puedo», «ninguna me va bien») o dice que no: sin “Perfecto”.
        const afterNo = leadCantMake || Boolean(directive.afterRejection);
        // Variantes: si vuelve a pedir la llamada (p. ej. tras cancelarla), los horarios pueden ser los mismos de antes y
        // el mismo texto se rechazaría por repetido.
        if (data.calendar_unavailable) {
          // El calendario conectado no responde: no es que no haya huecos. La conversación pasa al entrenador.
          text = `Ahora mismo no puedo consultar la agenda. Lo reviso con ${trainer} y te escribimos con opciones en cuanto podamos.`;
        } else if (labels.length === 0 && directive.afterRejection) {
          text = `Vaya, ahora mismo no me quedan otros huecos libres. Lo reviso con ${trainer} y te escribo con más opciones, ¿vale?`;
        } else if (labels.length === 0) {
          text = firstFresh([
            `Ahora mismo no veo huecos libres en la agenda. Lo reviso con ${trainer} y te escribo con opciones, ¿vale?`,
            `Ahora mismo no me aparecen huecos libres. Lo reviso con ${trainer} y te digo opciones en cuanto pueda, ¿vale?`,
          ]);
        } else {
          const one = labels.length === 1;
          const list = joinLabels(labels);
          const options = one ? `tengo ${labels[0]}. ¿Te viene bien?` : `tengo ${list}. ¿Cuál te viene mejor?`;
          const propose = one ? `te propongo ${labels[0]}. ¿Te encaja?` : `te propongo ${list}. ¿Cuál te encaja más?`;
          const free = one ? `tengo libre ${labels[0]}. ¿Te va bien?` : `tengo libre ${list}. ¿Qué opción prefieres?`;
          const noneThatDay = data.note
            ? [`Ese día no me quedan huecos, pero ${options}`, `Ese día lo tengo completo, pero ${propose}`, `Para ese día no me queda nada libre, pero ${free}`]
            : null;
          const openers = afterNo ? ['Sin problema.', 'Vale.', 'De acuerdo.'] : ['Perfecto.', 'Genial.', 'Vale.'];
          text =
            directive.kind === 'reschedule'
              ? firstFresh(
                  noneThatDay
                    ? noneThatDay.map((t) => `Sin problema, lo movemos. ${t}`)
                    : [`Sin problema, lo movemos. ${cap(options)}`, `Claro, la movemos. ${cap(propose)}`, `Vale, lo cambiamos. ${cap(free)}`],
                )
              : firstFresh(noneThatDay ?? [`${openers[0]} ${cap(options)}`, `${openers[1]} ${cap(propose)}`, `${openers[2]} ${cap(free)}`]);
        }
        break;
      }
      case 'reassure_call':
        // Solo ha preguntado si es un bot: no hay ninguna duda que calmar. Tras la nota de transparencia se le
        // vuelve a preguntar, sin presión, si le encaja la llamada.
        if (botNotes.length && questionCount(pendingText) <= 1) {
          text = `Y sobre la ${s.callLabel} de ${s.callDurationMinutes} minutos con ${trainerFirst}, ¿te encaja?`;
          shorter = [`¿Te encaja la ${s.callLabel} con ${trainerFirst}?`];
          break;
        }
        if (leadAsks) {
          // Acaba de plantear su duda: preguntarle «¿qué duda tienes?» sería no haberle escuchado. Se le responde
          // (parte 'answer') y se le vuelve a preguntar, sin presión, si le encaja la llamada.
          text = answerParts.length
            ? `Y sin ninguna prisa: la ${s.callLabel} es simplemente para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos. ¿Te encaja?`
            : `Claro, sin ninguna prisa. La ${s.callLabel} es simplemente para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos. ¿Te encaja?`;
          shorter = [`Sin prisa: la ${s.callLabel} es para que ${trainer} conozca tu caso y veáis si encaja. ¿Te encaja?`, `¿Te encaja la ${s.callLabel} con ${trainerFirst}?`];
          break;
        }
        text = `Claro, sin ninguna prisa. La ${s.callLabel} es simplemente para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos. ¿Qué duda te gustaría resolver antes?`;
        shorter = [
          `Claro, sin prisa. La ${s.callLabel} es para que ${trainer} conozca tu caso y veáis si encaja. ¿Qué duda te gustaría resolver antes?`,
          `Claro, sin prisa. ¿Qué duda te gustaría resolver antes de la ${s.callLabel}?`,
        ];
        break;
      case 'clarify_slot': {
        // Lead de otro país que dice “a las 11” y en cada zona es un horario distinto: se le pregunta solo eso, con el
        // nombre de cada país (“de aquí” sería ambiguo para él). Nada de “¡Genial!”: aún no ha elegido.
        const zoneCountry = directive.ambiguousTime ? leadZone(lead.whatsappId ?? lead.phone, biz.business.timezone, input.now)?.country : null;
        if (directive.askZoneOnly && zoneCountry) {
          // Pide una hora que no se le ofreció: solo de qué país es (sin la hora en cifras: no ha salido de la agenda).
          const ours = zonePlace(biz.business.timezone);
          text = fresh([
            `Para buscarte hueco a esa hora, ¿me la dices en hora de ${ours} o en hora de ${zoneCountry}?`,
            `Claro, lo miro. Solo una cosa por la diferencia horaria: ¿esa hora es la de ${ours} o la de ${zoneCountry}?`,
          ]);
          break;
        }
        if (directive.ambiguousTime && zoneCountry) {
          const ours = `las ${directive.ambiguousTime} de ${zonePlace(biz.business.timezone)}`;
          const theirs = `las ${directive.ambiguousTime} de ${zoneCountry}`;
          text = fresh([
            `Para no liarnos con la diferencia horaria: ¿te refieres a ${ours} o a ${theirs}?`,
            `Solo para asegurarme, ¿hablas de ${ours} o de ${theirs}?`,
            `Por la diferencia horaria, quiero asegurarme: ¿son ${ours} o ${theirs}?`,
          ]);
          break;
        }
        const ids = state.lastOfferIds ?? [];
        // Etiquetas recalculadas ahora (la oferta pudo hacerse ayer: su “mañana” hoy es “hoy”).
        const labels = ids
          .map((id) => (state.offeredSlots ?? []).find((x) => x.id === id))
          .filter((x): x is NonNullable<typeof x> => Boolean(x) && slotStillBookable(x!.start, input.now, biz.minNoticeMinutes ?? 0))
          .map((x) => slotLabel(x.start));
        if (!labels.length) {
          text = '¿Qué día y franja te vendría mejor para la llamada?';
          break;
        }
        const options = joinLabels(labels);
        // Si duda, dice que no o que no puede algún día, nada de “¡Genial!”.
        const variants = leadCantMake
          ? [`Sin problema. Dime si te encaja ${options} o si prefieres que miremos otro día.`, `Vale, sin prisa. Cuando lo mires, dime si te va ${options} o prefieres otro día.`]
          : [
              `¡Genial! Entonces, ¿te va mejor ${options}?`,
              `Perfecto. ¿Cuál de las opciones te encaja más: ${options}?`,
              `Genial. Dime cuál prefieres, ${options}, o si te viene mejor otro día.`,
            ];
        text = fresh(variants);
        break;
      }
      case 'book_slot': {
        if (!input.toolbox || !directive.slotId) throw new Error('Sin acceso a la agenda.');
        const tool = leadCtx.upcomingAppointment ? 'reschedule_call' : 'book_call';
        // Si la reserva ya se hizo en este turno (p. ej. al reintentar la redacción), no se repite.
        const done = input.toolbox.records.find((x) => x.ok && (x.name === 'book_call' || x.name === 'reschedule_call'));
        const r = done ? { content: JSON.stringify(done.result), isError: false } : await input.toolbox.run(tool, { slot_id: directive.slotId });
        const data = JSON.parse(r.content) as { error?: string; label?: string; booking_url?: string; meeting_url?: string | null; mode?: string; calendar_unavailable?: boolean };
        if (r.isError && data.calendar_unavailable) {
          // El calendario conectado no responde: el hueco no se ha ocupado, es que no se puede reservar ahora.
          text = `Vaya, ahora mismo no puedo acceder a la agenda para confirmártelo. Se lo paso a ${trainer} para que lo revise y te escriba enseguida.`;
        } else if (r.isError) {
          const again = await input.toolbox.run('get_available_slots', { date: null, part_of_day: 'any' });
          const slots = (JSON.parse(again.content) as { slots?: { label: string }[] }).slots ?? [];
          text = slots.length
            ? `Vaya, ese hueco se acaba de ocupar. Tengo ${joinLabels(slots.map((x) => x.label))}. ¿Cuál te viene mejor?`
            : `Vaya, ese hueco se acaba de ocupar. Lo reviso con ${trainer} y te digo opciones, ¿vale?`;
        } else if (data.mode === 'link') {
          text = `Genial. Para confirmar ${data.label}, resérvalo aquí en un clic: ${data.booking_url}`;
        } else {
          // Sin prometer un recordatorio: depende de la configuración del entrenador y de lo que permita el canal.
          text = `¡Hecho! Te apunto para ${data.label}${emoji('🙌')}${data.meeting_url ? ` Este es el enlace de la llamada: ${data.meeting_url}` : ''} Si te surge algo, me lo dices por aquí y la movemos.`;
        }
        break;
      }
      case 'post_booking': {
        // Neutro: no da por hecho que el lead ha dicho que sí a nada.
        const appt = leadCtx.upcomingAppointment;
        const when = appt ? slotLabel(appt.startsAt) : null;
        if (!when) text = fresh(['Vale, cualquier cosa me dices.', 'Entendido. Aquí me tienes para lo que necesites.']);
        else if (botNotes.length) text = `La ${s.callLabel} sigue en pie ${when}; si tienes que moverla, me dices.`;
        else if (directive.keepsBooking)
          // Desiste de moverla («déjala como está») o confirma el día que ya tiene: se le confirma, sin más.
          text = fresh([
            `Perfecto, la dejamos como estaba: ${when}. Si te surge algo, me lo dices por aquí.`,
            `De acuerdo, mantenemos la ${s.callLabel} ${when}. Cualquier cosa, me dices.`,
          ]);
        else if (onlyThanks)
          text = fresh([
            `Gracias a ti. Recuerda: la ${s.callLabel} es ${when}. Si te surge algo, me lo dices por aquí.`,
            `A ti. La ${s.callLabel} sigue en pie ${when}; cualquier cosa, me dices.`,
          ]);
        else if (leadAsks)
          // Acaba de preguntar algo (se le responde antes): nada de “cualquier duda, me la preguntas”. Si la respuesta ya
          // nombra la llamada («La llamada de valoración dura 30 minutos.»), no se repite su nombre.
          text = fresh(
            answerParts.some((a) => normalize(a).includes(normalize(s.callLabel)))
              ? [`Sigue en pie ${when}; si tienes que moverla, me dices.`, `La tienes ${when}; si necesitas moverla, me lo dices por aquí.`]
              : [
                  `La ${s.callLabel} sigue en pie ${when}; si tienes que moverla, me dices.`,
                  `Recuerda que la ${s.callLabel} es ${when}; si necesitas moverla, me lo dices por aquí.`,
                ],
          );
        else
          text = fresh([
            `Entendido. Si te surge algo y necesitas mover la ${s.callLabel} ${ofLabel(when)}, dímelo sin problema.`,
            `Aquí estoy para lo que necesites. La ${s.callLabel} sigue en pie ${when}; si tienes que moverla, me dices.`,
            // A un «vale» u «ok» no se le contesta «Gracias por escribir».
            ...(bareAck ? [] : [`Gracias por escribir. Cualquier duda antes de la ${s.callLabel} ${ofLabel(when)}, me la preguntas por aquí.`]),
          ]);
        shorter = ['Cualquier otra duda, me dices.'];
        break;
      }
      case 'confirm_cancel': {
        const appt = leadCtx.upcomingAppointment;
        const when = appt ? ` ${ofLabel(slotLabel(appt.startsAt))}` : '';
        // Dos variantes: si vuelve a decir que no la quiere más adelante, no se repite el mismo mensaje.
        text = fresh([
          `Sin problema. ¿Quieres que cancele la ${s.callLabel}${when} o prefieres que la movamos a otro día?`,
          `Entendido. ¿Prefieres que cancele la ${s.callLabel}${when} o que busquemos otro día?`,
        ]);
        break;
      }
      case 'cancel_booking': {
        if (!input.toolbox) throw new Error('Sin acceso a la agenda.');
        const done = input.toolbox.records.find((x) => x.ok && x.name === 'cancel_call');
        const r = done ? { content: JSON.stringify(done.result), isError: false } : await input.toolbox.run('cancel_call', { reason: 'El lead pidió cancelar la llamada por mensaje.' });
        const data = JSON.parse(r.content) as { cancelled?: boolean; note?: string };
        if (data.cancelled) {
          text = `Hecho, he cancelado la ${s.callLabel}. Si más adelante quieres retomarlo, escríbeme por aquí sin problema.`;
        } else if (!r.isError && data.note) {
          text = `Puedes cancelarla en un clic desde el enlace del email de confirmación que te llegó. Si más adelante quieres retomarlo, escríbeme por aquí.`;
        } else {
          await input.toolbox.run('request_human', { reason: 'technical_issue', detail: 'El lead pidió cancelar su llamada y no se pudo cancelar automáticamente.' });
          text = `Vaya, no he podido cancelarla ahora mismo. Se lo paso a ${trainer} para que lo revise y te confirme.`;
        }
        break;
      }
      case 'disqualify_kindly':
        // La primera vez, siempre la explicación honesta de por qué no encaja. Después, despedidas breves (el
        // “Gracias a ti.” solo si el lead ha dado las gracias).
        text =
          input.convCtx.history.some((m) => m.direction === 'outbound' && m.metadata?.directive === 'disqualify_kindly') || alreadySaid('no sería lo más adecuado para ti')
            ? fresh(
                onlyThanks
                  ? ['Gracias a ti. Si en algún momento cambia tu situación, aquí estaré para ayudarte.', 'A ti. Te deseo lo mejor, y si más adelante encaja, aquí me tienes.']
                  : [
                      'Entendido. Te deseo lo mejor, y si más adelante encaja, aquí me tienes.',
                      'Lo dicho: si en algún momento cambia tu situación, aquí estaré para ayudarte. Mucho ánimo.',
                    ],
              )
            : 'Gracias por contármelo con tanta sinceridad. Por lo que me cuentas, ahora mismo creo que esto no sería lo más adecuado para ti, y prefiero ser honesto contigo. Te deseo mucho ánimo.';
        {
          const brief = 'Gracias por contármelo. Siendo sincero, ahora mismo creo que esto no sería lo más adecuado para ti. Mucho ánimo.';
          if (text.length > brief.length) shorter = [brief];
        }
        break;
      case 'continue_without_call':
        if (directive.justDeclined) {
          text = q ? `Sin problema, lo vamos hablando por aquí. ${q}` : 'Sin problema, lo vamos hablando por aquí. Cualquier duda, me dices.';
          if (q) shorter = [`Sin problema. ${q}`];
        } else {
          text = leadAsks
            ? // Acaba de preguntar algo (se le responde antes): no se le invita a preguntar como si no lo hubiera hecho.
              fresh(['Si quieres saber algo más, aquí me tienes.', 'Cualquier otra cosa que quieras saber, me dices.'])
            : onlyThanks
              ? fresh(['Gracias a ti. Aquí me tienes para lo que necesites.', 'A ti. Cualquier cosa, me escribes por aquí.'])
              : fresh([
                'Perfecto. Si te surge cualquier duda sobre cómo trabajamos, pregúntame por aquí.',
                'Genial. Cualquier cosa que quieras saber, me la preguntas por aquí sin problema.',
                'Vale. Aquí me tienes para lo que necesites.',
              ]);
        }
        break;
      default:
        text = q || 'Perfecto, cuéntame.';
    }
    if (directive.kind === 'first_contact') return { text: text.replace(/\s+/g, ' ').trim(), meta: { agent: this.name } };
    // Mensaje compuesto: [saludo y presentación] [gracias por escribir] [transparencia si pregunta si es un bot]
    // [recordatorio de salud] [respuesta a su pregunta] [qué incluye] [texto principal]. Si no cabe en el máximo del
    // tono, se acortan las partes opcionales.
    const greets = directive.kind === 'greet_and_ask' || Boolean(input.firstMessage);
    const answersIncludes = ['greet_and_ask', 'ask_qualification', 'continue_without_call', 'reassure_call', 'post_booking', 'propose_call'].includes(directive.kind);
    const parts: MessagePart[] = [
      { key: 'hello', options: greets ? [`${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''}`] : [] },
      { key: 'thanks', options: directive.kind === 'greet_and_ask' ? [`Gracias por escribir${emoji('👋')}`, ''] : [] },
      // Si pregunta si es un bot, se le responde con transparencia en cualquier tipo de mensaje (no solo al cualificar).
      { key: 'bot', options: botNotes },
      { key: 'medical', options: medicalNotes },
      { key: 'answer', options: answerParts.length ? [...answerParts, ''] : [] },
      { key: 'includes', options: answersIncludes ? includesAnswers : [] },
      { key: 'main', options: [text, ...shorter] },
    ];
    const maxChars = maxCharsFor(s.tone);
    // La oferta de pasarle con el entrenador es lo último que se quita de la nota de transparencia.
    const composed = fitParts(parts, ['thanks', ['bot', 1], 'includes', 'main', 'answer', 'bot'], maxChars);
    return { text: avoidRepeating(composed, previousOut.slice(-4), maxChars, seed), meta: { agent: this.name } };
  }
}

const EVENT_PHRASES: [RegExp, string][] = [
  [/\bboda\b|\bme caso\b|\bcasarme\b/, 'tu boda'],
  [/comunion/, 'la comunión'],
  [/bautizo/, 'el bautizo'],
  [/graduacion/, 'tu graduación'],
  [/crucero/, 'el crucero'],
  [/vacaciones/, 'tus vacaciones'],
  [/viaje/, 'tu viaje'],
  [/despedida/, 'la despedida'],
];

/** “Me caso en junio, ¿sabes?” → “tu boda”: se menciona el acontecimiento sin citar al lead (ni sus preguntas). */
export function eventPhrase(memory: string | null | undefined): string | null {
  if (!memory) return null;
  const n = normalize(memory);
  return EVENT_PHRASES.find(([rx]) => rx.test(n))?.[1] ?? null;
}

/** “a, b y c” */
function listEs(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : (items[0] ?? '');
}

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1).replace(/[.!]+$/, '');
}

function trimGoal(goal: string) {
  return goal.length > 60 ? `${goal.slice(0, 57).trimEnd()}…` : goal;
}

/** Muletillas del principio de una respuesta: «Hola, pues mira, …», «Sí, …». */
const RX_GOAL_FILLER = /^(?:¡?hola|buenas|pues|bueno|mira|yo|vale|ok|s[ií]|la verdad(?: es que)?|sinceramente|a ver)(?=[\s,!.:]|$)[\s,!.:]*/i;
/** Verbo de deseo del principio: «quiero», «me gustaría», «mi objetivo es»… */
const RX_GOAL_WISH =
  /^(?:(?:lo que )?(?:me gustar[ií]a|quiero|quisiera|quer[ií]a|busco|necesito|pretendo|deseo|me encantar[ií]a|estoy buscando|intento)(?: es)?|(?:mi|el) (?:objetivo|meta|reto) (?:es|ser[ií]a))\s+/i;
/** Empieza contando su situación («tengo…», «estoy…»): no se puede citar como “lo de …”. */
const RX_GOAL_NOT_QUOTABLE = /^(?:tengo|estoy|soy|llevo|peso|mido|he|era|estaba|ten[ií]a|me (?:siento|veo|cuesta|sobra|sobran))\b/i;

/**
 * Objetivo listo para citarlo en un mensaje («lo de …», «Vi que quieres …»), o null si no se puede citar con
 * naturalidad. Se guarda a menudo como la respuesta entera del lead: “Quiero perder unos 10 kilos, sobre todo la
 * barriga” → “perder unos 10 kilos” (sin el verbo de deseo ni muletillas, y hasta la primera coma o punto).
 */
export function goalPhrase(goal: string): string | null {
  let g = goal.trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 4 && RX_GOAL_FILLER.test(g); i++) g = g.replace(RX_GOAL_FILLER, '');
  g = g.replace(RX_GOAL_WISH, '');
  // Hasta la primera coma o punto (no los decimales: “1,5 kilos”).
  g = g.split(/,(?!\d)|\.(?!\d)|[;:!?¡¿()\n]/)[0].trim();
  if (g.length < 4 || RX_GOAL_NOT_QUOTABLE.test(g)) return null;
  const quoted = toSecondPerson(g);
  // Le queda algo en primera persona que no se sabe pasar a segunda («el peso que gané»): mejor no citarlo que mezclar personas.
  if (RX_FIRST_PERSON_LEFT.test(normalize(quoted))) return null;
  return lowerFirst(trimGoal(quoted));
}

/** Verbos en primera persona que se pasan a segunda al citar el objetivo («la barriga que tengo» → «que tienes»). */
const FIRST_TO_SECOND: Record<string, string> = {
  tengo: 'tienes',
  estoy: 'estás',
  soy: 'eres',
  llevo: 'llevas',
  puedo: 'puedes',
  quiero: 'quieres',
  necesito: 'necesitas',
  siento: 'sientes',
  veo: 'ves',
  hago: 'haces',
  he: 'has',
  era: 'eras',
  estaba: 'estabas',
  tenía: 'tenías',
  tenia: 'tenías',
};
/** Palabras acabadas en -arme/-erme/-irme que no son un verbo con «me» detrás (texto ya en minúsculas). */
const NOT_ENCLITIC = new Set(['firme', 'duerme', 'enferme', 'afirme', 'confirme', 'arme', 'desarme']);
/** Primera persona que no se pasa a segunda (pasados, «peso 90 kilos», «yo»): el objetivo no se cita (normalizado). */
const RX_FIRST_PERSON_LEFT = /\b(?:yo|gane|engorde|perdi|hice|tuve|pude|quise|empece|intente|mido|peso \d+)\b/;

/**
 * Lo dijo el lead, pero lo cita KAI: «ponerme en forma» → «ponerte en forma», «perder mi barriga» → «perder tu
 * barriga», «que me quede bien la ropa» → «que te quede bien la ropa», «jugar con mis hijos sin cansarme» → «jugar
 * con tus hijos sin cansarte», «la barriga que tengo» → «la barriga que tienes».
 */
function toSecondPerson(g: string): string {
  const swap: Record<string, string> = { me: 'te', mi: 'tu', mis: 'tus', mí: 'ti', conmigo: 'contigo', ...FIRST_TO_SECOND };
  const keepCase = (w: string, t: string) => (w.charAt(0) === w.charAt(0).toUpperCase() ? cap(t) : t);
  return (
    g
      // «-me» de cualquier infinitivo o gerundio: «cansarme», «verme», «ahogarme», «poniéndome».
      .replace(/(?<!\p{L})(\p{L}*(?:ar|er|ir|ír|ando|ándo|iendo|iéndo|yendo|yéndo))me(?!\p{L})/giu, (w: string, stem: string) =>
        NOT_ENCLITIC.has(w.toLowerCase()) ? w : `${stem}te`,
      )
      .replace(new RegExp(`(?<!\\p{L})(${Object.keys(swap).join('|')})(?!\\p{L})`, 'giu'), (w: string) => keepCase(w, swap[w.toLowerCase()]))
  );
}

/**
 * «¿Qué te gustaría conseguir?» → «¿qué te gustaría conseguir?» (para ponerla tras “Y cuéntame, ”). Sin la «y» del
 * principio («¿Y qué crees…?» → «¿qué crees…?»): «Y cuéntame, ¿y qué crees…?» suena mal.
 */
export function lowerQuestion(q: string): string {
  return q
    .replace(/^(¿?)\s*y\s+(?=\S)/i, '$1')
    .replace(/^(¿?)(\p{Lu})/u, (_, mark: string, letter: string) => `${mark}${letter.toLowerCase()}`);
}

/** «de» + etiqueta de un horario, con la contracción obligatoria: «del lunes 12 a las 19:00», «de mañana a las 10:00». */
export function ofLabel(label: string): string {
  return label.startsWith('el ') ? `del ${label.slice(3)}` : `de ${label}`;
}

export function createSetterAgent(provider: LLMProvider | null): SetterAgent {
  return provider ? new LlmSetterAgent(provider) : new RuleBasedSetterAgent();
}
