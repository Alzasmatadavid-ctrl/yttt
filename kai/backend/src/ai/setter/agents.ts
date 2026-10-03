/**
 * Agentes que redactan los mensajes de KAI. Mismo contrato, dos implementaciones:
 *  - LlmSetterAgent: IA real con herramientas (agenda, reservas, escalado).
 *  - RuleBasedSetterAgent: motor de reglas (modo simulación, sin API key). Útil para probar
 *    todo el sistema de punta a punta y como referencia de comportamiento.
 */
import { firstName, pick, hashString } from '../../lib/text.js';
import { BILLING_PERIOD_LABELS, formatMoney, type ConversationState } from '../../lib/domain.js';
import type { ChatBlock, ChatMessage, LLMProvider, ToolResultBlock } from '../providers/types.js';
import { textOf } from '../providers/types.js';
import type { BusinessContext, ConversationContext, LeadContext } from '../context/context.js';
import { buildSetterStablePrompt, buildSetterTurnContext } from '../prompts/setter.prompt.js';
import type { SetterToolbox } from '../tools/setter-tools.js';
import type { Directive } from './strategy.js';
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
    const text =
      m.contentType === 'template' && typeof m.metadata.intendedText === 'string'
        ? m.metadata.intendedText
        : m.senderType === 'human'
          ? m.content
          : m.content;
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

