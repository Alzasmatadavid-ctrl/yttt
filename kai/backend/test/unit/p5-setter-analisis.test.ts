/**
 * Ronda 5 (setter: análisis y estrategia). Cada bloque cubre un hallazgo verificado:
 * aceptar la llamada solo cuando se habla de ella, mover la llamada con naturalidad, rechazar los horarios ofrecidos,
 * desistir de moverla, confirmar la cita o el recordatorio, preguntas de precio, objetivo del primer mensaje,
 * respuestas que no son un objetivo y clientes que escriben desde otro número.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { analyzeHeuristically, analyzeWithLLM, type AnalysisSchema } from '../../src/ai/analysis/analyzer.js';
import { decideDirective, type StrategyInput } from '../../src/ai/setter/strategy.js';
import type { LLMProvider } from '../../src/ai/providers/types.js';
import type { ConversationState } from '../../src/lib/domain.js';
import {
  MADRID,
  NOW,
  local,
  makeAnalysis,
  makeAnalysisInput,
  makeAppointment,
  makeBusinessContext,
  makeLead,
  makeLeadContext,
  makeMessage,
  offeredAt,
  qualificationOf,
} from './factories.js';

const analyze = (...args: Parameters<typeof makeAnalysisInput>) => analyzeHeuristically(makeAnalysisInput(...args));
/** Mensaje de KAI con la directiva (o el tipo) con que se envió. */
const kai = (content: string, metadata: Record<string, unknown> = {}) => makeMessage({ direction: 'outbound', content, metadata });

const PROPOSAL = kai('Por lo que me cuentas, creo que tendría sentido verlo en una llamada de valoración de 20 minutos con Álex. ¿Te encaja?', {
  directive: 'propose_call',
});
const REASSURE = kai('Claro, sin ninguna prisa. La llamada de valoración es para que Álex conozca tu caso. ¿Qué duda te gustaría resolver antes?', {
  directive: 'reassure_call',
});
const COMMITMENT_Q = kai('Entendido. Si encontraras la forma de hacerlo, ¿estarías dispuesto a comprometerte de verdad unos meses?', {
  directive: 'ask_qualification',
});
const OBJECTION_MONEY = kai('Lo entiendo perfectamente. Si quieres, seguimos en contacto y lo retomamos cuando te encaje mejor.', {
  directive: 'handle_objection',
});
const PROPOSED: ConversationState = { callProposedAt: '2026-10-05T09:00:00.000Z' };

function input(overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    biz: makeBusinessContext(),
    leadCtx: makeLeadContext({ lead: makeLead() }),
    state: {},
    analysis: makeAnalysis(),
    kaiHasSpoken: true,
    now: NOW,
    ...overrides,
  };
}
const decide = (overrides: Partial<StrategyInput> = {}) => decideDirective(input(overrides));

/** Oferta reciente con los dos horarios el lunes 12 (NOW es el lunes 5 a las 12:00). */
const MON_A = offeredAt('2026-10-12T10:00', MADRID, 'el lunes 12 a las 10:00');
const MON_B = offeredAt('2026-10-12T17:00', MADRID, 'el lunes 12 a las 17:00');
const MONDAY_OFFER: ConversationState = {
  ...PROPOSED,
  offeredSlots: [MON_A, MON_B],
  lastOfferIds: [MON_A.id, MON_B.id],
  offeredAt: new Date(NOW.getTime() - 3600_000).toISOString(),
};
const OFFER_MSG = kai('Perfecto. Tengo el lunes 12 a las 10:00 o a las 17:00. ¿Cuál te viene mejor?', { directive: 'offer_slots' });

// ───────────── 1) Un “sí” solo acepta la llamada si KAI acababa de hablar de ella ─────────────

