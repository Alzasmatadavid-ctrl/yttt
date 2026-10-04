import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { decideDirective, recentOffer, type SetterState } from '../../src/ai/setter/strategy.js';
import { eventPhrase, RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import { validateReply } from '../../src/ai/validation/output-validator.js';
import { hasSeveralQuestions, questionCount } from '../../src/lib/domain.js';
import {
  inbound,
  makeAnalysis,
  makeAnalysisInput,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeMessage,
  makeObjections,
  makeService,
  makeValidationContext,
  NOW,
  offeredAt,
  outbound,
} from './factories.js';

const appt = makeAppointment(); // miércoles 7/10 a las 18:00 (Madrid); NOW = lunes 5/10, 12:00

/** Analiza el mensaje con la heurística y decide la directiva (lead con la llamada ya agendada). */
function withBooking(text: string, state: SetterState = {}, history = [outbound('¡Hecho! Te apunto para el miércoles 7 a las 18:00.')]) {
  const lead = makeLead();
  const analysis = analyzeHeuristically(makeAnalysisInput(text, { state, history, lead }));
  const directive = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }), state, analysis, kaiHasSpoken: true, now: NOW });
  return { analysis, directive };
}

describe('Con la llamada agendada, KAI no da por hecho un «sí»', () => {
  it.each(['Me lo he pensado y prefiero no hacer la llamada', 'No me interesa la llamada', 'No necesito la llamada, gracias'])(
    '«%s» → pregunta si la cancela o la mueve (sin cancelarla todavía)',
    (text) => {
      expect(withBooking(text).directive.kind).toBe('confirm_cancel');
    },
  );

  it.each(['No me viene bien', 'No, al final no me va bien', 'Pues no, no puedo', 'Mejor otro día, ¿tienes el lunes?'])('«%s» → reprogramar', (text) => {
    expect(withBooking(text).directive.kind).toBe('reschedule');
  });

  it('«No» a secas como respuesta al recordatorio → reprogramar', () => {
    const reminder = makeMessage({ direction: 'outbound', content: 'Hola Laura, te recuerdo la llamada de mañana a las 18:00.', metadata: { kind: 'reminder_24h' } });
    expect(withBooking('No', {}, [reminder]).directive.kind).toBe('reschedule');
    // Un «no» que confirma no lo es.
    expect(withBooking('No te preocupes, allí estaré', {}, [reminder]).directive.kind).toBe('post_booking');
  });

  it('eligiendo otra fecha para moverla: nueva preferencia → consultar la agenda; duda → concretar', () => {
    const A = offeredAt('2026-10-08T11:00');
    const B = offeredAt('2026-10-08T17:00');
    const state: SetterState = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: NOW.toISOString() };
    const history = [outbound('Sin problema, lo movemos. Tengo el jueves 8 a las 11:00 o a las 17:00. ¿Cuál te viene mejor?')];
    expect(withBooking('¿Y el viernes por la tarde?', state, history).directive.kind).toBe('reschedule');
    expect(withBooking('Mmm no sé, déjame mirarlo', state, history).directive.kind).toBe('clarify_slot');
    expect(withBooking('La segunda', state, history).directive.kind).toBe('book_slot');
  });

  it('el texto de «post-reserva» del motor de reglas es neutro y no repite el anterior', async () => {
    const lead = makeLead({ name: 'Laura Gómez' });
    const first = await new RuleBasedSetterAgent().respond(agentInput({ leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }) }));
    expect(first.text).not.toMatch(/^Perfecto/);
    expect(first.text).toMatch(/18:00/);
    expect(validateReply(first.text, makeValidationContext({ allowedTimes: [appt.startsAt], now: NOW })).ok).toBe(true);
    const second = await new RuleBasedSetterAgent().respond(
      agentInput({
        leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }),
        convCtx: { conversation: makeConversation(), history: [outbound(first.text), inbound('ok')], pendingInbound: [inbound('ok')], kaiHasSpoken: true },
      }),
    );
    expect(second.text).not.toBe(first.text);
  });

  it('«¿cancelo o la movemos?» es una sola pregunta', async () => {
    const out = await new RuleBasedSetterAgent().respond(agentInput({ leadCtx: makeLeadContext({ upcomingAppointment: appt }), directive: { kind: 'confirm_cancel', instruction: '' } }));
    expect(out.text).toMatch(/cancele/);
    expect(questionCount(out.text)).toBe(1);
  });
});

