/**
 * Revisión nº6 (análisis de horarios del setter). Cada bloque cubre un hallazgo verificado:
 *  - acotar el horario («no puedo hacer llamadas en horario de trabajo», «no puedo antes de las 18:00») no es rechazar
 *    la llamada, y con cita nunca la cancela;
 *  - la coletilla «¿es mañana, no?» confirma la cita (con y sin IA);
 *  - una hora rechazada («a las 10 no puedo») no es la preferencia ni descarta el día entero;
 *  - «Mañana no, mejor el lunes» nunca reserva mañana;
 *  - «¿Cuándo sería la llamada?» tras proponerla es aceptarla;
 *  - los días y horas descartados se recuerdan entre ofertas (no vuelven las de antes);
 *  - lead de otro país: si «a las 11» puede ser dos horarios, se pregunta (y se entiende la respuesta);
 *  - «Mañana te confirmo si puedo hacer la llamada» no mueve la cita;
 *  - con la llamada hoy, «el lunes a las 17» (dicho el lunes) la confirma.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { analyzeHeuristically, analyzeWithLLM, matchOfferedSlot, type AnalysisSchema } from '../../src/ai/analysis/analyzer.js';
import { decideDirective, type SetterState, type StrategyInput } from '../../src/ai/setter/strategy.js';
import { pickOfferSlots, timeIsExcluded } from '../../src/calendar/availability.js';
import type { LLMProvider } from '../../src/ai/providers/types.js';
import type { MessageRow } from '../../src/ai/context/context.js';
import { MADRID, NOW, hm, local, makeAnalysis, makeAnalysisInput, makeAppointment, makeBusinessContext, makeLead, makeLeadContext, makeMessage, offeredAt, slotAt } from './factories.js';

/** Mensaje de KAI con la directiva con que se envió. */
const kai = (content: string, directive: string) => makeMessage({ direction: 'outbound', content, metadata: { directive } });
const PROPOSAL = kai('Por lo que me cuentas, creo que tendría sentido verlo en una llamada de valoración de 30 minutos con Álex. ¿Te encaja?', 'propose_call');
const CONFIRM_CANCEL = kai('Sin problema. ¿Quieres que cancele la llamada o prefieres que la movamos a otro día?', 'confirm_cancel');
const PROPOSED: SetterState = { callProposedAt: '2026-10-05T09:00:00.000Z' };
const MEXICAN = '5215512345678';

interface Turn {
  history?: MessageRow[];
  state?: SetterState;
  /** Inicio de la llamada que ya tiene. */
  appt?: Date;
  whatsappId?: string;
  now?: Date;
}

/** Análisis sin IA del mensaje y directiva que decide la estrategia con él. */
function turn(text: string, t: Turn = {}) {
  const lead = makeLead(t.whatsappId ? { whatsappId: t.whatsappId } : {});
  const now = t.now ?? NOW;
  const state = t.state ?? {};
  const analysis = analyzeHeuristically(makeAnalysisInput(text, { history: t.history ?? [], state, lead, now }));
  const directive = decide(analysis, { ...t, state, now }, lead);
  return { analysis, directive };
}

function decide(analysis: StrategyInput['analysis'], t: Turn, lead = makeLead(t.whatsappId ? { whatsappId: t.whatsappId } : {})) {
  return decideDirective({
    biz: makeBusinessContext(),
    leadCtx: makeLeadContext({ lead, upcomingAppointment: t.appt ? makeAppointment({ startsAt: t.appt }) : null }),
    state: t.state ?? {},
    analysis,
    kaiHasSpoken: true,
    now: t.now ?? NOW,
  });
}

/** Oferta reciente (KAI la acaba de enviar) con estos horarios. */
function offer(...slots: ReturnType<typeof offeredAt>[]): SetterState {
  return { offeredSlots: slots, lastOfferIds: slots.map((s) => s.id), offeredAt: NOW.toISOString(), callProposedAt: '2026-10-05T09:00:00.000Z' };
}
const offerMsg = (text: string) => kai(text, 'offer_slots');

// ───────────── IA falsa ─────────────