describe('análisis: aceptar o rechazar la llamada', () => {
  it.each(['No', 'No, gracias', 'Que no', 'Paso', 'Mejor no', 'De momento no', 'No, la verdad'])('un “no” corto a la propuesta es rechazarla: %j', (text) => {
    const a = analyze(text, { history: [PROPOSAL], state: PROPOSED });
    expect(a.flags.declinesCall).toBe(true);
    expect(a.flags.wantsCall).toBe(false);
  });

  it('también tras resolver sus dudas sobre la llamada (reassure_call)', () => {
    expect(analyze('No, gracias', { history: [REASSURE], state: PROPOSED }).flags.declinesCall).toBe(true);
  });

  it('tras el precio que termina proponiendo la llamada, “No, gracias” la rechaza', () => {
    const price = kai('Claro. El programa cuesta 149 € al mes. ¿Te gustaría verlo con Álex en una llamada de valoración?', { directive: 'share_price' });
    expect(analyze('No, gracias', { history: [price] }).flags.declinesCall).toBe(true);
  });

  it('un “no” a otra pregunta (compromiso) no es rechazar la llamada', () => {
    expect(analyze('No, gracias', { history: [COMMITMENT_Q], state: PROPOSED }).flags.declinesCall).toBe(false);
  });

  it('un “sí” a la pregunta de compromiso no abre la agenda aunque la llamada se propusiera antes', () => {
    expect(analyze('Sí, claro', { history: [COMMITMENT_Q], state: PROPOSED }).flags.wantsCall).toBe(false);
  });

  it('un “vale, gracias” a la objeción (“seguimos en contacto”) no es aceptar la llamada', () => {
    expect(analyze('Vale, gracias', { history: [OBJECTION_MONEY], state: PROPOSED }).flags.wantsCall).toBe(false);
  });

  it.each(['Ahora mismo no tengo tiempo para llamadas, ando muy liado', 'No tengo tiempo para una llamada', 'No puedo hacer llamadas', 'No quiero llamadas'])(
    'rechaza la llamada: %j',
    (text) => {
      const a = analyze(text, { history: [PROPOSAL], state: PROPOSED });
      expect(a.flags.declinesCall).toBe(true);
      expect(a.flags.wantsCall).toBe(false);
    },
  );

  it('sigue aceptando la llamada cuando KAI acaba de proponerla, ofrecer horarios o el entrenador la menciona', () => {
    expect(analyze('Sí', { history: [PROPOSAL], state: PROPOSED }).flags.wantsCall).toBe(true);
    expect(analyze('Vale', { history: [OFFER_MSG], state: MONDAY_OFFER }).flags.wantsCall).toBe(true);
    expect(analyze('Sí', { history: [kai('¿Te viene bien una llamada esta semana?')] }).flags.wantsCall).toBe(true);
  });

  it('estrategia: tras rechazar la llamada, un “sí” a otra pregunta no ofrece horarios', () => {
    const d = decide({ state: { ...PROPOSED, callDeclinedAt: '2026-10-05T09:30:00.000Z' }, analysis: makeAnalysis() });
    expect(['offer_slots', 'clarify_slot', 'propose_call', 'reassure_call']).not.toContain(d.kind);
  });
});

// ───────────── 2) Mover la llamada con naturalidad ─────────────

describe('análisis: pedir mover la llamada', () => {
  it('“¿La podemos mover?” es moverla (pronombre antepuesto)', () => {
    const a = analyze('¿La podemos mover?');
    expect(a.flags.wantsReschedule).toBe(true);
    expect(a.rescheduleImplicit).toBe(false);
  });

  it('“¿me podéis llamar a las 9 de la mañana?” es pedir otra hora', () => {
    const a = analyze('Una cosa, al final ¿me podéis llamar a las 9 de la mañana?');
    expect(a.flags.wantsReschedule).toBe(true);
    expect(a.preferredTime).toBe('09:00');
    expect(a.preferredPartOfDay).toBe('morning');
  });

  it('“¿Me puedes llamar el martes?” y “La llamada el martes a las 10, porfa” son pedir otro día', () => {
    for (const text of ['¿Me puedes llamar el martes?', 'La llamada el martes a las 10, porfa', '¿Y si la hacemos el martes?']) {
      const a = analyze(text);
      expect(a.flags.wantsReschedule, text).toBe(true);
      expect(a.preferredDate, text).toBe('2026-10-06');
    }
  });

  it('una cita con el médico ese día no es pedir mover la llamada', () => {
    expect(analyze('El martes tengo cita con el médico').flags.wantsReschedule).toBe(false);
  });
});

