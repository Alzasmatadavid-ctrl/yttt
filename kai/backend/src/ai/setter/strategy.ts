/**
 * Estrategia del setter: decide QUÉ debe conseguir el siguiente mensaje.
 * Principio: CONVERSAR → ENTENDER → CUALIFICAR → AGENDAR → HACER SEGUIMIENTO.
 * KAI nunca intenta cerrar la venta: eso lo hace el entrenador en la llamada.
 */
import type { ConversationState } from '../../lib/domain.js';
import { humanSlotLabel } from '../../lib/time.js';
import type { LeadAnalysis } from '../analysis/analyzer.js';
import type { BusinessContext, LeadContext, ObjectionRow, RuleRow } from '../context/context.js';
import { requiredCaptured } from '../../crm/scoring.js';

/**
 * Estado de la conversación con los campos propios del setter:
 *  - callDeclinedAt: el lead rechazó la llamada (o canceló la que tenía). No se le vuelve a proponer salvo que la pida.
 *  - callReassuredAt: ya se resolvieron sus dudas sobre la llamada una vez; no se le vuelve a preguntar en cada mensaje.
 */
export type SetterState = ConversationState & {
  callDeclinedAt?: string;
  callReassuredAt?: string;
  /** Veces que KAI ha preguntado por cada variable: tras dos intentos sin respuesta se pasa a la siguiente. */
  askCounts?: Record<string, number>;
};

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
  | 'cancel_booking'
  | 'confirm_cancel'
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
  /** continue_without_call: el lead acaba de rechazar la llamada (se le confirma que no pasa nada) o ya lo hizo antes. */
  justDeclined?: boolean;
  /** share_price: dar el precio sin proponer la llamada (el lead no encaja o ya la rechazó). */
  withoutCall?: boolean;
}

export interface StrategyInput {
  biz: BusinessContext;
  leadCtx: LeadContext;
  state: SetterState;
  analysis: LeadAnalysis | null;
  kaiHasSpoken: boolean;
  isFirstContact?: boolean;
  /** Momento de referencia (por defecto, ahora). */
  now?: Date;
}

/**
 * Deja una sola pregunta en el texto configurado por el entrenador: “¿Por qué ahora? ¿Hay alguna fecha…?” →
 * “¿Hay alguna fecha…?”. KAI nunca hace más de una pregunta por mensaje, aunque la plantilla traiga dos.
 */
export function oneQuestion(question: string): string {
  const q = question.trim();
  if ((q.match(/\?/g) ?? []).length <= 1) return q;
  const parts = q.match(/[^?]*\?/g) ?? [q];
  const last = parts[parts.length - 1].trim();
  return last.startsWith('¿') || !last.includes('¿') ? last : last.slice(last.lastIndexOf('¿'));
}

/** Siguiente variable de cualificación por preguntar (en el orden configurado). */
export function nextQualificationRule(rules: RuleRow[], lead: LeadContext['lead'], skip: string[] = []): RuleRow | null {
  for (const r of rules) {
    if (!r.enabled || !r.question.trim() || skip.includes(r.key)) continue;
    if (r.key === 'fit') continue; // el encaje se deduce, no se pregunta
    const item = lead.qualification[r.key];
    const signal = (lead.signals as Record<string, string | undefined>)[r.key];
    if (!item?.value && !signal) return { ...r, question: oneQuestion(r.question) };
  }
  return null;
}

/** ¿Se puede todavía reservar este horario? (no ha pasado y respeta la antelación mínima). */
export function slotStillBookable(start: string | Date, now: Date, minNoticeMinutes = 0): boolean {
  return new Date(start).getTime() > now.getTime() + minNoticeMinutes * 60_000;
}

/**
 * Horarios de la última oferta, si es reciente (menos de 24 h) y solo los que aún se pueden reservar:
 * un horario de ayer o que ya no cumple la antelación mínima no se vuelve a ofrecer.
 */
