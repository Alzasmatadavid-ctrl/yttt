/**
 * Estrategia del setter: decide QUÉ debe conseguir el siguiente mensaje.
 * Principio: CONVERSAR → ENTENDER → CUALIFICAR → AGENDAR → HACER SEGUIMIENTO.
 * KAI nunca intenta cerrar la venta: eso lo hace el entrenador en la llamada.
 */
import { DateTime } from 'luxon';
import type { ConversationState } from '../../lib/domain.js';
import { humanSlotLabel, leadZone, zonePlace } from '../../lib/time.js';
import { partOfDay } from '../../calendar/availability.js';
import { matchesRejectedTime, type LeadAnalysis } from '../analysis/analyzer.js';
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
  /**
   * Días (YYYY-MM-DD) y horas (“HH:mm” o “YYYY-MM-DD HH:mm”) que el lead ha descartado mientras busca horario: no se
   * le vuelven a ofrecer en las ofertas siguientes (sin esto, tras dos “ninguna” volvería la primera oferta). Se
   * olvidan al reservar o cancelar la llamada.
   */
  rejectedDates?: string[];
  rejectedTimes?: string[];
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
  slotQuery?: {
    date: string | null;
    partOfDay: 'morning' | 'afternoon' | 'evening' | 'any';
    /** Días (YYYY-MM-DD) que no se le deben ofrecer: dice que no puede o acaba de rechazar los horarios de ese día. */
    excludeDates?: string[];
    /** Hora que pide (“a las 10” → "10:00"): se le ofrecen primero los huecos más cercanos a ella. */
    time?: string;
    /** Horas que ha dicho que no puede (“HH:mm” cualquier día, o “YYYY-MM-DD HH:mm”): no se le ofrecen. */
    excludeTimes?: string[];
  };
  /** clarify_slot: lead de otro país; “a las 11” puede ser la hora del negocio o la suya. Se le pregunta cuál. */
  ambiguousTime?: string;
  /**
   * clarify_slot: esa hora (`ambiguousTime`) no se le ofreció: se le pregunta solo de qué país es, sin escribirla en
   * cifras (no ha salido de la agenda), para buscar después huecos cerca de ella.
   */
  askZoneOnly?: boolean;
  /** handle_objection: la misma objeción por tercera vez. No se insiste: se respeta y no se vuelve a proponer la llamada. */
  closesObjection?: boolean;
  /** offer_slots/reschedule: acaba de rechazar los horarios ofrecidos (“el lunes no puedo”): nada de “Genial” ni “Perfecto”. */
  afterRejection?: boolean;
  /** post_booking: desiste de mover la llamada o confirma la que tiene; sigue en pie y no se le ofrecen más horarios. */
  keepsBooking?: boolean;
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

/** Fecha local (YYYY-MM-DD) de un instante en la zona del negocio. */
const localDate = (instant: string | Date, tz: string) =>
  (typeof instant === 'string' ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant)).setZone(tz).toISODate();

/**
 * El día (y la hora o la franja, si las da) que menciona es el de la llamada que ya tiene (“Vale, el lunes” con la
 * llamada el lunes, “¿me llamáis a las 18:00?” con la llamada a las 18:00): confirma la cita, no pide moverla.
 */
function sameAsBooked(analysis: LeadAnalysis, startsAt: Date, tz: string, now: Date): boolean {
  const booked = DateTime.fromJSDate(startsAt).setZone(tz);
  if (!analysis.preferredDate && !analysis.preferredTime && !analysis.preferredPartOfDay) return false;
  // “El jueves” dicho un jueves se entiende como el de la semana que viene; si la llamada es hoy, es la de hoy.
  const today = DateTime.fromJSDate(now).setZone(tz).startOf('day');
  const bookedToday = booked.toISODate() === today.toISODate();
  const sameDay = analysis.preferredDate === booked.toISODate() || (bookedToday && analysis.preferredDate === today.plus({ days: 7 }).toISODate());
  if (analysis.preferredDate && !sameDay) return false;
  if (analysis.preferredPartOfDay && partOfDay(startsAt, tz) !== analysis.preferredPartOfDay) return false;
  if (analysis.preferredTime) {
    const [h, m] = analysis.preferredTime.split(':').map(Number);
    // “a las 6” puede ser las 6:00 o las 18:00 (si no dice la franja).
    const hourOk = h === booked.hour || (!analysis.preferredPartOfDay && h < 12 && h + 12 === booked.hour);
    if (!hourOk || m !== booked.minute) return false;
  }
  return true;
}