describe('estrategia: con la llamada agendada', () => {
  const appt = makeAppointment({ startsAt: local('2026-10-12T13:00') }); // lunes 12 a las 13:00
  const booked = makeLeadContext({ lead: makeLead(), upcomingAppointment: appt });

  it('pedir otra hora o día consulta la agenda con su preferencia', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Una cosa, al final ¿me podéis llamar a las 9 de la mañana?'));
    const d = decide({ leadCtx: booked, analysis: a });
    expect(d.kind).toBe('reschedule');
    expect(d.slotQuery?.partOfDay).toBe('morning');
    const b = analyzeHeuristically(makeAnalysisInput('¿Me puedes llamar el martes?'));
    expect(decide({ leadCtx: booked, analysis: b }).slotQuery?.date).toBe('2026-10-06');
  });

  it('“Vale, el lunes” con la llamada el lunes confirma la cita: no se ofrece moverla', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Vale, el lunes'));
    expect(a.rescheduleImplicit).toBe(true);
    const d = decide({ leadCtx: booked, analysis: a });
    expect(d.kind).toBe('post_booking');
    expect(d.keepsBooking).toBe(true);
  });

  it('“¿me llamáis a las 13:00?” con la llamada a las 13:00 tampoco la mueve; a las 9 sí', () => {
    const same = analyzeHeuristically(makeAnalysisInput('Vale, ¿me podéis llamar a las 13:00 el lunes?'));
    expect(decide({ leadCtx: booked, analysis: same }).kind).toBe('post_booking');
    const other = analyzeHeuristically(makeAnalysisInput('Vale, ¿me podéis llamar a las 9 el lunes?'));
    expect(decide({ leadCtx: booked, analysis: other }).kind).toBe('reschedule');
  });

  it('“Vale, el martes” con la llamada el lunes sí es moverla', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Vale, el martes'));
    expect(decide({ leadCtx: booked, analysis: a }).kind).toBe('reschedule');
  });

  it('pedirlo de forma explícita (“¿la podemos cambiar al lunes?”) se respeta aunque sea el mismo día', () => {
    const a = analyzeHeuristically(makeAnalysisInput('¿Podemos cambiar la llamada al lunes por la tarde?'));
    expect(a.rescheduleImplicit).toBe(false);
    expect(decide({ leadCtx: booked, analysis: a }).kind).toBe('reschedule');
  });

  it('“el lunes no puedo hacer la llamada” con la llamada el lunes es moverla, sin ofrecer ese día', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Al final el lunes no puedo hacer la llamada'));
    const d = decide({ leadCtx: booked, analysis: a });
    expect(d.kind).toBe('reschedule');
    expect(d.slotQuery?.excludeDates).toEqual(['2026-10-12']);
    expect(d.instruction).toContain('lunes 12');
  });
});