export function recentOffer(state: ConversationState, now: Date = new Date(), minNoticeMinutes = 0) {
  const ids = state.lastOfferIds ?? [];
  if (!ids.length || !state.offeredAt || now.getTime() - new Date(state.offeredAt).getTime() > 24 * 3600_000) return [];
  return ids
    .map((id) => (state.offeredSlots ?? []).find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s) && slotStillBookable(s!.start, now, minNoticeMinutes));
}

function clarifyDirective(slots: { start: string; id: string }[], timezone: string, answerQuestionFirst: boolean): Directive {
  // Etiquetas recalculadas ahora: “mañana” de ayer es “hoy”.
  return {
    kind: 'clarify_slot',
    instruction: `Ya le ofreciste estos horarios: ${slots.map((s) => `“${humanSlotLabel(s.start, timezone)}”`).join(' o ')}. No vuelvas a consultar la agenda: pregúntale de forma natural (y distinta a tu mensaje anterior) cuál le viene mejor, o si prefiere otro día.`,
    answerQuestionFirst,
  };
}

export function decideDirective(input: StrategyInput): Directive {
  const { biz, leadCtx, state, analysis } = input;
  const lead = leadCtx.lead;
  const flags = analysis?.flags;
  const answerQuestionFirst = Boolean(flags?.asksQuestion);
  const now = input.now ?? new Date();
  const minNotice = biz.minNoticeMinutes ?? 0;
  // Solo cuentan los horarios que todavía se pueden reservar.
  const offered = (state.offeredSlots ?? []).filter((s) => slotStillBookable(s.start, now, minNotice));
  const settings = biz.settings;
  const trainer = biz.trainer.displayName || 'el entrenador';

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
    const label = humanSlotLabel(slot.start, biz.business.timezone);
    return {
      kind: 'book_slot',
      slotId: slot.id,
      instruction: `El lead ha elegido el horario “${label}” (slot_id ${slot.id}). Llama a la herramienta ${leadCtx.upcomingAppointment ? 'reschedule_call' : 'book_call'} con ese slot_id y, según el resultado, confirma la cita de forma breve y cercana (o, si no está disponible, ofrece las alternativas que devuelva get_available_slots). No hagas más preguntas de cualificación.`,
    };
  }

  const offer = recentOffer(state, now, minNotice);
  const newPreference = Boolean(analysis?.preferredDate || analysis?.preferredPartOfDay);

  // 2) Ya tiene una llamada agendada.
  if (leadCtx.upcomingAppointment) {
    const when = humanSlotLabel(leadCtx.upcomingAppointment.startsAt, biz.business.timezone, now);
    if (flags?.wantsCancel && !flags.wantsReschedule) {
      return {
        kind: 'cancel_booking',
        instruction:
          'El lead pide cancelar su llamada. Usa cancel_call y confírmale con amabilidad que queda cancelada. Sin insistir ni proponer otra fecha (salvo que la pida), dile que si más adelante quiere retomarlo puede escribirte por aquí.',
        answerQuestionFirst,
      };
    }
    // Dice que no quiere la llamada (sin pedir cancelarla ni moverla): se le pregunta antes de tocar nada.
    if (flags?.declinesCall && !flags.wantsReschedule && !flags.wantsCancel) {
      return {
        kind: 'confirm_cancel',
        instruction: `El lead tiene la ${settings.callLabel} agendada (${when}) y dice que no quiere hacerla. NO la canceles todavía ni uses herramientas: respóndele con naturalidad y pregúntale, en UNA sola pregunta, si quiere que la canceles o prefiere moverla a otro día. Sin insistir ni presionar.`,
        answerQuestionFirst,
      };
    }
    // Está eligiendo otra fecha para mover la llamada (ya se le ofrecieron horarios): nueva preferencia → consultar
    // la agenda otra vez; si solo duda entre los ofrecidos → preguntarle cuál le viene mejor.
    if (offer.length && !flags?.asksPrice) {
      if (newPreference || flags?.wantsReschedule) {
        return {
          kind: 'reschedule',
          needsSlots: true,
          slotQuery: { date: analysis?.preferredDate ?? null, partOfDay: analysis?.preferredPartOfDay ?? 'any' },
          instruction:
            'El lead está buscando otro horario para mover su llamada. Consulta get_available_slots con su preferencia y ofrécele 2 alternativas reales. Si elige una, usa reschedule_call.',
          answerQuestionFirst,
        };
      }
      return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst);
    }
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
    if (flags?.asksPrice) {
      // Con la llamada ya agendada no hay nada que contextualizar: el precio no se oculta (sección 16).
      return {
        kind: 'share_price',
        instruction: `El lead ya tiene la ${settings.callLabel} agendada y pregunta el precio. Dáselo de forma clara usando EXCLUSIVAMENTE el precio real configurado (servicio, importe y periodicidad) y dile que en la llamada lo verá en detalle con ${trainer}. No vuelvas a cualificar ni propongas otra llamada. Nunca inventes descuentos ni condiciones.`,
        answerQuestionFirst,
      };
    }
    return {
      kind: 'post_booking',
      instruction: `El lead ya tiene la llamada agendada (${when}). Responde a lo que diga de forma breve y útil, sin volver a cualificar ni vender, y sin dar por hecho que te ha dicho que sí a algo. Si pone pegas a la llamada o a la hora, pregúntale si prefiere moverla. Si es oportuno, recuérdale con naturalidad el día y la hora.`,
      answerQuestionFirst,
    };
  }

  // 3) No encaja.
  if (lead.signals.fit === 'no') {
    // Si insiste en saber el precio, se le da (el precio nunca se oculta), sin proponer la llamada.
    if (flags?.asksPrice && ((state.priceAskedCount ?? 0) >= 2 || state.priceShared)) {
      return {
        kind: 'share_price',
        withoutCall: true,
        instruction:
          'El lead insiste en saber el precio. Dáselo de forma clara usando EXCLUSIVAMENTE el precio real configurado (servicio, importe y periodicidad), con honestidad: por lo que te ha contado, puede que ahora no sea lo más adecuado para su caso. No propongas la llamada ni presiones. Nunca inventes descuentos ni condiciones.',
        answerQuestionFirst,
      };
    }
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
  // Rechazó la llamada antes y ahora no la pide: no se le vuelve a proponer, ni se le ofrecen horarios.
  const callDeclined = Boolean(state.callDeclinedAt) && !flags?.wantsCall;

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
    const next = callDeclined ? 'pregúntale qué duda tiene (sin volver a proponer la llamada: ya dijo que prefiere seguir por aquí)' : 'pregúntale qué duda tiene o si quiere verlo en la llamada';
    return {
      kind: 'share_price',
      instruction: state.priceShared
        ? `El lead vuelve a preguntar por el precio, que ya le diste. Recuérdaselo brevemente (mismo importe real, sin repetir el mensaje anterior palabra por palabra) y ${next}.`
        : `El lead quiere saber el precio. Dáselo de forma clara usando EXCLUSIVAMENTE el precio real configurado (servicio, importe y periodicidad), con una frase de lo que incluye si está configurado. Después avanza con UNA pregunta (${callDeclined ? 'por ejemplo, qué duda tiene; no vuelvas a proponer la llamada, ya la rechazó' : 'por ejemplo, si quiere valorarlo en la llamada'}). Nunca inventes descuentos ni condiciones.`,
    };
  }

  // 6) Quiere la llamada / propone día → consultar agenda real (o aclarar la oferta reciente).
  if (flags?.wantsCall && !flags.declinesCall) {
    if (offer.length && !newPreference) return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst);
    return {
      kind: 'offer_slots',
      needsSlots: true,
      slotQuery: { date: analysis?.preferredDate ?? null, partOfDay: analysis?.preferredPartOfDay ?? 'any' },
      instruction: `El lead quiere agendar la ${settings.callLabel}. Llama a get_available_slots${analysis?.preferredDate ? ` con date=${analysis.preferredDate}` : ''}${analysis?.preferredPartOfDay ? ` y part_of_day=${analysis.preferredPartOfDay}` : ''} y ofrécele 2 opciones con las etiquetas EXACTAS que devuelva (p. ej. “Mañana tengo las 18:00 o las 19:30. ¿Cuál te viene mejor?”). Si no hay huecos ese día, ofrece las alternativas más cercanas. Nunca inventes horarios.`,
      answerQuestionFirst,
    };
  }

  // No se insiste más de dos veces con la misma pregunta: si no la ha contestado, se sigue con otra cosa.
  const askedEnough = Object.entries(state.askCounts ?? {})
    .filter(([, n]) => n >= 2)
    .map(([k]) => k);
  const nextRule = nextQualificationRule(biz.rules, lead, askedEnough);

  if (flags?.declinesCall) {
    return {
      kind: 'continue_without_call',
      questionKey: nextRule?.key,
      question: nextRule?.question,
      justDeclined: true,
      instruction:
        'El lead no quiere la llamada ahora. Respétalo sin insistir. Muestra que no pasa nada, ofrece resolver dudas por aquí y continúa la conversación con UNA pregunta útil si tiene sentido. No vuelvas a proponer la llamada.',
    };
  }

  // 7) Cualificado → proponer la llamada (salvo que ya la rechazara: entonces se sigue conversando por aquí).
  const readyForCall = !callDeclined && ((lead.score >= settings.proposeCallMinScore && captured) || (!nextRule && captured));
  if (readyForCall && !state.callProposedAt) {
    return {
      kind: 'propose_call',
      instruction: `El lead está cualificado. Conecta brevemente con lo que te ha contado (su objetivo y su motivo) y propón una ${settings.callLabel} de ${settings.callDurationMinutes} minutos con ${trainer} para valorar su caso${settings.callDescription ? ` (${settings.callDescription})` : ''}. Pregunta si le encaja. Todavía NO des horarios.`,
      answerQuestionFirst,
    };
  }
  if (!callDeclined && state.callProposedAt && !offer.length && !flags?.wantsCall && analysis) {
    // Se propuso la llamada y el lead no la ha aceptado ni rechazado claramente. Se resuelven sus dudas UNA vez;
    // después no se le vuelve a preguntar en cada mensaje: se sigue conversando (y cualificando si falta algo).
    if (!state.callReassuredAt) {
      return {
        kind: 'reassure_call',
        instruction:
          'Le propusiste la llamada y no ha respondido con un sí claro. Responde a lo que ha dicho con naturalidad y, sin presionar, pregúntale si le encaja agendarla o qué duda tiene antes de dar el paso.',
        answerQuestionFirst,
      };
    }
    if (!nextRule) return keepTalking(answerQuestionFirst);
  } else if (readyForCall && state.callProposedAt) {
    if (offer.length && !newPreference) return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst);
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
    const rule = nextRule;
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

  if (callDeclined || state.callProposedAt) return keepTalking(answerQuestionFirst);

  return {
    kind: 'propose_call',
    instruction: `Ya tienes la información principal. Propón con naturalidad una ${settings.callLabel} de ${settings.callDurationMinutes} minutos con ${trainer} para valorar su caso y pregunta si le encaja.`,
    answerQuestionFirst,
  };
}

/** Seguir la conversación por escrito sin volver a sacar la llamada (ya la rechazó o ya se le propuso). */
function keepTalking(answerQuestionFirst: boolean): Directive {
  return {
    kind: 'continue_without_call',
    instruction:
      'Sigue la conversación por aquí: responde a lo que ha dicho con naturalidad y de forma útil, y ofrécele resolver cualquier duda por escrito. No vuelvas a proponer la llamada ni le ofrezcas horarios; si él la pide, entonces sí.',
    answerQuestionFirst,
  };
}