/**
 * Consulta de agenda según lo que pide, sin los días que ha descartado: el que dice que no puede (“el lunes no
 * puedo”) o, si rechaza la oferta sin decir cuál (“ninguna me va bien”, “¿no tienes otro día?”), los de esa oferta.
 */
function slotQueryFor(
  analysis: LeadAnalysis | null,
  offer: { start: string }[],
  tz: string,
  foreignLead: boolean,
  state: SetterState,
  now: Date,
): NonNullable<Directive['slotQuery']> {
  const today = localDate(now, tz)!;
  // Lo que ya descartó antes en esta búsqueda (sin esto, tras dos “ninguna” volvería la primera oferta).
  const excluded = new Set<string>((state.rejectedDates ?? []).filter((d) => d >= today));
  const excludedTimes = new Set<string>((state.rejectedTimes ?? []).filter((t) => !/^\d{4}-/.test(t) || t.slice(0, 10) >= today));
  for (const t of analysis?.rejectedTimes ?? []) excludedTimes.add(t);
  if (analysis?.excludedDate) excluded.add(analysis.excludedDate);
  // Rechaza la oferta sin decir qué día (“ninguna me va bien”): fuera los días ofrecidos. Si solo rechaza una hora
  // (“a las 10 no puedo”), se descarta esa hora, no el día entero.
  if (analysis?.rejectsOffer && !analysis.excludedDate && !analysis.preferredDate && !analysis.rejectedTimes?.length) for (const s of offer) excluded.add(localDate(s.start, tz)!);
  if (analysis?.preferredDate) excluded.delete(analysis.preferredDate);
  // Lo que pide ahora pesa más que lo que descartó antes (“¿me podéis llamar a las 10?” tras “a las 10 no puedo”).
  if (analysis?.preferredTime) {
    excludedTimes.delete(analysis.preferredTime);
    if (analysis.preferredDate) excludedTimes.delete(`${analysis.preferredDate} ${analysis.preferredTime}`);
  }
  // “No puedo antes de las 18:00”: se le ofrecen primero los huecos más cercanos a esa hora (los anteriores, nunca).
  const notBefore = [...excludedTimes].filter((t) => t.startsWith('<')).map((t) => t.slice(1)).sort().pop();
  const time = analysis?.preferredTime ?? notBefore;
  // Con un lead de otro país, “a las 10” puede ser su hora: no se busca por ella, salvo que ya se sepa de qué zona es
  // (“las 10 de México”, o “la mía” al preguntárselo: el análisis la pasa a la hora del negocio).
  const unknownZone = foreignLead && !(analysis?.preferredTime && analysis.timeInBusinessZone);
  // Franja que dice que no puede (“por la mañana no puedo”) y no pide otra: se buscan en la contraria.
  const avoidPart = analysis?.rejectedPartOfDay;
  const partOfDay = analysis?.preferredPartOfDay ?? (avoidPart ? (avoidPart === 'afternoon' ? 'morning' : 'afternoon') : partOfDayOfTime(time, unknownZone));
  return {
    date: analysis?.preferredDate ?? null,
    partOfDay,
    ...(excluded.size ? { excludeDates: [...excluded].sort() } : {}),
    ...(excludedTimes.size ? { excludeTimes: [...excludedTimes].sort() } : {}),
    ...(time && !unknownZone ? { time } : {}),
  };
}

/**
 * Franja de una hora concreta que pide sin decir la franja (“¿me podéis llamar a las 10?” → mañana), con los mismos
 * cortes que la agenda. Entre la 1 y las 7 no se sabe si es de mañana o de tarde, y si escribe desde otro país la
 * hora puede ser la suya: entonces 'any' (se le ofrecen los huecos más cercanos).
 */