describe('análisis: respuestas al recordatorio', () => {
  const reminder = (kind: string) => kai('Te recuerdo que mañana tienes la llamada de valoración a las 13:00. ¿Todo bien?', { kind });

  it.each(['No se me olvida 😉', 'No faltaré, gracias', 'No te preocupes, allí estaré', 'No, todo bien', 'Claro que no se me olvida', 'No me olvido, gracias'])(
    'confirmar que irá no es pedir moverla: %j',
    (text) => {
      expect(analyze(text, { history: [reminder('reminder_24h')] }).flags.wantsReschedule).toBe(false);
      expect(analyze(text, { history: [reminder('reminder_1h')] }).flags.wantsReschedule).toBe(false);
    },
  );

  it.each(['No', 'No, tengo médico', 'Pues no', 'No me viene bien', 'Al final no puedo'])('un “no” al recordatorio sí es que no puede: %j', (text) => {
    expect(analyze(text, { history: [reminder('reminder_24h')] }).flags.wantsReschedule).toBe(true);
  });
});

// ───────────── 3) Rechazar los horarios ofrecidos ─────────────

describe('análisis: rechazar la oferta', () => {
  const ctx = { history: [OFFER_MSG], state: MONDAY_OFFER };

  it('“El lunes no puedo” no es su preferencia: es el día que descarta', () => {
    const a = analyze('El lunes no puedo, trabajo todo el día', ctx);
    expect(a.preferredDate).toBeNull();
    expect(a.excludedDate).toBe('2026-10-12');
    expect(a.rejectsOffer).toBe(true);
    expect(a.selectedSlotId).toBeNull();
  });

  it.each(['Ninguna me va bien', 'Que ninguna de las dos', '¿No tienes otro día?', 'Mejor otro día', 'No me viene bien'])('rechaza la oferta: %j', (text) => {
    const a = analyze(text, ctx);
    expect(a.rejectsOffer).toBe(true);
    expect(a.selectedSlotId).toBeNull();
  });

  it('“El lunes no puedo, mejor el martes” descarta el lunes y prefiere el martes', () => {
    const a = analyze('El lunes no puedo, mejor el martes', ctx);
    expect(a.excludedDate).toBe('2026-10-12');
    expect(a.preferredDate).toBe('2026-10-06');
  });

  it('elegir uno no es rechazar la oferta', () => {
    const a = analyze('La primera', ctx);
    expect(a.selectedSlotId).toBe(MON_A.id);
    expect(a.rejectsOffer).toBe(false);
  });

  it('con IA: el día que dice que no puede nunca queda como preferencia', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult({ wants_call: true }, { preferred_date: '2026-10-12' })), makeAnalysisInput('El lunes no puedo', ctx));
    expect(a.preferredDate).toBeNull();
    expect(a.excludedDate).toBe('2026-10-12');
    expect(a.rejectsOffer).toBe(true);
  });
});