/** Limpia artefactos típicos (comillas envolventes, prefijos tipo “KAI:”). */
export function cleanReply(text: string): string {
  let t = text.trim();
  t = t.replace(/^(kai|asistente|respuesta|mensaje)\s*:\s*/i, '');
  if (/^["“«].*["”»]$/s.test(t)) t = t.slice(1, -1).trim();
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
  if (labels.length === 1) return labels[0];
  const parts = labels.map((l) => /^(.*) a las (\d{1,2}:\d{2})$/.exec(l));
  if (parts.every(Boolean) && parts.every((p) => p![1] === parts[0]![1])) {
    const times = parts.map((p) => `a las ${p![2]}`);
    return `${parts[0]![1]} ${times.slice(0, -1).join(', ')} o ${times[times.length - 1]}`;
  }
  return `${labels.slice(0, -1).join(', ')} o ${labels[labels.length - 1]}`;
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
    const eventAck = /\b(me caso|boda|casarme)\b/.test(pendingText)
      ? `¡Enhorabuena por la boda!${emoji('🎉')}`
      : /\b(vacaciones|viaje)\b/.test(pendingText)
        ? '¡Qué buen plan!'
        : /\b(hij[oa]s?|beb[eé])\b/.test(pendingText)
          ? 'Qué bonito motivo.'
          : null;
    const ack = eventAck ?? pick(ACKS[state.lastAskedKey ?? 'default'] ?? ACKS.default, seed);
    const greeting = s.tone.formality <= 2 && s.tone.energy >= 4 ? '¡Ey' : '¡Hola';
    const intro =
      s.disclosureMode === 'first_message'
        ? s.persona === 'trainer'
          ? `Te escribe ${assistant}, el asistente de ${trainer}.`
          : `Soy ${assistant}, del equipo de ${trainer}.`
        : '';
    const botNote = input.extraNote?.includes('si eres un bot') ? `Te soy sincero: soy el asistente automatizado del equipo de ${trainer}, y si prefieres hablar directamente con ${trainer} te lo paso. ` : '';

    if (input.mode === 'follow_up' && input.followUp) {
      const goal = lead.goalSummary || lead.qualification.goal?.value;
      const event = leadCtx.memories.find((m) => m.kind === 'event')?.content;
      const lastQuestion = directive.question;
      const steps: string[] = [
        `${name ? `Hola ${name}, ` : 'Hola, '}me quedé pensando en lo que me contaste${goal ? ` de ${lowerFirst(trimGoal(goal))}` : ''}. ${lastQuestion ?? '¿Seguimos con ello?'}`,
        `${name ? `${name}, ` : ''}${event ? `teniendo en cuenta lo que me comentaste (${lowerFirst(event)}), ` : ''}sigo por aquí por si quieres retomarlo${goal ? ` y ver cómo plantear lo de ${lowerFirst(trimGoal(goal))}` : ''}. ¿Te viene bien que lo hablemos esta semana?`,
        `${name ? `${name}, ` : ''}no quiero ser pesado${emoji('🙂')} Si en algún momento quieres retomar${goal ? ` lo de ${lowerFirst(trimGoal(goal))}` : ' la conversación'}, aquí estaré. ¡Mucho ánimo!`,
      ];
      return { text: steps[Math.min(input.followUp.step, steps.length) - 1], meta: { agent: this.name } };
    }

    const q = directive.question ? cap(directive.question) : '';
    let text: string;
    switch (directive.kind) {
      case 'first_contact':
        {
          const goal = lead.goalSummary || lead.qualification.goal?.value;
          const interest = goal ? `Vi que quieres ${lowerFirst(trimGoal(goal))}` : `Vi que te interesa ${biz.trainer.methodName ? `el método ${biz.trainer.methodName}` : 'entrenar con nosotros'}`;
          text = `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''} ${interest}${emoji('👋')} ${q || '¿Qué te gustaría conseguir?'}`;
        }
        break;
      case 'greet_and_ask':
        text = `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''} Gracias por escribir${emoji('👋')} ${botNote}${q || '¿Qué te gustaría conseguir exactamente?'}`;
        break;
      case 'ask_qualification':
        text = `${botNote}${ack} ${q}`;
        break;
      case 'handle_objection':
        text = directive.objection?.exampleResponse || 'Te entiendo perfectamente. ¿Qué es lo que más te frena ahora mismo?';
        break;
      case 'price_contextualize':
        text = `Claro. Antes de decirte qué opción tendría sentido para ti, quiero entender un poco tu situación para no recomendarte algo que no encaje. ${q || '¿Qué te gustaría conseguir exactamente?'}`;
        break;
      case 'share_price': {
        const svc = biz.services[0];
        if (!svc || svc.priceCents <= 0) {
          text = `El precio lo concreta ${trainer} según tu caso, porque depende de lo que necesites. ¿Te parece si lo veis en una ${s.callLabel} de ${s.callDurationMinutes} minutos?`;
        } else {
          const items = svc.includes.slice(0, 3).map((i) => lowerFirst(i));
          const includes = items.length ? ` Incluye ${items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items[0]}.` : '';
          const price = `${formatMoney(svc.priceCents, svc.currency)} ${BILLING_PERIOD_LABELS[svc.billingPeriod] ?? ''}`.trim();
          text = state.priceShared
            ? `Como te comentaba, ${svc.name} son ${price}. ¿Qué duda te queda para ver si encaja contigo?`
            : `Claro. ${svc.name} cuesta ${price}.${includes} ¿Te gustaría verlo con ${trainer} en una ${s.callLabel} para valorar si encaja contigo?`;
        }
        break;
      }
      case 'propose_call': {
        const event = leadCtx.memories.find((m) => m.kind === 'event')?.content;
        const lead_in = event ? `Teniendo en cuenta lo que me comentaste (${lowerFirst(event)}), ` : 'Por lo que me cuentas, ';
        text = `${botNote}${lead_in}creo que tendría sentido que lo vierais en una ${s.callLabel} de ${s.callDurationMinutes} minutos con ${trainer} para valorar tu caso. ¿Te encaja?`;
        break;
      }
      case 'offer_slots':
      case 'reschedule': {
        if (!input.toolbox) throw new Error('Sin acceso a la agenda.');
        const r = await input.toolbox.run('get_available_slots', {
          date: directive.slotQuery?.date ?? null,
          part_of_day: directive.slotQuery?.partOfDay ?? 'any',
        });
        const data = JSON.parse(r.content) as { slots?: { label: string }[]; note?: string };
        const labels = (data.slots ?? []).map((x) => x.label);
        if (labels.length === 0) {
          text = `Ahora mismo no veo huecos libres en la agenda. Lo reviso con ${trainer} y te escribo con opciones, ¿vale?`;
        } else {
          const options = labels.length === 1 ? `tengo ${labels[0]}. ¿Te viene bien?` : `tengo ${joinLabels(labels)}. ¿Cuál te viene mejor?`;
          text =
            directive.kind === 'reschedule'
              ? `Sin problema, lo movemos. ${cap(options)}`
              : data.note
                ? `Ese día no me quedan huecos, pero ${options}`
                : `Perfecto. ${cap(options)}`;
        }
        break;
      }
      case 'reassure_call':
        text = `Claro, sin ninguna prisa. La ${s.callLabel} es simplemente para que ${trainer} conozca tu caso y veáis si tiene sentido trabajar juntos. ¿Qué duda te gustaría resolver antes?`;
        break;
      case 'clarify_slot': {
        const ids = state.lastOfferIds ?? [];
        const labels = ids.map((id) => (state.offeredSlots ?? []).find((x) => x.id === id)?.label).filter((l): l is string => Boolean(l));
        const variants = [
          `¡Genial! Entonces, ¿te va mejor ${joinLabels(labels)}?`,
          `Perfecto. ¿Cuál de las opciones te encaja más: ${joinLabels(labels)}?`,
          `Genial. Dime cuál prefieres, ${joinLabels(labels)}, o si te viene mejor otro día.`,
        ];
        text = labels.length ? pick(variants, seed) : '¿Qué día y franja te vendría mejor para la llamada?';
        break;
      }
      case 'book_slot': {
        if (!input.toolbox || !directive.slotId) throw new Error('Sin acceso a la agenda.');
        const tool = leadCtx.upcomingAppointment ? 'reschedule_call' : 'book_call';
        const r = await input.toolbox.run(tool, { slot_id: directive.slotId });
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
        const appt = leadCtx.upcomingAppointment;
        text = appt
          ? `Perfecto${emoji('👍')} Lo tenemos para la llamada. Si te surge algo y necesitas moverla, dímelo sin problema.`
          : 'Perfecto, cualquier cosa me dices.';
        break;
      }
      case 'disqualify_kindly':
        text = 'Gracias por contármelo con tanta sinceridad. Por lo que me cuentas, ahora mismo creo que esto no sería lo más adecuado para ti, y prefiero ser honesto contigo. Te deseo mucho ánimo.';
        break;
      case 'continue_without_call':
        text = q ? `Sin problema, lo vamos hablando por aquí. ${q}` : 'Sin problema, lo vamos hablando por aquí. Cualquier duda, me dices.';
        break;
      default:
        text = q || 'Perfecto, cuéntame.';
    }
    if (input.firstMessage && directive.kind !== 'greet_and_ask' && directive.kind !== 'first_contact') {
      text = `${greeting}${name ? ` ${name}` : ''}!${intro ? ` ${intro}` : ''} ${text}`;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), meta: { agent: this.name } };
  }
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