type LlmResult = z.infer<typeof AnalysisSchema>;
function llmResult(flags: Partial<LlmResult['flags']> = {}, extra: Partial<LlmResult> = {}): LlmResult {
  return {
    qualification_updates: [],
    signals: { urgency: null, commitment: null, budget: null, fit: null, sentiment: null, intent: null },
    memories: [],
    flags: {
      human_request: false,
      asks_if_bot: false,
      medical_issue: false,
      angry: false,
      opt_out: false,
      asks_price: false,
      wants_call: false,
      declines_call: false,
      complex_negotiation: false,
      out_of_scope: false,
      technical_issue: false,
      wants_reschedule: false,
      wants_cancel: false,
      asks_question: false,
      ...flags,
    },
    objection_key: null,
    lead_name: null,
    goal_summary: null,
    preferred_date: null,
    preferred_part_of_day: null,
    selected_slot_id: null,
    summary: 'IA falsa',
    ...extra,
  };
}
function fakeProvider(result: LlmResult): LLMProvider {
  return {
    id: 'fake',
    describe: () => ({ provider: 'fake', mainModel: 'fake', fastModel: 'fake' }),
    chat: async () => {
      throw new Error('no se usa');
    },
    structured: (async () => result) as LLMProvider['structured'],
  };
}

// ───────────── 1. Acotar el horario no es rechazar la llamada ─────────────

describe('acotar cuándo puede no es rechazar la llamada', () => {
  const proposed = { history: [PROPOSAL], state: PROPOSED };

  it('«No puedo hacer llamadas en horario de trabajo, ¿podría ser por la tarde?» acepta la llamada y pide la tarde', () => {
    const { analysis, directive } = turn('No puedo hacer llamadas en horario de trabajo, ¿podría ser por la tarde?', proposed);
    expect(analysis.flags.declinesCall).toBe(false);
    expect(analysis.flags.wantsCall).toBe(true);
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.partOfDay).toBe('afternoon');
  });

  it('«Sí, pero no puedo hacer llamadas antes de las 18:00» busca desde las 18:00, nunca antes', () => {
    const { analysis, directive } = turn('Sí, pero no puedo hacer llamadas antes de las 18:00', proposed);
    expect(analysis.flags.declinesCall).toBe(false);
    expect(analysis.rejectedTimes).toEqual(['<18:00']);
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.excludeTimes).toEqual(['<18:00']);
    expect(directive.slotQuery?.time).toBe('18:00');
    expect(directive.instruction).toMatch(/antes de las 18:00/);
    expect(turn('Hasta las 18 no puedo', proposed).analysis.rejectedTimes).toEqual(['<18:00']);
    expect(turn('Después de las 20 no me va bien', proposed).analysis.rejectedTimes).toEqual(['>20:00']);
  });

  it('«Es que no puedo hacer llamadas por la mañana» tras proponerla: se le ofrecen horarios de tarde', () => {
    const { analysis, directive } = turn('Es que no puedo hacer llamadas por la mañana', proposed);
    expect(analysis.flags.declinesCall).toBe(false);
    expect(analysis.rejectedPartOfDay).toBe('morning');
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.partOfDay).toBe('afternoon');
  });

  it('rechazarla de verdad sigue siendo rechazarla', () => {
    for (const text of ['No quiero hacer llamadas', 'No puedo hacer llamadas', 'Sí, pero no quiero hacer llamadas', 'Prefiero seguir por aquí']) {
      const { analysis, directive } = turn(text, proposed);
      expect(analysis.flags.declinesCall, text).toBe(true);
      expect(directive.kind, text).toBe('continue_without_call');
    }
  });

  it('hablar de su entrenamiento («no puedo entrenar por la mañana») no descarta esa franja para la llamada', () => {
    const { analysis } = turn('No puedo entrenar por la mañana', proposed);
    expect(analysis.rejectedPartOfDay).toBeNull();
    expect(analysis.flags.wantsCall).toBe(false);
    const gym = turn('No puedo entrenar antes de las 18:00', { appt: local('2026-10-06T10:00') });
    expect(gym.analysis.rejectedTimes).toEqual([]);
    expect(gym.directive.kind).toBe('post_booking');
  });

  describe('con la llamada agendada (mañana a las 10:00) y KAI preguntando si cancelarla o moverla', () => {
    const booked = { history: [CONFIRM_CANCEL], appt: local('2026-10-06T10:00') };

    it('«Sí, pero no puedo hacer llamadas antes de las 18:00» la mueve a partir de las 18:00, no la cancela', () => {
      const { analysis, directive } = turn('Sí, pero no puedo hacer llamadas antes de las 18:00', booked);
      expect(analysis.flags.wantsCancel).toBe(false);
      expect(directive.kind).toBe('reschedule');
      expect(directive.slotQuery?.excludeTimes).toEqual(['<18:00']);
    });

    it('«Es que no puedo hacer llamadas por la mañana» la mueve a la tarde, no la cancela', () => {
      const { analysis, directive } = turn('Es que no puedo hacer llamadas por la mañana', booked);
      expect(analysis.flags.wantsCancel).toBe(false);
      expect(analysis.flags.declinesCall).toBe(false);
      expect(directive.kind).toBe('reschedule');
      expect(directive.slotQuery?.partOfDay).toBe('afternoon');
    });

    it('con la llamada por la tarde, «no puedo por la mañana» no la toca', () => {
      const { directive } = turn('Es que no puedo hacer llamadas por la mañana', { ...booked, appt: local('2026-10-06T18:00') });
      expect(directive.kind).toBe('post_booking');
    });

    it('un «sí» o volver a decir que no la quiere sí la cancela', () => {
      expect(turn('Sí', booked).directive.kind).toBe('cancel_booking');
      expect(turn('No quiero hacer llamadas', booked).directive.kind).toBe('cancel_booking');
    });
  });

  it('la agenda descarta los horarios antes (o después) del límite', () => {
    const slots = ['2026-10-06T10:00', '2026-10-06T17:30', '2026-10-06T18:00', '2026-10-06T20:30'].map((s) => slotAt(s));
    expect(pickOfferSlots(slots, MADRID, { count: 5, excludeTimes: ['<18:00'] }).map((s) => hm(s.start))).toEqual(['18:00', '20:30']);
    expect(pickOfferSlots(slots, MADRID, { count: 5, excludeTimes: ['>18:00'] }).map((s) => hm(s.start))).toEqual(['10:00', '17:30', '18:00']);
    expect(timeIsExcluded(local('2026-10-06T17:59'), MADRID, ['<18:00'])).toBe(true);
    expect(timeIsExcluded(local('2026-10-06T18:00'), MADRID, ['<18:00'])).toBe(false);
  });
});