describe('estrategia: rechazar la oferta', () => {
  it('sin cita: “el lunes no puedo” busca otros horarios sin el lunes (no repite la oferta)', () => {
    const a = analyzeHeuristically(makeAnalysisInput('El lunes no puedo, trabajo todo el día', { history: [OFFER_MSG], state: MONDAY_OFFER }));
    const d = decide({ state: MONDAY_OFFER, analysis: a });
    expect(d.kind).toBe('offer_slots');
    expect(d.needsSlots).toBe(true);
    expect(d.afterRejection).toBe(true);
    expect(d.slotQuery).toMatchObject({ date: null, excludeDates: ['2026-10-12'] });
    expect(d.instruction).toMatch(/no empieces con “Genial” ni “Perfecto”/);
  });

  it('sin cita: “ninguna me va bien” o “¿no tienes otro día?” descartan los días ofrecidos', () => {
    for (const text of ['Ninguna me va bien', 'Que ninguna de las dos', '¿No tienes otro día?']) {
      const a = analyzeHeuristically(makeAnalysisInput(text, { history: [OFFER_MSG], state: MONDAY_OFFER }));
      const d = decide({ state: MONDAY_OFFER, analysis: a });
      expect(d.kind, text).toBe('offer_slots');
      expect(d.slotQuery?.excludeDates, text).toEqual(['2026-10-12']);
    }
  });

  it('sin cita: aunque todavía falte cualificación, no abandona la oferta para volver a preguntar', () => {
    const lead = makeLead({ score: 0, qualification: qualificationOf({ goal: 'perder 10 kilos' }) });
    const a = analyzeHeuristically(makeAnalysisInput('¿No tienes otro día?', { history: [OFFER_MSG], state: MONDAY_OFFER }));
    expect(decide({ leadCtx: makeLeadContext({ lead }), state: MONDAY_OFFER, analysis: a }).kind).toBe('offer_slots');
  });

  it('sin rechazo, la duda entre los ofrecidos sigue aclarándose', () => {
    const lead = makeLead({ score: 90, qualification: qualificationOf({ goal: 'perder 10 kilos', problem: 'no tengo tiempo', motivation: 'mi boda' }) });
    const a = analyzeHeuristically(makeAnalysisInput('Mmm, no sé cuál', { history: [OFFER_MSG], state: MONDAY_OFFER }));
    expect(decide({ leadCtx: makeLeadContext({ lead }), state: MONDAY_OFFER, analysis: a }).kind).toBe('clarify_slot');
  });

  it('con cita: rechazar los horarios para moverla busca otros, sin el día descartado', () => {
    const appt = makeAppointment({ startsAt: local('2026-10-07T18:00') });
    const a = analyzeHeuristically(makeAnalysisInput('El lunes no puedo', { history: [OFFER_MSG], state: MONDAY_OFFER }));
    const d = decide({ leadCtx: makeLeadContext({ upcomingAppointment: appt }), state: MONDAY_OFFER, analysis: a });
    expect(d.kind).toBe('reschedule');
    expect(d.afterRejection).toBe(true);
    expect(d.slotQuery?.excludeDates).toEqual(['2026-10-12']);
  });
});

// ───────────── 4) Desistir de mover la llamada ─────────────

describe('desistir de mover la llamada (con horarios ofrecidos para moverla)', () => {
  const appt = makeAppointment({ startsAt: local('2026-10-07T18:00') });
  const booked = makeLeadContext({ upcomingAppointment: appt });
  const RESCHEDULE_MSG = kai('Sin problema, lo movemos. Tengo el lunes 12 a las 10:00 o a las 17:00. ¿Cuál te viene mejor?', { directive: 'reschedule' });
  const POST = kai('Perfecto, la dejamos como estaba: el miércoles 7 a las 18:00.', { directive: 'post_booking' });

  it.each(['Bueno, mejor la dejamos como estaba, gracias', 'No, no, déjala como está', 'Déjala, déjala', 'No hace falta moverla', 'Al final sí puedo'])(
    'mantiene la llamada: %j',
    (text) => {
      const a = analyzeHeuristically(makeAnalysisInput(text, { history: [RESCHEDULE_MSG], state: MONDAY_OFFER }));
      expect(a.keepsAppointment).toBe(true);
      expect(a.flags.wantsReschedule).toBe(false);
      const d = decide({ leadCtx: booked, state: MONDAY_OFFER, analysis: a });
      expect(d.kind).toBe('post_booking');
      expect(d.keepsBooking).toBe(true);
    },
  );

  it('un “gracias” u otro tema no repite la oferta', () => {
    for (const text of ['Gracias', 'Gracias, hasta luego', '¿Tengo que llevar algo preparado?']) {
      const a = analyzeHeuristically(makeAnalysisInput(text, { history: [POST], state: MONDAY_OFFER }));
      expect(a.aboutSchedule, text).toBe(false);
      expect(decide({ leadCtx: booked, state: MONDAY_OFFER, analysis: a }).kind, text).toBe('post_booking');
    }
  });

  it('un “vale, gracias” tras mantenerla no reserva el único horario ofrecido', () => {
    const one: ConversationState = { ...MONDAY_OFFER, offeredSlots: [MON_A], lastOfferIds: [MON_A.id] };
    const a = analyzeHeuristically(makeAnalysisInput('Vale, gracias', { history: [POST], state: one }));
    expect(a.selectedSlotId).toBeNull();
  });

  it('si habla de los horarios (elige, duda), la oferta sigue en pie', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Mmm, ¿cuál me recomiendas?', { history: [RESCHEDULE_MSG], state: MONDAY_OFFER }));
    expect(decide({ leadCtx: booked, state: MONDAY_OFFER, analysis: a }).kind).toBe('clarify_slot');
    const b = analyzeHeuristically(makeAnalysisInput('La segunda', { history: [RESCHEDULE_MSG], state: MONDAY_OFFER }));
    expect(decide({ leadCtx: booked, state: MONDAY_OFFER, analysis: b }).kind).toBe('book_slot');
  });
});

