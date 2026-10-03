/**
 * Estrategia del setter: decide QUÉ debe conseguir el siguiente mensaje.
 * Principio: CONVERSAR → ENTENDER → CUALIFICAR → AGENDAR → HACER SEGUIMIENTO.
 * KAI nunca intenta cerrar la venta: eso lo hace el entrenador en la llamada.
 */
import type { ConversationState } from '../../lib/domain.js';
import type { LeadAnalysis } from '../analysis/analyzer.js';
import type { BusinessContext, LeadContext, ObjectionRow, RuleRow } from '../context/context.js';
import { requiredCaptured } from '../../crm/scoring.js';

export type DirectiveKind =
  | 'greet_and_ask'
  | 'ask_qualification'
  | 'handle_objection'
  | 'price_contextualize'
  | 'share_price'
  | 'propose_call'
  | 'offer_slots'
  | 'clarify_slot'
  | 'book_slot'
  | 'reschedule'
  | 'post_booking'
  | 'disqualify_kindly'
  | 'continue_without_call'
  | 'reassure_call'
  | 'first_contact';

export interface Directive {
  kind: DirectiveKind;
  /** Instrucción en lenguaje natural que se pasa a la IA para este mensaje. */
  instruction: string;
  questionKey?: string;
  question?: string;
  objection?: ObjectionRow;
  slotId?: string;
  /** Consultar agenda en este turno. */
  needsSlots?: boolean;
  slotQuery?: { date: string | null; partOfDay: 'morning' | 'afternoon' | 'evening' | 'any' };
  answerQuestionFirst?: boolean;
}

export interface StrategyInput {
  biz: BusinessContext;
  leadCtx: LeadContext;
  state: ConversationState;
  analysis: LeadAnalysis | null;
  kaiHasSpoken: boolean;
  isFirstContact?: boolean;
}

/** Siguiente variable de cualificación por preguntar (en el orden configurado). */
export function nextQualificationRule(rules: RuleRow[], lead: LeadContext['lead'], skip: string[] = []): RuleRow | null {
  for (const r of rules) {
    if (!r.enabled || !r.question.trim() || skip.includes(r.key)) continue;
    if (r.key === 'fit') continue; // el encaje se deduce, no se pregunta
    const item = lead.qualification[r.key];
    const signal = (lead.signals as Record<string, string | undefined>)[r.key];
    if (!item?.value && !signal) return r;
  }
  return null;
}