// ───────────── 2. «¿Es mañana, no?» confirma la cita ─────────────

describe('la coletilla «¿…no?» confirma la cita, no la mueve', () => {
  it('sin IA: «¿La llamada era mañana, no?», «Es mañana no?», «Era el jueves no?», «Me llamáis hoy no?»', () => {
    const cases: [string, Date][] = [
      ['¿La llamada era mañana, no?', local('2026-10-06T17:00')],
      ['Es mañana no?', local('2026-10-06T17:00')],
      ['la llamada es mañana no?', local('2026-10-06T17:00')],
      ['Era el jueves no?', local('2026-10-08T17:00')],
      ['Me llamáis hoy no?', local('2026-10-05T17:00')],
    ];
    for (const [text, appt] of cases) {
      const { analysis, directive } = turn(text, { appt });
      expect(analysis.excludedDate, text).toBeNull();
      expect(directive.kind, text).toBe('post_booking');
    }
  });

  it('decir que ese día no puede sigue siendo moverla', () => {
    for (const text of ['Mañana no puedo', 'Mañana no, lo siento', 'Mañana imposible']) {
      const { analysis, directive } = turn(text, { appt: local('2026-10-06T17:00') });
      expect(analysis.excludedDate, text).toBe('2026-10-06');
      expect(directive.kind, text).toBe('reschedule');
    }
  });

  it('con IA: si la IA entiende que confirma la cita (ese día, sin pedir moverla), manda la IA', async () => {
    const appt = local('2026-10-06T17:00');
    const a = await analyzeWithLLM(fakeProvider(llmResult({}, { preferred_date: '2026-10-06' })), makeAnalysisInput('¿La llamada era mañana, no?'));
    expect(a.excludedDate).toBeNull();
    expect(a.preferredDate).toBe('2026-10-06');
    expect(decide(a, { appt }).kind).toBe('post_booking');
  });

  it('con IA: un día excluido por las reglas no mueve la cita si la IA no lo pide', () => {
    const a = makeAnalysis({ engine: 'llm', excludedDate: '2026-10-06' });
    expect(decide(a, { appt: local('2026-10-06T17:00') }).kind).toBe('post_booking');
    const b = makeAnalysis({ engine: 'llm', excludedDate: '2026-10-06', flags: { wantsReschedule: true } });
    expect(decide(b, { appt: local('2026-10-06T17:00') }).kind).toBe('reschedule');
  });
});