// ───────────── 6) Preguntas de precio ─────────────

describe('análisis: pregunta de precio', () => {
  it.each([
    '¿Cuánto hay que pagar?',
    '¿Cuánto pago al mes?',
    '¿Cuánto tendría que invertir?',
    '¿Y cuánto dinero es?',
    '¿Cuánto me dijiste que costaba?',
    '¿Cuánta pasta es?',
    'cuanto dinero seria',
  ])('detecta el precio: %j', (text) => {
    expect(analyze(text).flags.asksPrice).toBe(true);
  });

  it.each(['¿Cuánto tiempo dura la llamada?', 'Creo que vale la pena', '¿Para qué vale la llamada?', 'Lo que cuesta es levantarme pronto', 'He gastado mucho dinero en dietas'])(
    'no es una pregunta de precio: %j',
    (text) => {
      expect(analyze(text).flags.asksPrice).toBe(false);
    },
  );
});

// ───────────── 7) Objetivo en el primer mensaje ─────────────

describe('análisis: objetivo del primer mensaje', () => {
  it.each([
    ['Hola, quiero bajar de peso', 'bajar de peso'],
    ['Buenas, quiero perder unos kilos', 'perder unos kilos'],
    ['quiero quitarme unos kilos de encima', 'quitarme unos kilos'],
    ['quiero bajar la panza', 'bajar la panza'],
    ['Quiero ponerme fuerte', 'ponerme fuerte'],
    ['Me gustaría perder 8 kilos', 'perder 8 kilos'],
  ])('reconoce el objetivo: %j', (text, goal) => {
    const a = analyze(text);
    expect(a.qualification.goal?.value).toBe(goal);
    expect(a.signals.fit).toBe('yes');
  });
});

// ───────────── 8) Respuestas que no son un objetivo ─────────────

describe('análisis: respuestas a «¿qué te gustaría conseguir?» que no son un objetivo', () => {
  const asked = { state: { lastAskedKey: 'goal' } as ConversationState };

  it.each(['jaja perdona, quería info', 'No sé, la verdad', 'Nada en especial', 'Ni idea jaja', 'Hola, quería más información'])('no se guarda como objetivo: %j', (text) => {
    const a = analyze(text, asked);
    expect(a.qualification.goal).toBeUndefined();
    expect(a.qualification.fit).toBeUndefined();
    expect(a.signals.fit).toBeUndefined();
  });

  it('una respuesta con contenido sí se guarda', () => {
    const a = analyze('Estar más ágil y tener energía', asked);
    expect(a.qualification.goal?.value).toBe('Estar más ágil y tener energía');
  });

  it('si corrige el objetivo, el encaje se actualiza con él', () => {
    const lead = makeLead({ qualification: { ...qualificationOf({ goal: 'perder peso' }), fit: { value: 'perder peso', confidence: 0.6, updatedAt: NOW.toISOString(), level: 'yes' } } as never, signals: { fit: 'yes' } });
    const a = analyze('Mejor dicho, quiero perder 15 kilos', { lead });
    expect(a.qualification.goal?.value).toBe('perder 15 kilos');
    expect(a.qualification.fit?.value).toBe('perder 15 kilos');
  });
});

