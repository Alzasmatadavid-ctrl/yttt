import { describe, expect, it } from 'vitest';
import { decideDirective, nextQualificationRule, type StrategyInput } from '../../src/ai/setter/strategy.js';
import type { ConversationState } from '../../src/lib/domain.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import {
  makeAnalysis,
  makeAppointment,
  makeBusinessContext,
  makeLead,
  makeLeadContext,
  makeRules,
  makeSettings,
  offeredAt,
  qualificationOf,
} from './factories.js';

const REQUIRED = { goal: 'perder 10 kilos', problem: 'no tengo tiempo', motivation: 'mi boda' };

function input(overrides: Partial<StrategyInput> & { lead?: Parameters<typeof makeLead>[0] } = {}): StrategyInput {
  const { lead, ...rest } = overrides;
  return {
    biz: makeBusinessContext(),
    leadCtx: makeLeadContext({ lead: makeLead(lead) }),
    state: {},
    analysis: makeAnalysis(),
    kaiHasSpoken: true,
    ...rest,
  };
}

const decide = (overrides: Parameters<typeof input>[0] = {}) => decideDirective(input(overrides));

/** Oferta reciente (menos de 24 h) con dos horarios. */
function recentOfferState(hoursAgo = 1): ConversationState {
  const A = offeredAt('2026-10-06T18:00', 'Europe/Madrid', 'mañana a las 18:00');
  const B = offeredAt('2026-10-06T19:30', 'Europe/Madrid', 'mañana a las 19:30');
  return { offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString() };
}

describe('nextQualificationRule', () => {
  const rules = makeRules();

  it('devuelve la primera variable sin capturar en el orden configurado', () => {
    expect(nextQualificationRule(rules, makeLead())?.key).toBe('goal');
    expect(nextQualificationRule(rules, makeLead({ qualification: qualificationOf({ goal: 'x' }) }))?.key).toBe('current_situation');
  });

  it('salta las variables ya conocidas por señal (urgencia, compromiso…)', () => {
    const lead = makeLead({
      qualification: qualificationOf({ goal: 'a', current_situation: 'b', problem: 'c', motivation: 'd', previous_attempts: 'e', frustration: 'f' }),
      signals: { urgency: 'high' },
    });
    expect(nextQualificationRule(rules, lead)?.key).toBe('commitment');
  });

  it('nunca pregunta por el encaje, ni por reglas desactivadas o sin pregunta', () => {
    const custom = makeRules({ goal: { enabled: false }, current_situation: { question: '   ' } });
    expect(nextQualificationRule(custom, makeLead())?.key).toBe('problem');
    const allButFit = qualificationOf({ goal: 'a', current_situation: 'b', problem: 'c', motivation: 'd', previous_attempts: 'e', frustration: 'f', urgency: 'g', commitment: 'h', budget: 'i' });
    expect(nextQualificationRule(rules, makeLead({ qualification: allButFit }))).toBeNull();
  });

  it('respeta la lista de claves a saltar', () => {
    expect(nextQualificationRule(rules, makeLead(), ['goal', 'current_situation'])?.key).toBe('problem');
  });
});