function partOfDayOfTime(time: string | null | undefined, foreignLead: boolean): NonNullable<Directive['slotQuery']>['partOfDay'] {
  const h = time ? Number(time.split(':')[0]) : NaN;
  if (foreignLead || Number.isNaN(h) || (h >= 1 && h < 8)) return 'any';
  return h < 14 ? 'morning' : h < 19 ? 'afternoon' : 'evening';
}

/** Instrucción adicional para la IA cuando el lead ha descartado días u horarios. */
function exclusionNote(query: NonNullable<Directive['slotQuery']>, rejected: boolean, tz: string): string {
  const days = (query.excludeDates ?? []).map((d) => DateTime.fromISO(d, { zone: tz }).setLocale('es').toFormat('cccc d'));
  const parts: string[] = [];
  if (rejected) parts.push('Acaba de decirte que los horarios que le ofreciste no le van: no empieces con “Genial” ni “Perfecto” (mejor algo como “Sin problema”) y no le repitas esos horarios.');
  if (days.length) parts.push(`No le ofrezcas horarios del ${days.join(' ni del ')}: ha dicho que ese día no puede (o ya los descartó).`);
  const times = (query.excludeTimes ?? []).map((t) =>
    t.startsWith('<')
      ? `antes de las ${t.slice(1)}`
      : t.startsWith('>')
        ? `después de las ${t.slice(1)}`
        : /^\d{4}-/.test(t)
          ? `el ${DateTime.fromISO(t.slice(0, 10), { zone: tz }).setLocale('es').toFormat('cccc d')} a las ${t.slice(11)}`
          : `a las ${t}`,
  );
  if (times.length) parts.push(`Tampoco le ofrezcas horarios ${times.join(' ni ')}: ha dicho que a esa hora no puede.`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function clarifyDirective(
  slots: { start: string; id: string }[],
  timezone: string,
  answerQuestionFirst: boolean,
  now: Date,
  leadPhone?: string | null,
  ambiguousTime?: string | null,
): Directive {
  // Etiquetas recalculadas ahora: “mañana” de ayer es “hoy”. Con un lead de otro país, con su hora también.
  const offered = slots.map((s) => `“${humanSlotLabel(s.start, timezone, now, { leadPhone })}”`).join(' o ');
  if (ambiguousTime) {
    // Con el nombre de cada país (“¿las 11:00 de España o las 11:00 de México?”): “de aquí” sería ambiguo para él.
    const ours = `de ${zonePlace(timezone)}`;
    const country = leadZone(leadPhone, timezone, now)?.country;
    const theirs = country ? `de ${country}` : 'de su país';
    return {
      kind: 'clarify_slot',
      ambiguousTime,
      instruction: `Ya le ofreciste estos horarios: ${offered}. Ha dicho “a las ${ambiguousTime}”, pero escribe desde otro país y esa hora puede ser la de aquí o la suya, y cada una es un horario distinto. No reserves nada ni consultes la agenda: pregúntale, en UNA sola pregunta, si se refiere a las ${ambiguousTime} ${ours} o a las ${ambiguousTime} ${theirs}.`,
      answerQuestionFirst,
    };
  }
  return {
    kind: 'clarify_slot',
    instruction: `Ya le ofreciste estos horarios: ${offered}. No vuelvas a consultar la agenda: pregúntale de forma natural (y distinta a tu mensaje anterior) cuál le viene mejor, o si prefiere otro día.`,
    answerQuestionFirst,
  };
}

export function decideDirective(input: StrategyInput): Directive {
  const { biz, leadCtx, state, analysis } = input;
  const lead = leadCtx.lead;
  // Horas que lee el lead: si escribe desde otro país, con la zona del negocio y su hora (“18:00, hora de España; en México, a las 10:00”).
  const leadPhone = lead.whatsappId ?? lead.phone;
  const foreignLead = Boolean(leadZone(leadPhone, biz.business.timezone, input.now ?? new Date()));
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
    const label = humanSlotLabel(slot.start, biz.business.timezone, now, { leadPhone });
    return {
      kind: 'book_slot',
      slotId: slot.id,
      instruction: `El lead ha elegido el horario “${label}” (slot_id ${slot.id}). Llama a la herramienta ${leadCtx.upcomingAppointment ? 'reschedule_call' : 'book_call'} con ese slot_id y, según el resultado, confirma la cita de forma breve y cercana (o, si no está disponible, ofrece las alternativas que devuelva get_available_slots). No hagas más preguntas de cualificación.`,
    };
  }

  const offer = recentOffer(state, now, minNotice);
  // Lead de otro país: “a las 11” encaja con un horario en la hora de aquí y con otro en la suya. Se le pregunta cuál.
  if (analysis?.ambiguousSlotTime && offer.length) return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst, now, leadPhone, analysis.ambiguousSlotTime);
  // Pide un día, una franja o una hora (“mejor a las 18”, “a las 11 me va bien” cuando se le ofrecieron otras).
  const hasPreference = Boolean(analysis?.preferredDate || analysis?.preferredPartOfDay || analysis?.preferredTime);
  // Lo que pide ya lo cumplen todos los horarios que se le acaban de ofrecer (“mejor el jueves” y los dos son el
  // jueves): consultar otra vez la agenda devolvería los mismos y repetiría el mensaje. Se le pregunta cuál prefiere.
  const tz = biz.business.timezone;
  // La hora, en la zona del negocio o (lead de otro país) en la suya.
  const leadTz = leadZone(leadPhone, tz, now)?.timezone;
  const atTime = (start: string, time: string) => [tz, ...(leadTz ? [leadTz] : [])].some((z) => DateTime.fromISO(start).setZone(z).toFormat('HH:mm') === time);
  const offerFitsPreference =
    hasPreference &&
    offer.length > 0 &&
    offer.every(
      (s) =>
        (!analysis?.preferredDate || DateTime.fromISO(s.start).setZone(tz).toISODate() === analysis.preferredDate) &&
        (!analysis?.preferredPartOfDay || partOfDay(new Date(s.start), tz) === analysis.preferredPartOfDay) &&
        (!analysis?.preferredTime || atTime(s.start, analysis.preferredTime)),
    );
  const newPreference = hasPreference && !offerFitsPreference;

  // 2) Ya tiene una llamada agendada.
  if (leadCtx.upcomingAppointment) {
    const appt = leadCtx.upcomingAppointment;
    const when = humanSlotLabel(appt.startsAt, biz.business.timezone, now, { leadPhone });
    // Da el día (u hora) de la llamada que ya tiene sin pedir cambiarla (“Vale, el lunes”): no es moverla.
    const confirmsBooked = Boolean(analysis?.rescheduleImplicit) && sameAsBooked(analysis!, appt.startsAt, tz, now);
    const apptDate = localDate(appt.startsAt, tz);
    // Desiste de moverla (“mejor la dejamos como estaba”, “déjala como está”) o confirma la que tiene: la llamada sigue
    // en pie y no se le repiten los horarios ofrecidos (si la oferta trae ese mismo día, se le pregunta cuál prefiere).
    // Pedir cancelarla (“cancela la llamada del lunes”) nunca es mantenerla.
    const keepsBooking =
      !flags?.wantsCancel && (Boolean(analysis?.keepsAppointment) || (confirmsBooked && !offer.some((s) => localDate(s.start, tz) === apptDate)));
    // Dice que el día de su llamada no puede (“el lunes no puedo hacer la llamada”): es moverla. Con IA, solo si la IA
    // también lo entiende así (pide moverla): una coletilla como “¿es mañana, no?” confirma la cita.
    const cannotThatDay =
      Boolean(analysis?.excludedDate) && analysis?.excludedDate === apptDate && (analysis?.engine !== 'llm' || Boolean(flags?.wantsReschedule));
    // O a esa hora o en esa franja (“a las 18:00 no puedo”, “por la mañana no puedo” con la llamada a las 10:00).
    const cannotThatTime =
      matchesRejectedTime(appt.startsAt, tz, analysis?.rejectedTimes ?? []) || (Boolean(analysis?.rejectedPartOfDay) && analysis?.rejectedPartOfDay === partOfDay(appt.startsAt, tz));
    const wantsReschedule = (Boolean(flags?.wantsReschedule) || cannotThatDay || cannotThatTime) && !keepsBooking && !confirmsBooked;
    if (flags?.wantsCancel && !wantsReschedule) {
      return {
        kind: 'cancel_booking',
        instruction:
          'El lead pide cancelar su llamada. Usa cancel_call y confírmale con amabilidad que queda cancelada. Sin insistir ni proponer otra fecha (salvo que la pida), dile que si más adelante quiere retomarlo puede escribirte por aquí.',
        answerQuestionFirst,
      };
    }
    // Dice que no quiere la llamada (sin pedir cancelarla ni moverla): se le pregunta antes de tocar nada.
    if (flags?.declinesCall && !wantsReschedule && !flags.wantsCancel && !keepsBooking) {
      return {
        kind: 'confirm_cancel',
        instruction: `El lead tiene la ${settings.callLabel} agendada (${when}) y dice que no quiere hacerla. NO la canceles todavía ni uses herramientas: respóndele con naturalidad y pregúntale, en UNA sola pregunta, si quiere que la canceles o prefiere moverla a otro día. Sin insistir ni presionar.`,
        answerQuestionFirst,
      };
    }
    if (keepsBooking && !flags?.asksPrice) {
      return {
        kind: 'post_booking',
        keepsBooking: true,
        instruction: `El lead mantiene la ${settings.callLabel} como estaba (${when}). Confírmale con naturalidad que sigue en pie ese día y a esa hora. No le ofrezcas otros horarios ni le preguntes cuál prefiere, y no uses herramientas de agenda.`,
        answerQuestionFirst,
      };
    }
    // Está eligiendo otra fecha para mover la llamada (ya se le ofrecieron horarios): nueva preferencia o rechazo de
    // los ofrecidos (“el martes no puedo”, “ninguna me va bien”) → consultar la agenda otra vez; si solo duda entre los
    // ofrecidos → preguntarle cuál le viene mejor. Si habla de otra cosa (“gracias”, otro tema), no se le repite la oferta.
    if (offer.length && !flags?.asksPrice && analysis?.aboutSchedule !== false) {
      if (newPreference || analysis?.rejectsOffer || (wantsReschedule && !offerFitsPreference)) {
        const slotQuery = slotQueryFor(analysis, offer, tz, foreignLead, state, now);
        return {
          kind: 'reschedule',
          needsSlots: true,
          slotQuery,
          ...(analysis?.rejectsOffer ? { afterRejection: true } : {}),
          instruction: `El lead está buscando otro horario para mover su llamada. Consulta get_available_slots con su preferencia y ofrécele 2 alternativas reales. Si elige una, usa reschedule_call.${exclusionNote(slotQuery, Boolean(analysis?.rejectsOffer), tz)}`,
          answerQuestionFirst,
        };
      }
      return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst, now, leadPhone);
    }
    if (wantsReschedule || flags?.wantsCancel) {
      const slotQuery = slotQueryFor(analysis, [], tz, foreignLead, state, now);
      return {
        kind: 'reschedule',
        needsSlots: true,
        slotQuery,
        instruction: `El lead quiere mover (o no puede asistir a) su llamada. Sin dramas: consulta huecos con get_available_slots y ofrécele 2 alternativas para reprogramar (si pide otro día sin decir cuál, que no sean del mismo día de su llamada). Si elige una, usa reschedule_call. Solo usa cancel_call si pide cancelar explícitamente y no quiere otra hora.${exclusionNote(slotQuery, false, tz)}`,
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
      // La misma objeción por tercera vez: no se vuelve a sondear ni a proponer la llamada (sería insistir). Se respeta
      // y se le deja la puerta abierta; el motor lo recuerda para no volver a venderle la llamada después.
      if ((state.objectionsHandled ?? []).filter((k) => k === objection.key).length >= 2) {
        return {
          kind: 'handle_objection',
          objection,
          closesObjection: true,
          instruction: `El lead vuelve a plantear la objeción “${objection.label}” por tercera vez. No insistas ni vuelvas a sondear: respétalo con naturalidad, sin preguntas, y déjale la puerta abierta para retomarlo cuando quiera. No propongas la llamada.`,
        };
      }
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

  // 6) Quiere la llamada / propone día → consultar agenda real (o aclarar la oferta reciente). Si rechaza los horarios
  // que se le acaban de ofrecer (“el lunes no puedo”, “ninguna me va bien”), sigue queriendo la llamada: otros horarios,
  // nunca los mismos (repetírselos sería un bucle).
  const rejectsOffer = Boolean(analysis?.rejectsOffer) && offer.length > 0 && !callDeclined;
  // Con horarios recién ofrecidos, pedir otro día u hora (“a las 11 me va bien”, sin que se le ofreciera) es seguir
  // queriendo la llamada a otra hora: se busca en la agenda, no se cambia de tema.
  const asksOtherSlot = offer.length > 0 && newPreference && Boolean(analysis?.aboutSchedule) && !callDeclined;
  // Lead de otro país que pide una hora sin decir de qué país es: se le pregunta antes de buscar (cada zona daría
  // huecos distintos y buscar sin la hora le volvería a ofrecer los mismos).
  const zoneCountry = foreignLead ? leadZone(leadPhone, tz, now)?.country : null;
  if (asksOtherSlot && zoneCountry && analysis?.preferredTime && !analysis.timeInBusinessZone && !analysis.preferredDate && !flags?.declinesCall) {
    return {
      kind: 'clarify_slot',
      ambiguousTime: analysis.preferredTime,
      askZoneOnly: true,
      instruction: `Ha pedido otra hora (“a las ${analysis.preferredTime}”) que no estaba entre las que le ofreciste, pero escribe desde otro país y no sabes si es la hora de ${zonePlace(tz)} o la de ${zoneCountry}. No reserves nada ni consultes la agenda: pregúntale, en UNA sola pregunta y sin escribir la hora en cifras, si esa hora es la de ${zonePlace(tz)} o la de ${zoneCountry}.`,
      answerQuestionFirst,
    };
  }
  if ((flags?.wantsCall || rejectsOffer || asksOtherSlot) && !flags?.declinesCall) {
    if (offer.length && !newPreference && !rejectsOffer) return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst, now, leadPhone);
    const slotQuery = slotQueryFor(analysis, rejectsOffer ? offer : [], tz, foreignLead, state, now);
    return {
      kind: 'offer_slots',
      needsSlots: true,
      slotQuery,
      ...(rejectsOffer ? { afterRejection: true } : {}),
      instruction: `El lead quiere agendar la ${settings.callLabel}. Llama a get_available_slots${analysis?.preferredDate ? ` con date=${analysis.preferredDate}` : ''}${analysis?.preferredPartOfDay ? ` y part_of_day=${analysis.preferredPartOfDay}` : ''} y ofrécele 2 opciones con las etiquetas EXACTAS que devuelva (p. ej. “Mañana tengo las 18:00 o las 19:30. ¿Cuál te viene mejor?”). Si no hay huecos ese día, ofrece las alternativas más cercanas. Nunca inventes horarios.${exclusionNote(slotQuery, rejectsOffer, tz)}`,
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
    if (offer.length && !newPreference) return clarifyDirective(offer, biz.business.timezone, answerQuestionFirst, now, leadPhone);
    const slotQuery = slotQueryFor(analysis, [], tz, foreignLead, state, now);
    return {
      kind: 'offer_slots',
      needsSlots: true,
      slotQuery,
      instruction: `Ya se le propuso la llamada. Si su mensaje es una aceptación o una duda sobre ella, consulta get_available_slots y ofrece 2 horarios reales. Si habla de otra cosa, respóndele primero con naturalidad.${exclusionNote(slotQuery, false, tz)}`,
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

  // Acaba de cerrar una objeción sin insistir (“cuando te venga mejor, me escribes”) y el lead solo contesta (“Vale”,
  // “Gracias”), sin contar nada nuevo ni preguntar: seguir cualificando ahora sería insistir. Se sigue por aquí, sin
  // preguntas. Solo justo después del cierre: si vuelve a escribir días más tarde, la conversación sigue con normalidad.
  const objectionClosed =
    Boolean(state.callDeclinedAt) &&
    now.getTime() - Date.parse(state.callDeclinedAt!) < 12 * 3_600_000 &&
    (state.objectionsHandled ?? []).some((k, _, all) => all.filter((x) => x === k).length >= 3);
  if (objectionClosed && analysis && !flags?.asksQuestion && !flags?.wantsCall && !Object.keys(analysis.qualification ?? {}).length) {
    return keepTalking(answerQuestionFirst);
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