// ───────────── 9) Clientes que escriben desde otro número o canal ─────────────

describe('análisis: ya es cliente', () => {
  it.each([
    'Hola Álex, soy Pablo, ya entreno contigo. ¿Me pasas la rutina de esta semana?',
    'Que ya soy cliente tuyo',
    'Soy tu alumno, ¿me mandas mi dieta?',
    'Llevo dos meses entrenando contigo',
    'Ya soy cliente de Álex, escribo desde otro número',
  ])('se pasa al entrenador sin cualificar: %j', (text) => {
    const a = analyze(text, { state: { lastAskedKey: 'goal' } });
    expect(a.flags.outOfScope).toBe(true);
    expect(a.qualification.goal).toBeUndefined();
    expect(a.signals.fit).toBeUndefined();
  });

  it.each(['Ya soy cliente de un gimnasio', 'Mi rutina es muy sedentaria', 'Si entreno contigo, ¿cuántos días serían?'])('no lo confunde: %j', (text) => {
    expect(analyze(text).flags.outOfScope).toBe(false);
  });

  it('con IA también se detecta (red de seguridad)', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult()), makeAnalysisInput('Ya entreno contigo, ¿me pasas la rutina de esta semana?'));
    expect(a.flags.outOfScope).toBe(true);
  });
});

// ───────────── Utilidades: proveedor de IA falso ─────────────

type LlmResult = z.infer<typeof AnalysisSchema>;

function llmResult(overrides: Partial<LlmResult['flags']> = {}, extra: Partial<LlmResult> = {}): LlmResult {
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
      ...overrides,
    },
    objection_key: null,
    lead_name: null,
    goal_summary: null,
    preferred_date: null,
    preferred_part_of_day: null,
    selected_slot_id: null,
    summary: 'ok',
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

describe('sin falsos positivos al rechazar o mantener', () => {
  const ctx = { history: [OFFER_MSG], state: MONDAY_OFFER };

  it('“Al final puedo el martes” elige otro día: no es mantener la llamada', () => {
    const a = analyze('Al final puedo el martes', ctx);
    expect(a.keepsAppointment).toBe(false);
    expect(a.preferredDate).toBe('2026-10-06');
    expect(analyze('Al final sí puedo, gracias', ctx).keepsAppointment).toBe(true);
  });

  it('“Ninguna preferencia, la que veas” no rechaza la oferta', () => {
    expect(analyze('Ninguna preferencia, la que veas', ctx).rejectsOffer).toBe(false);
  });
});

describe('estrategia: preferir otro horario frente a confirmar el de la cita', () => {
  const booked = makeLeadContext({ upcomingAppointment: makeAppointment({ startsAt: local('2026-10-12T13:00') }) });

  it('“Mejor el lunes” lo pide como cambio (otra hora ese día); “Vale, el lunes” solo lo confirma', () => {
    const better = analyzeHeuristically(makeAnalysisInput('Mejor el lunes'));
    expect(better.rescheduleImplicit).toBe(false);
    expect(decide({ leadCtx: booked, analysis: better }).kind).toBe('reschedule');
    const ack = analyzeHeuristically(makeAnalysisInput('Vale, el lunes'));
    expect(decide({ leadCtx: booked, analysis: ack }).kind).toBe('post_booking');
  });
});

describe('estrategia: cancelar la llamada nombrando su día', () => {
  it('“Cancela la llamada del lunes” con la llamada el lunes la cancela (no es confirmarla)', () => {
    const booked = makeLeadContext({ upcomingAppointment: makeAppointment({ startsAt: local('2026-10-12T13:00') }) });
    const a = analyzeHeuristically(makeAnalysisInput('Cancela la llamada del lunes, por favor'));
    expect(a.flags.wantsCancel).toBe(true);
    expect(decide({ leadCtx: booked, analysis: a }).kind).toBe('cancel_booking');
  });
});