// ───────────── 3. Una hora rechazada ─────────────

describe('una hora que no puede no es su preferencia ni descarta el día', () => {
  const MON_10 = offeredAt('2026-10-12T10:00', MADRID, 'el lunes 12 a las 10:00');
  const MON_17 = offeredAt('2026-10-12T17:00', MADRID, 'el lunes 12 a las 17:00');
  const ctx = { history: [offerMsg('Tengo el lunes 12 a las 10:00 o a las 17:00. ¿Cuál te viene mejor?')], state: offer(MON_10, MON_17) };

  it('«El lunes a las 10 no puedo»: fuera esa hora de ese día, sin buscar por ella ni por el lunes', () => {
    const { analysis, directive } = turn('El lunes a las 10 no puedo', ctx);
    expect(analysis.preferredTime).toBeNull();
    expect(analysis.preferredDate).toBeNull();
    expect(analysis.rejectedTimes).toContain('2026-10-12 10:00');
    expect(analysis.rejectsOffer).toBe(true);
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.time).toBeUndefined();
    expect(directive.slotQuery?.excludeDates).toBeUndefined();
    expect(directive.slotQuery?.excludeTimes).toContain('2026-10-12 10:00');
  });

  it('«A las 17 no puedo» no descarta los días enteros de la oferta', () => {
    const { directive } = turn('A las 17 no puedo', ctx);
    expect(directive.slotQuery?.excludeDates).toBeUndefined();
    expect(directive.slotQuery?.excludeTimes).toEqual(['17:00']);
    expect(directive.slotQuery?.time).toBeUndefined();
  });

  it('«A las 10 no puedo, a las 17 sí» elige las 17:00', () => {
    const { analysis, directive } = turn('A las 10 no puedo, a las 17 sí', ctx);
    expect(analysis.selectedSlotId).toBe(MON_17.id);
    expect(directive.kind).toBe('book_slot');
  });

  it('con IA, la hora rechazada tampoco llega como preferencia', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult({ wants_call: true })), makeAnalysisInput('A las 10 no puedo', ctx));
    const d = decide(a, ctx);
    expect(d.kind).toBe('offer_slots');
    expect(d.slotQuery?.time).toBeUndefined();
    expect(d.slotQuery?.excludeDates).toBeUndefined();
    expect(d.slotQuery?.excludeTimes).toEqual(['10:00', '22:00']);
  });

  it('la agenda no ofrece la hora rechazada (cualquier día o solo ese día)', () => {
    const slots = ['2026-10-12T10:00', '2026-10-12T11:00', '2026-10-13T10:00'].map((s) => slotAt(s));
    expect(pickOfferSlots(slots, MADRID, { count: 5, excludeTimes: ['10:00'] }).map((s) => hm(s.start))).toEqual(['11:00']);
    expect(pickOfferSlots(slots, MADRID, { count: 5, excludeTimes: ['2026-10-12 10:00'] })).toHaveLength(2);
  });
});

// ───────────── 4. «Mañana no, mejor el lunes» ─────────────

describe('«Mañana no, mejor el lunes» nunca reserva mañana', () => {
  const TUE = offeredAt('2026-10-06T10:00', MADRID, 'mañana a las 10:00');
  const MON = offeredAt('2026-10-12T10:00', MADRID, 'el lunes 12 a las 10:00');
  const WED = offeredAt('2026-10-07T10:00', MADRID, 'el miércoles 7 a las 10:00');
  const msg = offerMsg('Tengo mañana a las 10:00 o el lunes 12 a las 10:00. ¿Cuál te viene mejor?');

  it('elige el lunes', () => {
    for (const text of ['Mañana no, mejor el lunes', 'Mañana no, el lunes me viene bien', 'Mejor el lunes, mañana no']) {
      const { analysis, directive } = turn(text, { history: [msg], state: offer(TUE, MON) });
      expect(analysis.selectedSlotId, text).toBe(MON.id);
      expect(directive.slotId, text).toBe(MON.id);
    }
  });

  it('«El lunes no, mejor el miércoles» elige el miércoles', () => {
    for (const text of ['El lunes no, mejor el miércoles', 'El lunes no, el miércoles me va mejor']) {
      expect(turn(text, { history: [msg], state: offer(WED, MON) }).analysis.selectedSlotId, text).toBe(WED.id);
    }
  });

  it('con el texto entero, «mañana no» basta para no elegir nada', () => {
    expect(matchOfferedSlot('manana no, mejor el lunes', [TUE, MON], MADRID, NOW, [TUE.id, MON.id])).toBeNull();
  });
});