describe('Un número suelto no reserva sin consentimiento', () => {
  const A = offeredAt('2026-10-06T11:00');
  const B = offeredAt('2026-10-06T17:00');
  const state: SetterState = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: NOW.toISOString(), callProposedAt: NOW.toISOString() };
  const offer = outbound('Mañana tengo a las 11:00 o a las 17:00. ¿Cuál te viene mejor?');
  const question = outbound('Lo entiendo. ¿Cuántos días a la semana podrías sacar aunque fuera un rato?');
  const pick = (text: string, history = [offer, question]) => analyzeHeuristically(makeAnalysisInput(text, { state, history })).selectedSlotId;

  it('«5» o «17» respondiendo a otra pregunta no eligen horario', () => {
    expect(pick('5')).toBeNull();
    expect(pick('17')).toBeNull();
  });
  it('con la oferta como último mensaje, «17» sí elige', () => {
    expect(pick('17', [offer])).toBe(B.id);
  });
  it('«a las 5» o «5 de la tarde» eligen las 17:00 aunque haya mensajes en medio', () => {
    expect(pick('a las 5')).toBe(B.id);
    expect(pick('5 de la tarde')).toBe(B.id);
  });
});

describe('Horarios caducados', () => {
  const past = offeredAt('2026-10-05T09:00'); // ya pasó (NOW = 12:00)
  const soon = offeredAt('2026-10-05T12:30'); // dentro de la antelación mínima (2 h)
  const later = offeredAt('2026-10-06T17:00');
  const state: SetterState = { offeredSlots: [past, soon, later], lastOfferIds: [past.id, soon.id, later.id], offeredAt: NOW.toISOString() };

  it('la oferta reciente solo conserva los horarios que aún se pueden reservar', () => {
    expect(recentOffer(state, NOW, 120).map((s) => s.id)).toEqual([later.id]);
    expect(recentOffer(state, NOW, 0).map((s) => s.id)).toEqual([soon.id, later.id]);
  });

  it('elegir un horario que ya pasó no reserva', () => {
    const d = decideDirective({
      biz: { ...makeBusinessContext(), minNoticeMinutes: 120 },
      leadCtx: makeLeadContext(),
      state,
      analysis: makeAnalysis({ selectedSlotId: past.id, flags: { wantsCall: true } }),
      kaiHasSpoken: true,
      now: NOW,
    });
    expect(d.kind).not.toBe('book_slot');
  });

  it('el control de calidad rechaza ofrecer una hora que ya ha pasado', () => {
    const r = validateReply('¿Te va bien hoy a las 09:00?', makeValidationContext({ allowedTimes: [new Date(past.start)], now: NOW }));
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/ya ha pasado/);
  });
});

describe('Una sola pregunta', () => {
  it('el ejemplo prohibido de la especificación cuenta como varias preguntas', () => {
    const t = 'Perfecto. ¿Qué objetivo tienes, cuánto pesas, qué edad tienes y cuánto tiempo llevas entrenando?';
    expect(questionCount(t)).toBe(4);
    expect(hasSeveralQuestions(t)).toBe(true);
    expect(validateReply(t, makeValidationContext()).ok).toBe(false);
  });
  it('cuenta también los «¿» sin cerrar', () => {
    expect(questionCount('¿Qué objetivo tienes. ¿Desde cuándo?')).toBe(2);
  });
  it('una pregunta con alternativas sigue siendo una', () => {
    expect(questionCount('¿Cuál te viene mejor, la primera o la segunda?')).toBe(1);
    expect(questionCount('¿Prefieres por la mañana o por la tarde?')).toBe(1);
  });
});

describe('¿Hablo con un bot?', () => {
  it.each(['¿Estoy hablando con un bot?', '¿Es un bot?', '¿Esto es un bot?', '¿Hablo con una persona?', '¿Me contesta una persona o un bot?', '¿Estoy hablando con una persona real?'])(
    '«%s» se detecta como pregunta sobre si es un bot, no como petición de una persona ni como respuesta',
    (text) => {
      const a = analyzeHeuristically(makeAnalysisInput(text, { state: { lastAskedKey: 'current_situation' } }));
      expect(a.flags.asksIfBot).toBe(true);
      expect(a.flags.humanRequest).toBe(false);
      expect(a.qualification.current_situation).toBeUndefined();
    },
  );
  it('pedir una persona real sigue siendo una petición', () => {
    expect(analyzeHeuristically(makeAnalysisInput('Quiero hablar con una persona real')).flags.humanRequest).toBe(true);
  });
});

describe('Modo sin IA: objetivo y respuestas en su variable', () => {
  it('capta el objetivo del primer mensaje aunque diga «unos»', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Hola! Vi tu reel, quiero perder unos 8 kilos'));
    expect(a.qualification.goal?.value).toMatch(/perder unos 8 kilos/);
  });
  it('lo que describe su situación no se guarda como objetivo aunque se preguntara por él', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Trabajo muchas horas y como fatal entre semana', { state: { lastAskedKey: 'goal' } }));
    expect(a.qualification.goal).toBeUndefined();
    expect(a.qualification.problem?.value).toMatch(/como fatal/);
  });
});

