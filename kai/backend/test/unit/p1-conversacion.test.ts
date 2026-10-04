/**
 * Revisión nº 1 (conversación): falsos positivos del análisis, elección de horario, rechazo de la llamada,
 * citas ya agendadas, control de calidad de horarios/días/monedas y textos del motor de reglas.
 * Sin base de datos.
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically, analyzeWithLLM, matchOfferedSlot, type AnalysisSchema } from '../../src/ai/analysis/analyzer.js';
import { RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import { decideDirective, nextQualificationRule, oneQuestion, type SetterState, type StrategyInput } from '../../src/ai/setter/strategy.js';
import { validateReply, type ValidationContext } from '../../src/ai/validation/output-validator.js';
import { DEFAULT_QUALIFICATION_RULES } from '../../src/config/defaults.js';
import type { LLMProvider } from '../../src/ai/providers/types.js';
import type { z } from 'zod';
import { normalize } from '../../src/lib/text.js';
import {
  MADRID,
  NOW,
  inbound,
  local,
  makeAnalysis,
  makeAnalysisInput,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeRules,
  makeService,
  makeValidationContext,
  offeredAt,
  outbound,
  qualificationOf,
} from './factories.js';

const analyze = (...args: Parameters<typeof makeAnalysisInput>) => analyzeHeuristically(makeAnalysisInput(...args));
const REQUIRED = { goal: 'perder 10 kilos', problem: 'no tengo tiempo', motivation: 'mi boda' };

// ───────────── Baja (opt-out) ─────────────

describe('baja: solo peticiones explícitas', () => {
  it.each([
    'No me escribiste ayer, por eso no contesté',
    'No me mandes audios porfa, que no puedo escucharlos',
    'Si no me escribes por aquí no me entero',
    'No me escribas más tarde, que estoy currando',
    'No me escribas ahora, que estoy en el curro',
    'No quiero que me escribas a estas horas',
  ])('no es una baja: %j', (text) => {
    expect(analyze(text).flags.optOut).toBe(false);
  });

  it.each(['No me escribas más, por favor', 'No me escribas.', 'Dejad de escribirme', 'No quiero que me escribáis', 'Dame de baja', 'STOP', 'Borra mis datos'])(
    'sí es una baja: %j',
    (text) => {
      expect(analyze(text).flags.optOut).toBe(true);
    },
  );
});

// ───────────── Análisis con IA: red de seguridad ─────────────

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

describe('análisis con IA: la heurística solo añade señales de alta precisión', () => {
  const A = offeredAt('2026-10-06T18:00', MADRID, 'mañana a las 18:00');
  const B = offeredAt('2026-10-08T10:00', MADRID, 'el jueves a las 10:00');
  const state = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id] };

  it('no fuerza una baja que el modelo no ve (“no me escribiste ayer”)', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult()), makeAnalysisInput('No me escribiste ayer, por eso no contesté'));
    expect(a.flags.optOut).toBe(false);
  });

  it('una baja inequívoca nunca se pierde aunque el modelo la pase por alto', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult()), makeAnalysisInput('Dame de baja'));
    expect(a.flags.optOut).toBe(true);
  });

  it('no reserva por la heurística un horario que el modelo no eligió (pregunta sobre el horario)', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult({ asks_question: true })), makeAnalysisInput('¿A las 18:00 sería por videollamada?', { state }));
    expect(a.selectedSlotId).toBeNull();
  });

  it('respeta el horario que sí elige el modelo', async () => {
    const a = await analyzeWithLLM(fakeProvider(llmResult({}, { selected_slot_id: A.id })), makeAnalysisInput('La de mañana', { state }));
    expect(a.selectedSlotId).toBe(A.id);
  });
});

// ───────────── Elegir horario ─────────────

describe('elegir horario: preguntas, dudas y obstáculos no reservan', () => {
  const A = offeredAt('2026-10-06T18:00', MADRID, 'mañana a las 18:00');
  const B = offeredAt('2026-10-08T10:00', MADRID, 'el jueves a las 10:00');
  const m = (text: string) => matchOfferedSlot(normalize(text), [A, B], MADRID, NOW, [A.id, B.id]);

  it.each(['¿A las 18:00 sería por videollamada?', '¿Las 18:00 es hora de Madrid?', 'A las 18:00 no sé si llego a tiempo', 'Mañana a las 18:00 tengo dentista', 'Uf, a las 10:00 trabajo'])(
    'no elige: %j',
    (text) => {
      expect(m(text)).toBeNull();
    },
  );

  it.each([
    ['A las 18:00 perfecto', 'A'],
    ['¿Puede ser a las 18:00?', 'A'],
    ['Vale, a las 18:00, que salgo del trabajo antes', 'A'],
    ['La segunda', 'B'],
  ])('sí elige: %j', (text, which) => {
    expect(m(text)).toBe(which === 'A' ? A.id : B.id);
  });
});

// ───────────── Otros falsos positivos ─────────────

describe('alertas: sin falsos positivos habituales', () => {
  it('“lo tengo que hablar con ella” es la objeción de la pareja, no una petición de humano', () => {
    expect(analyze('Lo tengo que hablar con ella primero').flags.humanRequest).toBe(false);
  });

  it('pedir hablar con el entrenador por su nombre sí es una petición de humano', () => {
    expect(analyze('Quiero hablar con Álex directamente').flags.humanRequest).toBe(true);
  });

  it('“eres una máquina” (elogio) no es preguntar si es un bot; “¿eres una máquina?” sí', () => {
    expect(analyze('Tío, eres una máquina').flags.asksIfBot).toBe(false);
    expect(analyze('¿Eres una máquina?').flags.asksIfBot).toBe(true);
  });

  it('la “operación bikini” y “de corazón” no son temas médicos', () => {
    expect(analyze('Quiero hacer la operación bikini').flags.medical).toBe(false);
    expect(analyze('Te lo digo de corazón, quiero cambiar').flags.medical).toBe(false);
    expect(analyze('Tengo un problema de corazón').flags.medical).toBe(true);
    expect(analyze('Me operaron de la rodilla hace un mes').flags.medical).toBe(true);
  });

  it('“me siento pesada” o “joder, qué difícil” no son enfado; “sois unos pesados” sí', () => {
    expect(analyze('Me siento muy pesada y quiero perder 8 kilos').flags.angry).toBe(false);
    expect(analyze('Joder, qué difícil es adelgazar').flags.angry).toBe(false);
    expect(analyze('Sois unos pesados').flags.angry).toBe(true);
  });

  it('“prefiero no decirlo” no es rechazar la llamada', () => {
    expect(analyze('Prefiero no decirlo').flags.declinesCall).toBe(false);
    expect(analyze('Prefiero seguir por aquí, sin llamadas').flags.declinesCall).toBe(true);
  });
});

// ───────────── Rechazo de la llamada ─────────────

describe('si el lead rechaza la llamada, KAI no insiste', () => {
  const declined: SetterState = { callProposedAt: NOW.toISOString(), callDeclinedAt: NOW.toISOString() };
  const qualifiedLead = makeLead({ score: 70, qualification: qualificationOf(REQUIRED) });
  const decide = (text: string, state: SetterState = declined, lead = qualifiedLead) =>
    decideDirective({
      biz: makeBusinessContext(),
      leadCtx: makeLeadContext({ lead }),
      state,
      analysis: analyzeHeuristically(makeAnalysisInput(text, { state, lead })),
      kaiHasSpoken: true,
    });

  it('justo al rechazarla: continue_without_call (y sigue cualificando)', () => {
    const d = decide('No quiero llamada, prefiero seguir por aquí', { callProposedAt: NOW.toISOString() });
    expect(d.kind).toBe('continue_without_call');
    expect(d.justDeclined).toBe(true);
  });

  it.each(['Vale. Trabajo a turnos y ceno tarde', 'Me interesa sobre todo la parte de nutrición', '¿La llamada es obligatoria?'])(
    'después, %j no vuelve a ofrecer horarios ni a proponerla',
    (text) => {
      const d = decide(text);
      expect(['offer_slots', 'propose_call', 'reassure_call', 'clarify_slot']).not.toContain(d.kind);
      expect(d.kind).toBe('ask_qualification');
    },
  );

  it('sin nada más que preguntar, sigue la conversación por escrito', () => {
    const everything = qualificationOf({ ...REQUIRED, current_situation: 'a', previous_attempts: 'b', frustration: 'c', urgency: 'd', commitment: 'e', budget: 'f' });
    const d = decide('Vale, gracias', declined, makeLead({ score: 90, qualification: everything }));
    expect(d.kind).toBe('continue_without_call');
    expect(d.justDeclined).toBeFalsy();
    expect(d.instruction).toContain('No vuelvas a proponer la llamada');
  });

  it('si la pide explícitamente, se le ofrecen horarios', () => {
    expect(decide('Vale, al final sí quiero la llamada').kind).toBe('offer_slots');
  });

  it('el precio tras rechazarla no vuelve a proponer la llamada', () => {
    const lead = makeLead({ score: 70, qualification: qualificationOf(REQUIRED) });
    const d = decideDirective({
      biz: makeBusinessContext(),
      leadCtx: makeLeadContext({ lead }),
      state: { ...declined, priceAskedCount: 1 },
      analysis: makeAnalysis({ flags: { asksPrice: true } }),
      kaiHasSpoken: true,
    });
    expect(d.kind).toBe('share_price');
    expect(d.instruction).toContain('no vuelvas a proponer la llamada');
  });

  it('las dudas sobre la llamada se resuelven una sola vez (no en cada mensaje)', () => {
    const lead = makeLead({ score: 70, qualification: qualificationOf(REQUIRED) });
    const base: StrategyInput = { biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: { callProposedAt: NOW.toISOString() }, analysis: makeAnalysis(), kaiHasSpoken: true };
    expect(decideDirective(base).kind).toBe('reassure_call');
    const again = decideDirective({ ...base, state: { callProposedAt: NOW.toISOString(), callReassuredAt: NOW.toISOString() } });
    expect(again.kind).toBe('ask_qualification');
    expect(again.questionKey).toBe('current_situation');
  });
});

// ───────────── Con la llamada agendada ─────────────

describe('con la llamada agendada', () => {
  const leadCtx = makeLeadContext({ upcomingAppointment: makeAppointment() });
  const decide = (text: string) =>
    decideDirective({ biz: makeBusinessContext(), leadCtx, state: { priceAskedCount: 1 }, analysis: analyzeHeuristically(makeAnalysisInput(text)), kaiHasSpoken: true });

  it.each(['No, al final no puedo', 'Me ha surgido algo y no voy a poder', '¿Podemos cambiar la llamada al jueves?'])('%j → reprogramar', (text) => {
    expect(decide(text).kind).toBe('reschedule');
  });

  it('“Quiero cancelar la llamada” → cancelar (no ofrecer moverla)', () => {
    expect(decide('Quiero cancelar la llamada').kind).toBe('cancel_booking');
  });

  it('“¿Cuánto cuesta el programa?” → da el precio real', () => {
    expect(decide('¿Cuánto cuesta el programa?').kind).toBe('share_price');
  });
  it('sin cita, “quiero cancelar la llamada” no se toma como querer la llamada', () => {
    const state: SetterState = { callProposedAt: NOW.toISOString() };
    const a = analyzeHeuristically(makeAnalysisInput('Quiero cancelar la llamada', { state }));
    expect(a.flags.wantsCall).toBe(false);
    const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext(), state, analysis: a, kaiHasSpoken: true });
    expect(d.kind).toBe('continue_without_call');
  });
});

// ───────────── Motor de reglas ─────────────

function agentInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  const biz = makeBusinessContext({ services: [makeService({ name: 'Programa 12 semanas', priceCents: 19700 })] });
  const lead = makeLead({ name: 'Laura Gómez' });
  return {
    biz,
    leadCtx: makeLeadContext({ lead }),
    convCtx: { conversation: makeConversation(), history: [outbound('Hola'), inbound('¿Eres un bot?')], pendingInbound: [inbound('¿Eres un bot?')], kaiHasSpoken: true },
    state: {},
    directive: { kind: 'post_booking', instruction: '' },
    now: NOW,
    feedback: [],
    toolbox: null,
    mode: 'reply',
    ...overrides,
  };
}

describe('motor de reglas', () => {
  const botNote = 'El lead pregunta si eres un bot: responde con honestidad que eres el asistente automatizado del equipo de Álex.';

  it('con la cita agendada, responde con transparencia si le preguntan si es un bot', async () => {
    const out = await new RuleBasedSetterAgent().respond(agentInput({ leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }), extraNote: botNote }));
    expect(out.text).toMatch(/asistente automatizado/);
    expect(validateReply(out.text, makeValidationContext({ allowedPricesCents: [19700] })).ok).toBe(true);
  });

  it('con la cita agendada, da el precio real sin proponer otra llamada', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({ leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }), directive: { kind: 'share_price', instruction: '' } }),
    );
    expect(out.text).toMatch(/197\s?€/);
    expect(out.text).not.toMatch(/\?/);
    expect(validateReply(out.text, makeValidationContext({ allowedPricesCents: [19700], currencies: ['EUR'] })).ok).toBe(true);
  });

  it('tras rechazar la llamada, el precio no vuelve a proponerla', async () => {
    const out = await new RuleBasedSetterAgent().respond(agentInput({ state: { callDeclinedAt: NOW.toISOString() } as SetterState, directive: { kind: 'share_price', instruction: '' } }));
    expect(out.text).toMatch(/197\s?€/);
    expect(out.text).not.toMatch(/llamada/);
  });

  it('el seguimiento a un lead que nunca contestó no dice “lo que me contaste”', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({
        convCtx: { conversation: makeConversation(), history: [outbound('¡Hola Laura! Soy KAI…')], pendingInbound: [], kaiHasSpoken: true },
        directive: { kind: 'ask_qualification', instruction: '', question: '¿Qué te gustaría conseguir exactamente?' },
        mode: 'follow_up',
        followUp: { step: 1, totalSteps: 3, angle: 'Retomar', hoursSilent: 5 },
      }),
    );
    expect(out.text).not.toMatch(/me contaste|me comentaste/);
    expect(out.text).toContain('Laura');
    expect((out.text.match(/\?/g) ?? []).length).toBe(1);
  });

  it('el seguimiento a un lead que sí contestó retoma lo que contó', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({
        leadCtx: makeLeadContext({ lead: makeLead({ name: 'Laura', goalSummary: 'perder 10 kilos' }) }),
        convCtx: { conversation: makeConversation(), history: [outbound('Hola'), inbound('Quiero perder 10 kilos')], pendingInbound: [], kaiHasSpoken: true },
        directive: { kind: 'ask_qualification', instruction: '', question: '¿Qué te lo impide?' },
        mode: 'follow_up',
        followUp: { step: 1, totalSteps: 3, angle: 'Retomar', hoursSilent: 5 },
      }),
    );
    expect(out.text).toMatch(/lo que me contaste de perder 10 kilos/);
  });
});

// ───────────── Una sola pregunta ─────────────

describe('una sola pregunta por mensaje', () => {
  it('la pregunta de urgencia por defecto hace una sola pregunta', () => {
    for (const r of DEFAULT_QUALIFICATION_RULES) expect((r.question.match(/\?/g) ?? []).length, r.key).toBeLessThanOrEqual(1);
  });

  it('oneQuestion deja solo la última pregunta de una plantilla con dos', () => {
    expect(oneQuestion('¿Por qué ahora? ¿Hay alguna fecha o algo que te haga querer empezar ya?')).toBe('¿Hay alguna fecha o algo que te haga querer empezar ya?');
    expect(oneQuestion('¿Qué te gustaría conseguir?')).toBe('¿Qué te gustaría conseguir?');
  });

  it('una regla antigua con dos preguntas se pregunta con una sola (negocios ya creados)', () => {
    const rules = makeRules({ goal: { question: '¿Por qué ahora? ¿Hay alguna fecha?' } });
    expect(nextQualificationRule(rules, makeLead())?.question).toBe('¿Hay alguna fecha?');
  });
});

// ───────────── Control de calidad: horarios, días y monedas ─────────────

describe('validador: horarios, días y monedas', () => {
  /** Única hora real: martes 6/10 a las 18:00 (Madrid). “Ahora” = lunes 5/10. */
  const ctx = (overrides: Partial<ValidationContext> = {}) =>
    makeValidationContext({ allowedTimes: [local('2026-10-06T18:00')], allowedPricesCents: [15000], currencies: ['EUR'], now: NOW, ...overrides });
  const issues = (text: string, c = ctx()) => validateReply(text, c).issues;

  it.each(['¿Te va bien el jueves sobre las 17?', '¿Quedamos el miércoles 17h?', '¿Te va hacia las 5 de la tarde?', '¿Te va a las seis y media?'])('detecta la hora inventada: %j', (text) => {
    expect(issues(text).some((i) => /no ha salido de la agenda real/.test(i))).toBe(true);
  });

  it.each(['¿Te viene bien el sábado a las 18:00?', '¿Te va bien hoy a las 18:00?', '¿Te va bien el 8 a las 18:00?'])('detecta el día equivocado: %j', (text) => {
    const found = issues(text);
    expect(found.some((i) => /ese día no hay ningún horario ofrecido/.test(i)), JSON.stringify(found)).toBe(true);
    expect(found.join(' ')).toContain('mañana a las 18:00'); // le indica la etiqueta real
  });

  it.each(['¿Te va bien mañana a las 18:00?', '¿Te va bien el martes a las 18:00?', 'Tengo el martes 6 a las 18:00, ¿te encaja?', '¿Te va a las 6 de la tarde del martes?', 'Mañana tengo las 18:00, ¿te va?'])(
    'acepta el horario real: %j',
    (text) => {
      expect(issues(text)).toEqual([]);
    },
  );

  it.each(['El programa son 12 semanas y entrenas 3 días', 'Son las 12 semanas del programa', 'Te respondo en 2h', 'Tienes las dos opciones'])('no confunde cifras con horas: %j', (text) => {
    expect(issues(text)).toEqual([]);
  });

  it.each(['Son 150 dólares al mes', 'Cuesta $150 al mes', 'Son 150 MXN al mes'])('detecta un importe en otra moneda: %j', (text) => {
    expect(issues(text).some((i) => /moneda distinta/.test(i))).toBe(true);
  });

  it('acepta “$” y “pesos” para un negocio en pesos mexicanos', () => {
    const mx = ctx({ currencies: ['MXN'], allowedPricesCents: [150000] });
    expect(issues('Cuesta $1,500 al mes', mx)).toEqual([]);
    expect(issues('Son 1.500 pesos al mes', mx)).toEqual([]);
  });

  it('detecta un precio sin símbolo presentado como precio', () => {
    expect(issues('El programa cuesta 199 al mes').some((i) => /no coincide con ningún precio/.test(i))).toBe(true);
    expect(issues('El programa cuesta 150 al mes')).toEqual([]);
  });
});
