/**
 * Agentes que redactan los mensajes de KAI. Mismo contrato, dos implementaciones:
 *  - LlmSetterAgent: IA real con herramientas (agenda, reservas, escalado).
 *  - RuleBasedSetterAgent: motor de reglas (modo simulación, sin API key). Útil para probar
 *    todo el sistema de punta a punta y como referencia de comportamiento.
 */
import { DateTime } from 'luxon';
import { firstName, hashString, normalize, pick } from '../../lib/text.js';
import { BILLING_PERIOD_LABELS, formatMoney, questionCount, type ConversationState } from '../../lib/domain.js';
import { humanSlotLabel } from '../../lib/time.js';
import type { ChatBlock, ChatMessage, LLMProvider, ToolResultBlock } from '../providers/types.js';
import { textOf } from '../providers/types.js';
import type { BusinessContext, ConversationContext, LeadContext } from '../context/context.js';
import { buildSetterStablePrompt, buildSetterTurnContext } from '../prompts/setter.prompt.js';
import { maxCharsFor } from '../prompts/tone.js';
import type { SetterToolbox } from '../tools/setter-tools.js';
import { slotStillBookable, type Directive, type SetterState } from './strategy.js';
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
};

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
    const onlyThanks = /^\s*(?:(?:vale|ok|genial|perfecto)[,.!]?\s+)?(?:muchas )?gracias\b[\s,.!]*(?:a ti|por todo)?[\s.!]*$/.test(normalize(pendingText));
    const ack = eventAck ?? (leadOnlyAsked ? '' : onlyThanks ? 'Gracias a ti.' : pick(ACKS[state.lastAskedKey ?? 'default'] ?? ACKS.default, seed));
    // “¿Qué incluye?”, “¿cómo funciona?”: se responde con lo que el entrenador ha configurado.
    const svc0 = biz.services[0];
    const asksWhatIncludes = /\b(que|qu[eé]) (incluye|trae|tiene el (programa|plan|servicio))\b|\ben que consiste\b|\bcomo funciona\b|\bcomo (es|seria) (el|tu) (programa|plan|servicio|metodo)\b/.test(normalize(pendingText));
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

    if (input.mode === 'follow_up' && input.followUp) {
      const goal = lead.goalSummary || lead.qualification.goal?.value;
      const goalRef = goal ? lowerFirst(trimGoal(goal)) : null;
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
          const interest = goal ? `Vi que quieres ${lowerFirst(trimGoal(goal))}` : `Vi que te interesa ${biz.trainer.methodName ? `el método ${biz.trainer.methodName}` : 'entrenar con nosotros'}`;
          text = `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''} ${interest}${emoji('👋')} ${q || '¿Qué te gustaría conseguir?'}`;
        }
        break;
      case 'greet_and_ask':
        // El saludo, la presentación y el “Gracias por escribir” se añaden al final (ver fitParts).
        text = q || '¿Qué te gustaría conseguir exactamente?';
        break;
      case 'ask_qualification':
        text = `${ack} ${q}`.trim();
        if (ack && q) shorter = [q];
        break;
      case 'handle_objection': {
        // El ejemplo del entrenador, salvo que ya se usara (o que tenga más de una pregunta).
        const example = directive.objection?.exampleResponse?.trim();
        const generic = fresh([
          'Te entiendo perfectamente. ¿Qué es lo que más te frena ahora mismo?',
          'Tiene todo el sentido que te lo plantees. ¿Qué necesitarías para verlo más claro?',
          'Es normal tener dudas con esto. ¿Qué te gustaría saber antes de decidir nada?',
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
        const booked = Boolean(leadCtx.upcomingAppointment);
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
          if (booked)
            text = again
              ? fresh([
                  `Como te comentaba, ${svc.name} son ${price}. En la ${s.callLabel} lo veréis en detalle con ${trainer}.`,
                  `Te lo confirmo: ${svc.name} son ${price}. ${cap(trainer)} te lo explica todo en la ${s.callLabel}.`,
                ])
              : withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} En la ${s.callLabel} lo veréis en detalle con ${trainer}.`);
          else if (state.priceShared)
            text = fresh([
              `Como te comentaba, ${svc.name} son ${price}. ¿Qué duda te queda para ver si encaja contigo?`,
              `Te lo confirmo: ${svc.name} son ${price}. ¿Hay algo de lo que incluye que quieras que te aclare?`,
            ]);
          else if (callDeclined) text = withIncludes(`Claro. ${svc.name} cuesta ${price}.${includes} ¿Qué te parece?`);
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
        });
        const data = JSON.parse(r.content) as { slots?: { label: string }[]; note?: string };
        const labels = (data.slots ?? []).map((x) => x.label);
        if (labels.length === 0) {
          text = `Ahora mismo no veo huecos libres en la agenda. Lo reviso con ${trainer} y te escribo con opciones, ¿vale?`;
        } else {
          const options = labels.length === 1 ? `tengo ${labels[0]}. ¿Te viene bien?` : `tengo ${joinLabels(labels)}. ¿Cuál te viene mejor?`;
          text =
            directive.kind === 'reschedule'
              ? `Sin problema, lo movemos. ${data.note ? `Ese día no me quedan huecos, pero ${options}` : cap(options)}`
              : data.note
                ? `Ese día no me quedan huecos, pero ${options}`
                : `Perfecto. ${cap(options)}`;
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
        text = `Claro, sin ninguna prisa. La ${s.callLabel} es simplemente para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos. ¿Qué duda te gustaría resolver antes?`;
        shorter = [
          `Claro, sin prisa. La ${s.callLabel} es para que ${trainer} conozca tu caso y veáis si encaja. ¿Qué duda te gustaría resolver antes?`,
          `Claro, sin prisa. ¿Qué duda te gustaría resolver antes de la ${s.callLabel}?`,
        ];
        break;
      case 'clarify_slot': {
        const ids = state.lastOfferIds ?? [];
        // Etiquetas recalculadas ahora (la oferta pudo hacerse ayer: su “mañana” hoy es “hoy”).
        const labels = ids
          .map((id) => (state.offeredSlots ?? []).find((x) => x.id === id))
          .filter((x): x is NonNullable<typeof x> => Boolean(x) && slotStillBookable(x!.start, input.now, biz.minNoticeMinutes ?? 0))
          .map((x) => humanSlotLabel(x.start, biz.business.timezone, input.now));
        if (!labels.length) {
          text = '¿Qué día y franja te vendría mejor para la llamada?';
          break;
        }
        const options = joinLabels(labels);
        const variants = [
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
        const data = JSON.parse(r.content) as { error?: string; label?: string; booking_url?: string; meeting_url?: string | null; mode?: string };
        if (r.isError) {
          const again = await input.toolbox.run('get_available_slots', { date: null, part_of_day: 'any' });
          const slots = (JSON.parse(again.content) as { slots?: { label: string }[] }).slots ?? [];
          text = slots.length
            ? `Vaya, ese hueco se acaba de ocupar. Tengo ${joinLabels(slots.map((x) => x.label))}. ¿Cuál te viene mejor?`
            : `Vaya, ese hueco se acaba de ocupar. Lo reviso con ${trainer} y te digo opciones, ¿vale?`;
        } else if (data.mode === 'link') {
          text = `Genial. Para confirmar ${data.label}, resérvalo aquí en un clic: ${data.booking_url}`;
        } else {
          text = `¡Hecho! Te apunto para ${data.label}${emoji('🙌')}${data.meeting_url ? ` Este es el enlace de la llamada: ${data.meeting_url}` : ''} Te llegará un recordatorio antes.`;
        }
        break;
      }
      case 'post_booking': {
        // Neutro: no da por hecho que el lead ha dicho que sí a nada.
        const appt = leadCtx.upcomingAppointment;
        const when = appt ? humanSlotLabel(appt.startsAt, biz.business.timezone, input.now) : null;
        text = when
          ? botNotes.length
            ? `La ${s.callLabel} sigue en pie ${when}; si tienes que moverla, me dices.`
            : fresh([
                `Entendido. Si te surge algo y necesitas mover la ${s.callLabel} (${when}), dímelo sin problema.`,
                `Aquí estoy para lo que necesites. La ${s.callLabel} sigue en pie ${when}; si tienes que moverla, me dices.`,
                `Gracias por escribir. Cualquier duda antes de la ${s.callLabel} (${when}), me la preguntas por aquí.`,
              ])
          : fresh(['Vale, cualquier cosa me dices.', 'Entendido. Aquí me tienes para lo que necesites.']);
        shorter = ['Cualquier otra duda, me dices.'];
        break;
      }
      case 'confirm_cancel': {
        const appt = leadCtx.upcomingAppointment;
        const when = appt ? ` de ${humanSlotLabel(appt.startsAt, biz.business.timezone, input.now)}` : '';
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
        text = fresh([
          'Gracias por contármelo con tanta sinceridad. Por lo que me cuentas, ahora mismo creo que esto no sería lo más adecuado para ti, y prefiero ser honesto contigo. Te deseo mucho ánimo.',
          'Gracias a ti. Si en algún momento cambia tu situación, aquí estaré para ayudarte.',
          'Entendido. Te deseo lo mejor, y si más adelante encaja, aquí me tienes.',
        ]);
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
          text = fresh([
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
    // [qué incluye] [respuesta]. Si no cabe en el máximo del tono, se acortan las partes opcionales.
    const greets = directive.kind === 'greet_and_ask' || Boolean(input.firstMessage);
    const answersIncludes = ['ask_qualification', 'continue_without_call', 'reassure_call', 'post_booking', 'propose_call'].includes(directive.kind);
    const parts: MessagePart[] = [
      { key: 'hello', options: greets ? [`${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''}`] : [] },
      { key: 'thanks', options: directive.kind === 'greet_and_ask' ? [`Gracias por escribir${emoji('👋')}`, ''] : [] },
      // Si pregunta si es un bot, se le responde con transparencia en cualquier tipo de mensaje (no solo al cualificar).
      { key: 'bot', options: botNotes },
      { key: 'includes', options: answersIncludes ? includesAnswers : [] },
      { key: 'main', options: [text, ...shorter] },
    ];
    // La oferta de pasarle con el entrenador es lo último que se quita de la nota de transparencia.
    return { text: fitParts(parts, ['thanks', ['bot', 1], 'includes', 'main', 'bot'], maxCharsFor(s.tone)), meta: { agent: this.name } };
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

export function createSetterAgent(provider: LLMProvider | null): SetterAgent {
  return provider ? new LlmSetterAgent(provider) : new RuleBasedSetterAgent();
}