/** Horarios de la última oferta, si es reciente (menos de 24 h). */
function recentOffer(state: ConversationState) {
  const ids = state.lastOfferIds ?? [];
  if (!ids.length || !state.offeredAt || Date.now() - new Date(state.offeredAt).getTime() > 24 * 3600_000) return [];
  return ids.map((id) => (state.offeredSlots ?? []).find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
}

function clarifyDirective(slots: { label: string; id: string }[], answerQuestionFirst: boolean): Directive {
  return {
    kind: 'clarify_slot',
    instruction: `Ya le ofreciste estos horarios: ${slots.map((s) => `“${s.label}”`).join(' o ')}. No vuelvas a consultar la agenda: pregúntale de forma natural (y distinta a tu mensaje anterior) cuál le viene mejor, o si prefiere otro día.`,
    answerQuestionFirst,
  };
}

export function decideDirective(input: StrategyInput): Directive {
  const { biz, leadCtx, state, analysis } = input;
  const lead = leadCtx.lead;
  const flags = analysis?.flags;
  const answerQuestionFirst = Boolean(flags?.asksQuestion);
  const offered = state.offeredSlots ?? [];
  const settings = biz.settings;

  if (input.isFirstContact) {
    const rule = nextQualificationRule(biz.rules, lead);
    return {
      kind: 'first_contact',
      instruction:
        'El lead acaba de dejar sus datos (formulario o anuncio) y todavía no ha escrito. Escribe el PRIMER mensaje: saluda por su nombre, preséntate brevemente según las reglas de transparencia, menciona de forma natural por qué le escribes (ha mostrado interés) y termina con UNA pregunta abierta para empezar a conocer su objetivo.',
      questionKey: rule?.key,
      question: rule?.question,
    };
  }

  // 1) Ha elegido uno de los horarios ofrecidos → reservar.
  if (analysis?.selectedSlotId && offered.some((s) => s.id === analysis.selectedSlotId)) {
    const slot = offered.find((s) => s.id === analysis.selectedSlotId)!;
    return {
      kind: 'book_slot',
      slotId: slot.id,
      instruction: `El lead ha elegido el horario “${slot.label}” (slot_id ${slot.id}). Llama a la herramienta book_call con ese slot_id y, según el resultado, confirma la cita de forma breve y cercana (o, si no está disponible, ofrece las alternativas que devuelva get_available_slots). No hagas más preguntas de cualificación.`,
    };
  }

  // 2) Ya tiene una llamada agendada.
  if (leadCtx.upcomingAppointment) {
    if (flags?.wantsReschedule || flags?.wantsCancel) {
      return {
        kind: 'reschedule',
        needsSlots: true,
        slotQuery: { date: analysis?.preferredDate ?? null, partOfDay: analysis?.preferredPartOfDay ?? 'any' },
        instruction:
          'El lead quiere mover (o no puede asistir a) su llamada. Sin dramas: consulta huecos con get_available_slots y ofrécele 2 alternativas para reprogramar. Si elige una, usa reschedule_call. Solo usa cancel_call si pide cancelar explícitamente y no quiere otra hora.',
        answerQuestionFirst,
      };
    }
    return {
      kind: 'post_booking',
      instruction:
        'El lead ya tiene la llamada agendada. Responde a lo que diga de forma breve y útil, sin volver a cualificar ni vender. Si es oportuno, recuérdale con naturalidad el día y la hora de la llamada.',
      answerQuestionFirst,
    };
  }

  // 3) No encaja.
  if (lead.signals.fit === 'no') {
    return {
      kind: 'disqualify_kindly',
      instruction:
        'Por lo que ha contado, el servicio no parece adecuado para este lead (no encaja con los criterios). Sé honesto y amable: agradécele, explica brevemente que ahora mismo puede que no sea lo más adecuado para su caso y, si tiene sentido, sugiérele qué tipo de ayuda le convendría. No propongas llamada ni insistas. Sin preguntas, o como mucho una de cortesía.',
    };
  }

  // 4) Objeción.
  if (analysis?.objectionKey) {
    const objection = biz.objections.find((o) => o.key === analysis.objectionKey);
    if (objection) {
      return {
        kind: 'handle_objection',
        objection,
        instruction: `El lead plantea la objeción “${objection.label}”. Sigue estos pasos con naturalidad: valida lo que siente, entiende y profundiza con UNA pregunta, responde con información real y avanza la conversación. Estrategia del entrenador: ${objection.strategy}${objection.exampleResponse ? ` Ejemplo de respuesta en su estilo (no lo copies literal): “${objection.exampleResponse}”` : ''} Nunca presiones ni rebajes el precio por tu cuenta.`,
      };
    }
  }

  const captured = requiredCaptured(biz.rules, lead.qualification);

  // 5) Precio.
  if (flags?.asksPrice) {
    // priceAskedCount ya incluye la pregunta actual.
    const askedBefore = (state.priceAskedCount ?? 0) >= 2;
    if (settings.pricePolicy === 'contextualize_first' && !askedBefore && !captured && !state.priceShared) {
      const rule = nextQualificationRule(biz.rules, lead);
      return {
        kind: 'price_contextualize',
        questionKey: rule?.key,
        question: rule?.question,
        instruction:
          'El lead pregunta el precio. Antes de darlo, contextualiza con naturalidad: algo como “Claro. Antes de decirte qué opción tendría sentido para ti, quiero entender un poco tu situación para no recomendarte algo que no encaje.” y haz UNA pregunta de cualificación. NO ocultes el precio si vuelve a insistir.',
      };
    }
    return {
      kind: 'share_price',
      instruction: state.priceShared
        ? 'El lead vuelve a preguntar por el precio, que ya le diste. Recuérdaselo brevemente (mismo importe real, sin repetir el mensaje anterior palabra por palabra) y pregúntale qué duda tiene o si quiere verlo en la llamada.'
        : 'El lead quiere saber el precio. Dáselo de forma clara usando EXCLUSIVAMENTE el precio real configurado (servicio, importe y periodicidad), con una frase de lo que incluye si está configurado. Después avanza con UNA pregunta (por ejemplo, si quiere valorarlo en la llamada). Nunca inventes descuentos ni condiciones.',
    };
  }

  // 6) Quiere la llamada / propone día → consultar agenda real (o aclarar la oferta reciente).
  const offer = recentOffer(state);
  const newPreference = Boolean(analysis?.preferredDate || analysis?.preferredPartOfDay);
  if (flags?.wantsCall && !flags.declinesCall) {
    if (offer.length && !newPreference) return clarifyDirective(offer, answerQuestionFirst);
    return {
      kind: 'offer_slots',
      needsSlots: true,
      slotQuery: { date: analysis?.preferredDate ?? null, partOfDay: analysis?.preferredPartOfDay ?? 'any' },
      instruction: `El lead quiere agendar la ${settings.callLabel}. Llama a get_available_slots${analysis?.preferredDate ? ` con date=${analysis.preferredDate}` : ''}${analysis?.preferredPartOfDay ? ` y part_of_day=${analysis.preferredPartOfDay}` : ''} y ofrécele 2 opciones con las etiquetas EXACTAS que devuelva (p. ej. “Mañana tengo las 18:00 o las 19:30. ¿Cuál te viene mejor?”). Si no hay huecos ese día, ofrece las alternativas más cercanas. Nunca inventes horarios.`,
      answerQuestionFirst,
    };
  }

  if (flags?.declinesCall) {
    const rule = nextQualificationRule(biz.rules, lead);
    return {
      kind: 'continue_without_call',
      questionKey: rule?.key,
      question: rule?.question,
      instruction:
        'El lead no quiere la llamada ahora. Respétalo sin insistir. Muestra que no pasa nada, ofrece resolver dudas por aquí y continúa la conversación con UNA pregunta útil si tiene sentido.',
    };
  }

  // 7) Cualificado → proponer la llamada.
  const nextRule = nextQualificationRule(biz.rules, lead);
  const readyForCall = (lead.score >= settings.proposeCallMinScore && captured) || (!nextRule && captured);
  if (readyForCall && !state.callProposedAt) {
    return {
      kind: 'propose_call',
      instruction: `El lead está cualificado. Conecta brevemente con lo que te ha contado (su objetivo y su motivo) y propón una ${settings.callLabel} de ${settings.callDurationMinutes} minutos con ${biz.trainer.displayName || 'el entrenador'} para valorar su caso${settings.callDescription ? ` (${settings.callDescription})` : ''}. Pregunta si le encaja. Todavía NO des horarios.`,
      answerQuestionFirst,
    };
  }
  if (state.callProposedAt && !offer.length && !flags?.wantsCall && analysis) {
    // Se propuso la llamada y el lead no la ha aceptado ni rechazado claramente.
    return {
      kind: 'reassure_call',
      instruction:
        'Le propusiste la llamada y no ha respondido con un sí claro. Responde a lo que ha dicho con naturalidad y, sin presionar, pregúntale si le encaja agendarla o qué duda tiene antes de dar el paso.',
      answerQuestionFirst,
    };
  }
  if (readyForCall && state.callProposedAt) {
    if (offer.length && !newPreference) return clarifyDirective(offer, answerQuestionFirst);
    return {
      kind: 'offer_slots',
      needsSlots: true,
      slotQuery: { date: analysis?.preferredDate ?? null, partOfDay: analysis?.preferredPartOfDay ?? 'any' },
      instruction:
        'Ya se le propuso la llamada. Si su mensaje es una aceptación o una duda sobre ella, consulta get_available_slots y ofrece 2 horarios reales. Si habla de otra cosa, respóndele primero con naturalidad.',
      answerQuestionFirst,
    };
  }

  // 8) Primer mensaje de KAI.
  if (!input.kaiHasSpoken) {
    const rule = nextQualificationRule(biz.rules, lead);
    return {
      kind: 'greet_and_ask',
      questionKey: rule?.key,
      question: rule?.question,
      instruction: `Es tu primer mensaje en esta conversación. Saluda con naturalidad (usa su nombre si lo sabes), preséntate según las reglas de transparencia, responde a lo que haya escrito y haz UNA pregunta para empezar a entender su situación${rule ? ` (objetivo: conocer “${rule.label}”; pregunta sugerida: “${rule.question}”)` : ''}.`,
      answerQuestionFirst,
    };
  }

  // 9) Seguir cualificando.
  if (nextRule) {
    return {
      kind: 'ask_qualification',
      questionKey: nextRule.key,
      question: nextRule.question,
      instruction: `Reacciona brevemente a lo último que ha dicho (demuestra que le has escuchado, sin repetirlo literalmente) y haz UNA sola pregunta para conocer “${nextRule.label}” (${nextRule.description}). Pregunta sugerida en el estilo del entrenador: “${nextRule.question}”. Adáptala a la conversación.`,
      answerQuestionFirst,
    };
  }

  return {
    kind: 'propose_call',
    instruction: `Ya tienes la información principal. Propón con naturalidad una ${settings.callLabel} de ${settings.callDurationMinutes} minutos con ${biz.trainer.displayName || 'el entrenador'} para valorar su caso y pregunta si le encaja.`,
    answerQuestionFirst,
  };
}