describe('Precio cuando el lead no encaja', () => {
  it('si insiste, se le da sin proponer la llamada', async () => {
    const lead = makeLead({ signals: { fit: 'no' } });
    const analysis = analyzeHeuristically(makeAnalysisInput('¿Pero cuánto cuesta?', { lead }));
    const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: { priceAskedCount: 2 }, analysis, kaiHasSpoken: true, now: NOW });
    expect(d).toMatchObject({ kind: 'share_price', withoutCall: true });
    const out = await new RuleBasedSetterAgent().respond(agentInput({ leadCtx: makeLeadContext({ lead }), directive: d }));
    expect(out.text).toMatch(/197\s?€/);
    expect(out.text).not.toMatch(/llamada/);
    expect(validateReply(out.text, makeValidationContext({ allowedPricesCents: [19700], currencies: ['EUR'] })).ok).toBe(true);
  });
  it('la primera vez sigue siendo una despedida amable', () => {
    const lead = makeLead({ signals: { fit: 'no' } });
    const analysis = analyzeHeuristically(makeAnalysisInput('¿Cuánto cuesta?', { lead }));
    expect(decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: { priceAskedCount: 1 }, analysis, kaiHasSpoken: true }).kind).toBe('disqualify_kindly');
  });
});

describe('Motor de reglas: textos que el control de calidad acepta', () => {
  it('con 5 seguimientos, la despedida solo va en el último y ninguno se repite', async () => {
    const texts: string[] = [];
    for (let step = 1; step <= 5; step++) {
      const history = [outbound('¡Hola Laura! Soy KAI.'), inbound('Quiero perder 10 kilos'), ...texts.map((t) => outbound(t))];
      const out = await new RuleBasedSetterAgent().respond(
        agentInput({
          mode: 'follow_up',
          followUp: { step, totalSteps: 5, angle: '', hoursSilent: 48 },
          leadCtx: makeLeadContext({ lead: makeLead({ name: 'Laura Gómez', goalSummary: 'Perder 10 kilos' }) }),
          convCtx: { conversation: makeConversation(), history, pendingInbound: [], kaiHasSpoken: true },
          directive: { kind: 'ask_qualification', instruction: '', question: '¿Qué te ha frenado hasta ahora?' },
        }),
      );
      const v = validateReply(out.text, makeValidationContext({ isFollowUp: true, previousMessages: texts.slice(-4), now: NOW }));
      expect(v.issues, `paso ${step}: ${out.text}`).toEqual([]);
      if (step < 5) expect(out.text).not.toMatch(/no quiero ser pesad/);
      else expect(out.text).toMatch(/no quiero ser pesad/);
      texts.push(out.text);
    }
  });

  it('el acontecimiento de la memoria se menciona sin citar al lead (ni sus preguntas)', async () => {
    expect(eventPhrase('Me caso en junio, ¿sabes?')).toBe('tu boda');
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({ leadCtx: makeLeadContext({ memories: [{ kind: 'event', content: 'Me caso en junio, ¿sabes?' }] }), directive: { kind: 'propose_call', instruction: '' } }),
    );
    expect(out.text).toMatch(/tu boda/);
    expect(questionCount(out.text)).toBe(1);
  });

  it('una objeción repetida no recibe el mismo texto', async () => {
    const objection = makeObjections()[0];
    const first = await new RuleBasedSetterAgent().respond(agentInput({ directive: { kind: 'handle_objection', instruction: '', objection } }));
    const again = await new RuleBasedSetterAgent().respond(
      agentInput({
        directive: { kind: 'handle_objection', instruction: '', objection },
        convCtx: { conversation: makeConversation(), history: [outbound(first.text), inbound('ya, pero…')], pendingInbound: [inbound('ya, pero…')], kaiHasSpoken: true },
      }),
    );
    expect(again.text).not.toBe(first.text);
    expect(questionCount(again.text)).toBeLessThanOrEqual(1);
  });
});

function agentInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  const biz = makeBusinessContext({ services: [makeService({ name: 'Programa 12 semanas', priceCents: 19700 })] });
  return {
    biz,
    leadCtx: makeLeadContext(),
    convCtx: { conversation: makeConversation(), history: [outbound('Hola'), inbound('Vale')], pendingInbound: [inbound('Vale')], kaiHasSpoken: true },
    state: {},
    directive: { kind: 'post_booking', instruction: '' },
    now: NOW,
    feedback: [],
    toolbox: null,
    mode: 'reply',
    ...overrides,
  };
}