// ───────────── 5. «¿Cuándo sería la llamada?» ─────────────

describe('preguntar cuándo sería la llamada es aceptarla', () => {
  const proposed = { history: [PROPOSAL], state: PROPOSED };

  it('tras proponerla, se le ofrecen horarios', () => {
    for (const text of ['¿Qué días tenéis para la llamada?', '¿Cuándo sería la llamada?', '¿Pero cuándo sería?', '¿A qué hora me llamaríais?']) {
      const { analysis, directive } = turn(text, proposed);
      expect(analysis.flags.wantsCall, text).toBe(true);
      expect(directive.kind, text).toBe('offer_slots');
    }
  });

  it('otras dudas no son aceptarla', () => {
    for (const text of ['¿Cuánto dura la llamada?', '¿Cuándo empezaría el programa?']) {
      expect(turn(text, proposed).analysis.flags.wantsCall, text).toBe(false);
    }
  });
});

// ───────────── 6. Rechazos acumulados ─────────────

describe('los días y horas descartados se recuerdan entre ofertas', () => {
  const TODAY_14 = offeredAt('2026-10-05T14:00', MADRID, 'hoy a las 14:00');
  const TODAY_19 = offeredAt('2026-10-05T19:00', MADRID, 'hoy a las 19:00');
  const TUE_10 = offeredAt('2026-10-06T10:00', MADRID, 'mañana a las 10:00');
  const TUE_14 = offeredAt('2026-10-06T14:00', MADRID, 'mañana a las 14:00');

  it('al segundo «ninguna» no vuelve la primera oferta', () => {
    // Primera oferta: hoy. La rechazó y el motor guardó ese día; segunda oferta: mañana.
    const state: SetterState = { ...offer(TODAY_14, TODAY_19, TUE_10, TUE_14), lastOfferIds: [TUE_10.id, TUE_14.id], rejectedDates: ['2026-10-05'] };
    const msg = offerMsg('Sin problema. Tengo mañana a las 10:00 o a las 14:00. ¿Cuál te viene mejor?');
    const { directive } = turn('Tampoco me va ninguna, ¿otro día?', { history: [msg], state });
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.excludeDates).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('al mover la cita, igual', () => {
    const state: SetterState = { ...offer(TUE_10, TUE_14), rejectedDates: ['2026-10-07'] };
    const msg = offerMsg('Sin problema, lo movemos. Tengo mañana a las 10:00 o a las 14:00. ¿Cuál te viene mejor?');
    const { directive } = turn('Ninguna me va bien', { history: [msg], state, appt: local('2026-10-08T18:00') });
    expect(directive.kind).toBe('reschedule');
    expect(directive.slotQuery?.excludeDates).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('si ahora pide un día u hora que descartó, manda lo que pide; los días ya pasados no cuentan', () => {
    const state: SetterState = { ...PROPOSED, rejectedDates: ['2026-10-01', '2026-10-07'], rejectedTimes: ['10:00', '22:00'] };
    const { directive } = turn('Sí, ¿me podéis llamar el miércoles a las 10?', { history: [PROPOSAL], state });
    expect(directive.kind).toBe('offer_slots');
    expect(directive.slotQuery?.date).toBe('2026-10-07');
    expect(directive.slotQuery?.excludeDates).toBeUndefined();
    expect(directive.slotQuery?.excludeTimes).toEqual(['22:00']);
    expect(directive.slotQuery?.time).toBe('10:00');
  });
});

// ───────────── 7. Lead de otro país ─────────────

describe('lead de otro país: «a las 11» puede ser dos horarios', () => {
  const AT_11 = offeredAt('2026-10-06T11:00', MADRID, 'mañana a las 11:00');
  const AT_19 = offeredAt('2026-10-06T19:00', MADRID, 'mañana a las 19:00');
  const msg = offerMsg('Tengo mañana a las 11:00 (hora de España; en México, a las 03:00) o mañana a las 19:00 (hora de España; en México, a las 11:00). ¿Cuál te viene mejor?');
  const ctx = { history: [msg], state: offer(AT_11, AT_19), whatsappId: MEXICAN };

  it('no reserva ninguno: le pregunta si son las 11:00 de España o las de México', () => {
    for (const text of ['A las 11 me va bien', 'La de las 11', 'A las 11 de la mañana', 'Mejor a las 11:00']) {
      const { analysis, directive } = turn(text, ctx);
      expect(analysis.selectedSlotId, text).toBeNull();
      expect(analysis.ambiguousSlotTime, text).toBe('11:00');
      expect(directive.kind, text).toBe('clarify_slot');
      expect(directive.ambiguousTime, text).toBe('11:00');
      expect(directive.instruction, text).toMatch(/las 11:00 de España o a las 11:00 de México/);
    }
  });

  it('si dice de qué hora habla, se reserva ese', () => {
    expect(turn('Las 11 de México', ctx).analysis.selectedSlotId).toBe(AT_19.id);
    expect(turn('A las 11, hora de aquí', ctx).analysis.selectedSlotId).toBe(AT_19.id);
    expect(turn('Las 11 de España', ctx).analysis.selectedSlotId).toBe(AT_11.id);
    expect(turn('La de las 19:00', ctx).analysis.selectedSlotId).toBe(AT_19.id);
  });

  it('y si contesta a la aclaración sin repetir la hora («la mía», «las de España»), se toma la de su mensaje anterior', () => {
    const history = [msg, makeMessage({ direction: 'inbound', content: 'A las 11 me va bien' }), kai('¿Te refieres a las 11:00 de España o a las 11:00 de México?', 'clarify_slot')];
    const after = { ...ctx, history };
    expect(turn('La mía', after).analysis.selectedSlotId).toBe(AT_19.id);
    expect(turn('Las de México', after).analysis.selectedSlotId).toBe(AT_19.id);
    expect(turn('Las de España', after).analysis.selectedSlotId).toBe(AT_11.id);
    expect(turn('La tuya', after).directive.slotId).toBe(AT_11.id);
  });

  it('un lead de España elige sin preguntar', () => {
    expect(turn('A las 11 me va bien', { ...ctx, whatsappId: undefined }).analysis.selectedSlotId).toBe(AT_11.id);
  });
});

// ───────────── 8. «Mañana te confirmo» no mueve la cita ─────────────

describe('decir que ya confirmará no es mover la llamada', () => {
  const booked = { appt: local('2026-10-08T18:00') }; // jueves 8 a las 18:00

  it('«Mañana te confirmo si puedo hacer la llamada», «Esta tarde miro lo de la llamada y te digo», «El miércoles te digo algo de la llamada»', () => {
    for (const text of ['Mañana te confirmo si puedo hacer la llamada', 'Esta tarde miro lo de la llamada y te digo', 'El miércoles te digo algo de la llamada']) {
      const { analysis, directive } = turn(text, booked);
      expect(analysis.flags.wantsReschedule, text).toBe(false);
      expect(directive.kind, text).toBe('post_booking');
    }
  });

  it('pedir la llamada otro día sí es moverla', () => {
    for (const text of ['La llamada mejor el martes', 'Llamadme el martes', 'Pasamos la llamada al martes']) {
      expect(turn(text, booked).directive.kind, text).toBe('reschedule');
    }
  });
});

// ───────────── 9. La llamada es hoy ─────────────

describe('con la llamada hoy, nombrar el día de hoy la confirma', () => {
  it('el lunes 5, con la llamada hoy a las 17:00: «Vale, el lunes a las 17» la confirma', () => {
    const appt = local('2026-10-05T17:00');
    expect(turn('Vale, el lunes a las 17', { appt }).directive.kind).toBe('post_booking');
    expect(turn('Vale, hoy a las 17', { appt }).directive.kind).toBe('post_booking');
    expect(turn('Mejor el lunes que viene', { appt }).directive.kind).toBe('reschedule');
  });

  it('el jueves 15, con la llamada hoy a las 17:00: «Vale, el jueves a las 17» la confirma', () => {
    const now = local('2026-10-15T10:00');
    expect(turn('Vale, el jueves a las 17', { appt: local('2026-10-15T17:00'), now }).directive.kind).toBe('post_booking');
  });
});