describe('decideDirective', () => {
  it('primer contacto (formulario/anuncio): first_contact con la primera pregunta', () => {
    const d = decide({ isFirstContact: true, kaiHasSpoken: false, analysis: null });
    expect(d.kind).toBe('first_contact');
    expect(d.questionKey).toBe('goal');
    expect(d.question).toBe('¿Qué te gustaría conseguir exactamente?');
  });

  it('primer mensaje de KAI en una conversación: greet_and_ask con la siguiente regla', () => {
    const d = decide({ kaiHasSpoken: false, analysis: null });
    expect(d.kind).toBe('greet_and_ask');
    expect(d.questionKey).toBe('goal');
    expect(d.instruction).toContain('¿Qué te gustaría conseguir exactamente?');
  });

  it('greet_and_ask respeta lo que ya se sabe del lead', () => {
    const d = decide({ kaiHasSpoken: false, lead: { qualification: qualificationOf({ goal: 'perder 10 kilos' }) } });
    expect(d.kind).toBe('greet_and_ask');
    expect(d.questionKey).toBe('current_situation');
  });

  it('ask_qualification: pregunta la siguiente regla con su etiqueta y pregunta sugerida', () => {
    const d = decide({ lead: { qualification: qualificationOf({ goal: 'perder 10 kilos', current_situation: 'no entreno' }) } });
    expect(d.kind).toBe('ask_qualification');
    expect(d.questionKey).toBe('problem');
    expect(d.question).toBe('¿Y qué crees que te está impidiendo conseguirlo ahora?');
    expect(d.instruction).toContain('“Problema”');
  });

  it('marca answerQuestionFirst si el lead ha hecho una pregunta', () => {
    expect(decide({ analysis: makeAnalysis({ flags: { asksQuestion: true } }) }).answerQuestionFirst).toBe(true);
    expect(decide().answerQuestionFirst).toBe(false);
  });

  describe('reserva y citas', () => {
    it('book_slot cuando elige uno de los horarios ofrecidos', () => {
      const state = recentOfferState();
      const chosen = state.offeredSlots![1];
      const d = decide({ state, analysis: makeAnalysis({ selectedSlotId: chosen.id }) });
      expect(d.kind).toBe('book_slot');
      expect(d.slotId).toBe(chosen.id);
      expect(d.instruction).toContain(chosen.label);
      expect(d.instruction).toContain('book_call');
    });

    it('no reserva un horario que no se le ofreció', () => {
      const d = decide({ state: recentOfferState(), analysis: makeAnalysis({ selectedSlotId: 'slot_123456789' }) });
      expect(d.kind).not.toBe('book_slot');
    });

    it('elegir horario tiene prioridad incluso con una cita ya agendada (reprogramación)', () => {
      const state = recentOfferState();
      const d = decide({
        state,
        analysis: makeAnalysis({ selectedSlotId: state.offeredSlots![0].id }),
        leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }),
      });
      expect(d.kind).toBe('book_slot');
    });

    it('post_booking si ya tiene una llamada agendada (sin volver a ofrecer horarios)', () => {
      const d = decide({ leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }), analysis: makeAnalysis({ flags: { wantsCall: true } }) });
      expect(d.kind).toBe('post_booking');
    });

    // Con la llamada agendada, el precio no se oculta (sección 16): se da el real, sin volver a cualificar.
    it('con la llamada agendada, si pregunta el precio se le da (sin contextualizar ni proponer otra llamada)', () => {
      const d = decide({ leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }), analysis: makeAnalysis({ flags: { asksPrice: true, wantsCall: true } }), state: { priceAskedCount: 1 } });
      expect(d.kind).toBe('share_price');
      expect(d.instruction).toContain('ya tiene la llamada de valoración agendada');
    });

    it.each([{ wantsReschedule: true }, { wantsReschedule: true, wantsCancel: true }])('reschedule con cita agendada y %j', (flags) => {
      const d = decide({
        leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }),
        analysis: makeAnalysis({ flags, preferredDate: '2026-10-08', preferredPartOfDay: 'morning' }),
      });
      expect(d.kind).toBe('reschedule');
      expect(d.needsSlots).toBe(true);
      expect(d.slotQuery).toEqual({ date: '2026-10-08', partOfDay: 'morning' });
    });

    it('cancel_booking si pide cancelar (y no moverla)', () => {
      const d = decide({ leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }), analysis: makeAnalysis({ flags: { wantsCancel: true } }) });
      expect(d.kind).toBe('cancel_booking');
      expect(d.instruction).toContain('cancel_call');
    });
  });

  it('disqualify_kindly si no encaja (aunque quiera la llamada)', () => {
    const d = decide({ lead: { signals: { fit: 'no' } }, analysis: makeAnalysis({ flags: { wantsCall: true, asksPrice: true } }) });
    expect(d.kind).toBe('disqualify_kindly');
  });

  describe('objeciones', () => {
    it('handle_objection con la estrategia del entrenador', () => {
      const d = decide({ analysis: makeAnalysis({ objectionKey: 'expensive', flags: { asksPrice: true } }) });
      expect(d.kind).toBe('handle_objection');
      expect(d.objection?.key).toBe('expensive');
      expect(d.instruction).toContain('“Es caro”');
      expect(d.instruction).toContain('Nunca rebajar el precio');
    });

    it('una objeción desconocida o desactivada se ignora', () => {
      const d = decide({ analysis: makeAnalysis({ objectionKey: 'inventada' }) });
      expect(d.kind).not.toBe('handle_objection');
    });
  });

  describe('precio', () => {
    const asks = (extra: Parameters<typeof makeAnalysis>[0] = {}) => makeAnalysis({ ...extra, flags: { asksPrice: true, ...(extra.flags ?? {}) } });

    it('primera vez y sin cualificar: contextualiza y pregunta (contextualize_first)', () => {
      const d = decide({ analysis: asks(), state: { priceAskedCount: 1 } });
      expect(d.kind).toBe('price_contextualize');
      expect(d.questionKey).toBe('goal');
    });

    it('si insiste (segunda vez) da el precio', () => {
      expect(decide({ analysis: asks(), state: { priceAskedCount: 2 } }).kind).toBe('share_price');
    });

    it('si la política es dar el precio directamente, lo da', () => {
      const biz = makeBusinessContext({ settings: makeSettings({ pricePolicy: 'share_directly' }) });
      expect(decide({ biz, analysis: asks(), state: { priceAskedCount: 1 } }).kind).toBe('share_price');
    });

    it('con los datos obligatorios ya capturados, da el precio', () => {
      expect(decide({ analysis: asks(), state: { priceAskedCount: 1 }, lead: { qualification: qualificationOf(REQUIRED) } }).kind).toBe('share_price');
    });

    it('si ya se le dio el precio, se lo recuerda', () => {
      const d = decide({ analysis: asks(), state: { priceAskedCount: 1, priceShared: true } });
      expect(d.kind).toBe('share_price');
      expect(d.instruction).toContain('ya le diste');
    });
  });

  describe('agenda', () => {
    it('offer_slots cuando quiere la llamada, con su preferencia de día y franja', () => {
      const d = decide({ analysis: makeAnalysis({ flags: { wantsCall: true }, preferredDate: '2026-10-08', preferredPartOfDay: 'afternoon' }) });
      expect(d.kind).toBe('offer_slots');
      expect(d.needsSlots).toBe(true);
      expect(d.slotQuery).toEqual({ date: '2026-10-08', partOfDay: 'afternoon' });
      expect(d.instruction).toContain('date=2026-10-08');
      expect(d.instruction).toContain('part_of_day=afternoon');
    });

    it('sin preferencia consulta cualquier franja', () => {
      const d = decide({ analysis: makeAnalysis({ flags: { wantsCall: true } }) });
      expect(d.slotQuery).toEqual({ date: null, partOfDay: 'any' });
    });

    it('clarify_slot si ya se le ofrecieron horarios hace poco y no pide otro día', () => {
      const d = decide({ state: recentOfferState(), analysis: makeAnalysis({ flags: { wantsCall: true } }) });
      expect(d.kind).toBe('clarify_slot');
      expect(d.needsSlots).toBeUndefined();
      // Etiquetas recalculadas en el momento de responder (la oferta pudo hacerse ayer).
      const [A, B] = recentOfferState().offeredSlots!;
      expect(d.instruction).toContain(`“${humanSlotLabel(A.start, 'Europe/Madrid')}” o “${humanSlotLabel(B.start, 'Europe/Madrid')}”`);
    });

    it('si pide otro día, vuelve a consultar la agenda', () => {
      const d = decide({ state: recentOfferState(), analysis: makeAnalysis({ flags: { wantsCall: true }, preferredDate: '2026-10-09' }) });
      expect(d.kind).toBe('offer_slots');
    });

    it('una oferta de hace más de 24 h no cuenta como reciente', () => {
      const d = decide({ state: recentOfferState(25), analysis: makeAnalysis({ flags: { wantsCall: true } }) });
      expect(d.kind).toBe('offer_slots');
    });

    it('continue_without_call si rechaza la llamada', () => {
      const d = decide({ analysis: makeAnalysis({ flags: { wantsCall: true, declinesCall: true } }) });
      expect(d.kind).toBe('continue_without_call');
      expect(d.questionKey).toBe('goal');
    });
  });

  describe('proponer la llamada', () => {
    it('propose_call al cualificar (puntuación mínima + datos obligatorios)', () => {
      const d = decide({ lead: { score: 65, qualification: qualificationOf(REQUIRED) } });
      expect(d.kind).toBe('propose_call');
      expect(d.instruction).toContain('llamada de valoración de 30 minutos con Álex');
      expect(d.instruction).toContain('NO des horarios');
    });

    it('con puntuación insuficiente sigue cualificando', () => {
      const d = decide({ lead: { score: 50, qualification: qualificationOf(REQUIRED) } });
      expect(d.kind).toBe('ask_qualification');
      expect(d.questionKey).toBe('current_situation');
    });

    it('con puntuación alta pero sin los datos obligatorios sigue cualificando', () => {
      const d = decide({ lead: { score: 90, qualification: qualificationOf({ goal: 'x' }) } });
      expect(d.kind).toBe('ask_qualification');
    });

    it('si ya no queda nada por preguntar y tiene lo obligatorio, propone la llamada aunque la puntuación sea baja', () => {
      const everything = qualificationOf({ ...REQUIRED, current_situation: 'a', previous_attempts: 'b', frustration: 'c', urgency: 'd', commitment: 'e', budget: 'f' });
      expect(decide({ lead: { score: 10, qualification: everything } }).kind).toBe('propose_call');
    });

    it('usa la etiqueta y duración configuradas', () => {
      const biz = makeBusinessContext({ settings: makeSettings({ callLabel: 'sesión estratégica', callDurationMinutes: 45 }) });
      const d = decide({ biz, lead: { score: 65, qualification: qualificationOf(REQUIRED) } });
      expect(d.instruction).toContain('sesión estratégica de 45 minutos');
    });

    it('reassure_call si ya se propuso y no ha dicho que sí', () => {
      const d = decide({ state: { callProposedAt: new Date().toISOString() }, lead: { score: 65, qualification: qualificationOf(REQUIRED) } });
      expect(d.kind).toBe('reassure_call');
    });

    it('si ya se propuso y lo acepta, ofrece horarios', () => {
      const d = decide({
        state: { callProposedAt: new Date().toISOString() },
        lead: { score: 65, qualification: qualificationOf(REQUIRED) },
        analysis: makeAnalysis({ flags: { wantsCall: true } }),
      });
      expect(d.kind).toBe('offer_slots');
    });

    it('si ya se propuso y no hay análisis (mensaje proactivo), ofrece horarios', () => {
      const d = decide({ state: { callProposedAt: new Date().toISOString() }, lead: { score: 65, qualification: qualificationOf(REQUIRED) }, analysis: null });
      expect(d.kind).toBe('offer_slots');
      expect(d.needsSlots).toBe(true);
    });
  });
});
