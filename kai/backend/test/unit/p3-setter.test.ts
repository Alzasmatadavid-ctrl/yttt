/**
 * Revisión nº3 (setter): respuestas a «¿la cancelo o la movemos?», rechazos de la llamada, mover la cita con frases
 * naturales, mensajes compuestos del motor de reglas que superaban el máximo, precio repetido y formas de preguntar
 * el precio. Sin base de datos: análisis heurístico + estrategia + motor de reglas.
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { decideDirective, type Directive, type DirectiveKind, type SetterState } from '../../src/ai/setter/strategy.js';
import { fitParts, RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import type { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import { validateReply } from '../../src/ai/validation/output-validator.js';
import { maxCharsFor } from '../../src/ai/prompts/tone.js';
import { questionCount, type ConversationState } from '../../src/lib/domain.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import {
  inbound,
  local,
  makeAnalysisInput,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeMessage,
  makeObjections,
  makeService,
  makeTone,
  makeTrainer,
  makeValidationContext,
  NOW,
  outbound,
} from './factories.js';

const appt = makeAppointment(); // miércoles 7/10 a las 18:00 (Madrid); NOW = lunes 5/10, 12:00
const booked = outbound('¡Hecho! Te apunto para el miércoles 7 a las 18:00.');
/** Mensaje de KAI con la pregunta de confirm_cancel (como lo guarda el motor: metadata.directive). */
const askedCancelOrMove = makeMessage({
  direction: 'outbound',
  content: 'Sin problema. ¿Quieres que cancele la llamada de valoración del miércoles 7 a las 18:00 o prefieres que la movamos a otro día?',
  metadata: { directive: 'confirm_cancel' },
});

/** Analiza el mensaje con la heurística y decide la directiva para un lead con la llamada agendada. */
function withBooking(text: string, history = [booked], state: SetterState = { callProposedAt: NOW.toISOString(), callAccepted: true }) {
  const lead = makeLead();
  const analysis = analyzeHeuristically(makeAnalysisInput(text, { state, history, lead }));
  const directive = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }), state, analysis, kaiHasSpoken: true, now: NOW });
  return { analysis, directive };
}

const analyze = (text: string, state: ConversationState = {}, history = [outbound('Hola, ¿qué tal?')]) => analyzeHeuristically(makeAnalysisInput(text, { state, history })).flags;

// ───────────── 1) Respuestas a «¿quieres que cancele la llamada o prefieres moverla?» ─────────────

describe('Tras preguntarle si cancela o mueve la llamada, KAI hace lo que pide', () => {
  it.each(['Cancélala', 'Sí, cancélala por favor', 'Cancelar', 'Sí', 'Sí, por favor', 'Que no, que no quiero hacer la llamada', 'Mejor anúlala'])(
    '«%s» → cancela la llamada',
    (text) => {
      expect(withBooking(text, [booked, inbound('No quiero la llamada'), askedCancelOrMove]).directive.kind).toBe('cancel_booking');
    },
  );

  it.each([
    ['Muévela al jueves', '2026-10-08'],
    ['Mejor muévela', null],
    ['A otro día', null],
    ['Cámbiala para el viernes por la tarde', '2026-10-09'],
    ['El jueves', '2026-10-08'],
    ['No quiero cancelarla, solo moverla', null],
  ])('«%s» → busca otro horario (consulta la agenda)', (text, date) => {
    const { directive } = withBooking(text, [booked, inbound('No quiero la llamada'), askedCancelOrMove]);
    expect(directive.kind).toBe('reschedule');
    expect(directive.needsSlots).toBe(true);
    expect(directive.slotQuery?.date).toBe(date);
  });

  it.each(['No, déjala como está', 'No, no la canceles', 'La mantengo, gracias'])('«%s» → la llamada sigue en pie', (text) => {
    expect(withBooking(text, [booked, inbound('No quiero la llamada'), askedCancelOrMove]).directive.kind).toBe('post_booking');
  });

  it('un «sí» sin esa pregunta previa no cancela nada', () => {
    expect(withBooking('Sí').directive.kind).toBe('post_booking');
    expect(withBooking('Sí', [booked, outbound('Te recuerdo la llamada del miércoles a las 18:00.')]).analysis.flags.wantsCancel).toBe(false);
  });

  it('las formas negativas no se toman como cancelar o mover', () => {
    expect(analyze('No la canceles, porfa').wantsCancel).toBe(false);
    expect(analyze('No quiero cancelarla').wantsCancel).toBe(false);
    expect(analyze('No hace falta moverla, me va bien').wantsReschedule).toBe(false);
  });

  it('el motor de reglas tiene dos formas de preguntarlo (si lo vuelve a decir, no repite el mensaje)', async () => {
    const lead = makeLead({ name: 'Laura Gómez' });
    const first = await new RuleBasedSetterAgent().respond(agentInput({ leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }), directive: { kind: 'confirm_cancel', instruction: '' } }));
    const again = await new RuleBasedSetterAgent().respond(
      agentInput({
        leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }),
        directive: { kind: 'confirm_cancel', instruction: '' },
        convCtx: { conversation: makeConversation(), history: [outbound(first.text), inbound('No, déjala'), outbound('Perfecto.'), inbound('No quiero la llamada')], pendingInbound: [inbound('No quiero la llamada')], kaiHasSpoken: true },
      }),
    );
    expect(again.text).not.toBe(first.text);
    for (const t of [first.text, again.text]) {
      expect(t).toMatch(/cancele/);
      expect(questionCount(t)).toBe(1);
    }
  });
});

// ───────────── 2) Rechazar la llamada con frases habituales ─────────────

describe('Rechazos habituales de la llamada', () => {
  const afterProposal = { callProposedAt: NOW.toISOString() };
  const proposal = [outbound('Por lo que me cuentas, creo que tendría sentido verlo en una llamada de valoración de 30 minutos con Álex. ¿Te encaja?')];

  it.each([
    'No quiero hacer la llamada',
    'No me apetece hacer ninguna llamada',
    'Prefiero no hacer llamadas, gracias',
    'Paso de llamadas, prefiero por aquí',
    'No me gustan nada las llamadas',
    'No necesito hacer ninguna videollamada',
    'Prefiero por aquí, la verdad',
  ])('«%s» → rechaza la llamada (no es un sí)', (text) => {
    const flags = analyze(text, afterProposal, proposal);
    expect(flags.declinesCall).toBe(true);
    expect(flags.wantsCall).toBe(false);
  });

  it('tras el rechazo, la estrategia sigue por escrito sin ofrecer horarios', () => {
    const lead = makeLead({ qualification: { goal: { value: 'perder 10 kilos', confidence: 0.8, updatedAt: NOW.toISOString() } } });
    const analysis = analyzeHeuristically(makeAnalysisInput('No quiero hacer la llamada', { state: afterProposal, history: proposal, lead }));
    const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: afterProposal, analysis, kaiHasSpoken: true, now: NOW });
    expect(d.kind).toBe('continue_without_call');
    expect(d.needsSlots).toBeFalsy();
  });

  it('mencionar la llamada negándola no es aceptarla', () => {
    expect(analyze('Ahora mismo no tengo tiempo para una llamada').wantsCall).toBe(false);
    expect(analyze('No sé si la llamada me va a servir de algo').wantsCall).toBe(false);
  });

  it('pero sí lo es cuando la pide o la negación no va contra la llamada', () => {
    expect(analyze('Vale, hagamos la llamada').wantsCall).toBe(true);
    expect(analyze('No hay problema con la llamada').wantsCall).toBe(true);
    expect(analyze('¿Por qué no hacemos la llamada mañana?').wantsCall).toBe(true);
    expect(analyze('No, no, la llamada me parece bien').wantsCall).toBe(true);
    // “Prefiero no decirlo” no es rechazar la llamada.
    expect(analyze('Prefiero no decirlo').declinesCall).toBe(false);
  });
});

// ───────────── 3) Con la llamada agendada, pedir otro día u hora con naturalidad ─────────────

describe('Con la llamada agendada, pedir otro día u hora la mueve', () => {
  it.each([
    ['¿Puede ser una hora más tarde?', null],
    ['Mejor el miércoles', '2026-10-07'],
    ['El jueves a las 18:00 me iría mejor', '2026-10-08'],
    ['¿Podría ser un poco más tarde?', null],
    ['El viernes', '2026-10-09'],
    ['Prefiero el jueves por la mañana', '2026-10-08'],
  ])('«%s» → reprogramar (consulta la agenda)', (text, date) => {
    const { directive } = withBooking(text);
    expect(directive.kind).toBe('reschedule');
    expect(directive.needsSlots).toBe(true);
    expect(directive.slotQuery?.date).toBe(date);
  });

  it.each(['Genial, gracias', 'Me va mejor entrenar por la mañana', '¿La llamada es por teléfono o por videollamada?', 'Perfecto, el miércoles allí estaré'])(
    '«%s» → no la mueve',
    (text) => {
      expect(withBooking(text).directive.kind).toBe('post_booking');
    },
  );

  it('si ese día no hay huecos, el motor de reglas lo dice al ofrecer otros', async () => {
    const toolbox = fakeToolbox({ note: 'No hay huecos ese día; estas son las alternativas más cercanas.' });
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({ leadCtx: makeLeadContext({ upcomingAppointment: appt }), directive: { kind: 'reschedule', instruction: '', needsSlots: true }, toolbox }),
    );
    expect(out.text).toMatch(/^Sin problema, lo movemos\. Ese día no me quedan huecos, pero tengo /);
  });
});

// ───────────── 4) Mensajes compuestos del motor de reglas dentro del máximo ─────────────

const SLOT_A = local('2026-10-06T18:00');
const SLOT_B = local('2026-10-06T19:30');

/** Agenda simulada para el motor de reglas (sin base de datos). */
function fakeToolbox(opts: { note?: string } = {}): SetterToolbox {
  const records: { name: string; input: Record<string, unknown>; ok: boolean; result: unknown }[] = [];
  const run = async (name: string, input: Record<string, unknown>) => {
    let result: unknown;
    if (name === 'get_available_slots')
      result = { slots: [SLOT_A, SLOT_B].map((d) => ({ slot_id: `s_${d.getTime()}`, label: humanSlotLabel(d, 'Europe/Madrid', NOW) })), ...(opts.note ? { note: opts.note } : {}) };
    else if (name === 'book_call' || name === 'reschedule_call') result = { ok: true, confirmed: true, label: humanSlotLabel(SLOT_A, 'Europe/Madrid', NOW), meeting_url: null };
    else if (name === 'cancel_call') result = { ok: true, cancelled: true };
    else result = { ok: true };
    records.push({ name, input, ok: true, result });
    return { content: JSON.stringify(result), isError: false };
  };
  return { records, run } as unknown as SetterToolbox;
}

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

describe('fitParts', () => {
  const parts = [
    { key: 'a', options: ['Hola, soy KAI.'] },
    { key: 'b', options: ['Texto opcional bastante largo que sobra.', 'Corto.', ''] },
    { key: 'c', options: ['La respuesta completa y detallada.', 'La respuesta.'] },
  ];

  it('si cabe, devuelve el mensaje completo', () => {
    expect(fitParts(parts, ['b', 'c'], 500)).toBe('Hola, soy KAI. Texto opcional bastante largo que sobra. La respuesta completa y detallada.');
  });

  it('acorta primero lo menos importante y solo lo necesario', () => {
    expect(fitParts(parts, ['b', 'c'], 60)).toBe('Hola, soy KAI. Corto. La respuesta completa y detallada.');
    expect(fitParts(parts, ['b', 'c'], 50)).toBe('Hola, soy KAI. La respuesta completa y detallada.');
    expect(fitParts(parts, ['b', 'c'], 30)).toBe('Hola, soy KAI. La respuesta.');
  });

  it('un paso [clave, nivel] solo acorta hasta ese nivel; lo demás, en un paso posterior', () => {
    expect(fitParts(parts, [['b', 1], 'c', 'b'], 50)).toBe('Hola, soy KAI. Corto. La respuesta.');
    expect(fitParts(parts, [['b', 1], 'c', 'b'], 30)).toBe('Hola, soy KAI. La respuesta.');
  });
});

describe('El motor de reglas no supera el máximo del tono aunque junte saludo, transparencia y «qué incluye»', () => {
  const biz = makeBusinessContext({
    trainer: makeTrainer({ displayName: 'Álex Romero' }),
    services: [
      makeService({
        name: 'Programa Recomposición',
        priceCents: 14900,
        includes: ['Plan de entrenamiento personalizado', 'Pautas de nutrición flexibles', 'Seguimiento semanal por WhatsApp'],
      }),
    ],
  });
  const lead = makeLead({ name: 'Daniel Herrera' });
  const objection = makeObjections().find((o) => o.key === 'will_it_work')!;
  const question = biz.rules.find((r) => r.key === 'commitment')!.question; // la pregunta por defecto más larga
  const pending = [inbound('Hola, ¿eres un bot? ¿Qué incluye el programa?')];
  const botNote = 'El lead pregunta si eres un bot: responde con honestidad que eres el asistente automatizado del equipo de Álex Romero y ofrece pasarle con Álex Romero si lo prefiere.';

  const directives: Directive[] = [
    { kind: 'greet_and_ask', instruction: '', question, questionKey: 'commitment' },
    { kind: 'ask_qualification', instruction: '', question, questionKey: 'commitment' },
    { kind: 'handle_objection', instruction: '', objection },
    { kind: 'price_contextualize', instruction: '', question },
    { kind: 'share_price', instruction: '' },
    { kind: 'share_price', instruction: '', withoutCall: true },
    { kind: 'propose_call', instruction: '' },
    { kind: 'offer_slots', instruction: '', needsSlots: true },
    { kind: 'reschedule', instruction: '', needsSlots: true },
    { kind: 'book_slot', instruction: '', slotId: 'slot_x' },
    { kind: 'cancel_booking', instruction: '' },
    { kind: 'confirm_cancel', instruction: '' },
    { kind: 'post_booking', instruction: '' },
    { kind: 'disqualify_kindly', instruction: '' },
    { kind: 'continue_without_call', instruction: '', question, justDeclined: true },
    { kind: 'continue_without_call', instruction: '' },
    { kind: 'reassure_call', instruction: '' },
    { kind: 'clarify_slot', instruction: '' },
  ];
  const withAppointment = new Set<DirectiveKind>(['reschedule', 'cancel_booking', 'confirm_cancel', 'post_booking']);
  const maxChars = maxCharsFor(makeTone());

  for (const firstMessage of [true, false]) {
    it.each(directives.map((d) => [`${d.kind}${d.withoutCall ? ' (sin llamada)' : ''}${d.justDeclined ? ' (acaba de rechazarla)' : ''}`, d] as const))(
      `${firstMessage ? 'primer mensaje' : 'conversación empezada'} · %s`,
      async (_label, directive) => {
        const state: ConversationState = { offeredSlots: [], lastOfferIds: [] };
        if (directive.kind === 'clarify_slot') {
          const ids = [SLOT_A, SLOT_B].map((d) => `s_${d.getTime()}`);
          state.offeredSlots = [SLOT_A, SLOT_B].map((d, i) => ({ id: ids[i], start: d.toISOString(), end: new Date(d.getTime() + 1800_000).toISOString(), label: '' }));
          state.lastOfferIds = ids;
          state.offeredAt = NOW.toISOString();
        }
        const out = await new RuleBasedSetterAgent().respond({
          biz,
          leadCtx: makeLeadContext({ lead, upcomingAppointment: withAppointment.has(directive.kind) ? appt : null }),
          convCtx: { conversation: makeConversation(), history: firstMessage ? pending : [outbound('Hola Daniel, cuéntame.'), ...pending], pendingInbound: pending, kaiHasSpoken: !firstMessage },
          state,
          directive,
          now: NOW,
          feedback: [],
          toolbox: fakeToolbox(),
          mode: 'reply',
          extraNote: botNote,
          firstMessage,
        });
        expect(out.text.length, out.text).toBeLessThanOrEqual(maxChars);
        // Transparencia: siempre dice que es un asistente automatizado, y sin repetir la presentación.
        expect(out.text).toMatch(/asistente automatizado/);
        expect((out.text.match(/soy KAI/g) ?? []).length).toBeLessThanOrEqual(1);
        const vctx = makeValidationContext({
          allowedTimes: [SLOT_A, SLOT_B, appt.startsAt],
          allowedPricesCents: [14900],
          currencies: ['EUR'],
          factsText: biz.services.map((s) => `${s.description} ${s.includes.join(' ')}`).join('\n'),
          now: NOW,
        });
        const result = validateReply(out.text, vctx);
        expect(result.issues, out.text).toEqual([]);
      },
    );
  }

  it('primer mensaje «¿eres un bot? ¿cuánto cuesta?»: saluda, se presenta una vez y responde, dentro del máximo', async () => {
    const msg = [inbound('Hola, ¿eres un bot? ¿Cuánto cuesta?')];
    const out = await new RuleBasedSetterAgent().respond({
      biz,
      leadCtx: makeLeadContext({ lead }),
      convCtx: { conversation: makeConversation(), history: msg, pendingInbound: msg, kaiHasSpoken: false },
      state: {},
      directive: { kind: 'price_contextualize', instruction: '', question: biz.rules[0].question, questionKey: 'goal' },
      now: NOW,
      feedback: [],
      toolbox: null,
      mode: 'reply',
      extraNote: botNote,
      firstMessage: true,
    });
    expect(out.text).toMatch(/^¡Hola Daniel! Soy KAI, el asistente virtual del equipo de Álex Romero\. /);
    expect(out.text).toMatch(/asistente automatizado/);
    expect(out.text).not.toMatch(/soy KAI, el asistente automatizado/);
    expect(out.text.length).toBeLessThanOrEqual(maxChars);
    expect(questionCount(out.text)).toBe(1);
  });

  it('si cabe, el mensaje no se recorta', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput({ directive: { kind: 'reassure_call', instruction: '' }, convCtx: { conversation: makeConversation(), history: [outbound('Hola')], pendingInbound: [inbound('Mmm')], kaiHasSpoken: true } }),
    );
    expect(out.text).toMatch(/^Claro, sin ninguna prisa\. La llamada de valoración es simplemente para que Álex conozca tu caso/);
  });
});

// ───────────── 5) Precio repetido: nunca el mismo texto ─────────────

describe('Si vuelve a preguntar el precio, KAI no repite el mismo mensaje', () => {
  /** Simula varias preguntas de precio seguidas y comprueba que cada respuesta pasa el control de calidad. */
  async function askPriceRepeatedly(directive: Directive, opts: { upcoming?: boolean; priced?: boolean } = {}, times = 3) {
    const biz = makeBusinessContext({ services: [makeService({ name: 'Programa 12 semanas', priceCents: opts.priced === false ? 0 : 19700 })] });
    const lead = makeLead({ name: 'Hugo' });
    const history = [outbound('Gracias por contármelo con tanta sinceridad. Te deseo mucho ánimo.')];
    const texts: string[] = [];
    let state: ConversationState = {};
    for (let i = 0; i < times; i++) {
      const ask = inbound(i % 2 ? '¿Cuánto vale al mes?' : 'Pero dime el precio');
      history.push(ask);
      const out = await new RuleBasedSetterAgent().respond({
        biz,
        leadCtx: makeLeadContext({ lead, upcomingAppointment: opts.upcoming ? appt : null }),
        convCtx: { conversation: makeConversation(), history: [...history], pendingInbound: [ask], kaiHasSpoken: true },
        state,
        directive,
        now: NOW,
        feedback: [],
        toolbox: null,
        mode: 'reply',
      });
      const vctx = makeValidationContext({ allowedPricesCents: [19700], currencies: ['EUR'], allowedTimes: [appt.startsAt], now: NOW });
      vctx.previousMessages = history.filter((m) => m.direction === 'outbound').slice(-4).map((m) => m.content);
      expect(validateReply(out.text, vctx).issues, out.text).toEqual([]);
      texts.push(out.text);
      history.push(outbound(out.text));
      state = { ...state, priceShared: true };
    }
    return texts;
  }

  it('lead que no encaja (p. ej. menor de edad): tres preguntas seguidas, tres respuestas distintas con el precio', async () => {
    const texts = await askPriceRepeatedly({ kind: 'share_price', instruction: '', withoutCall: true });
    expect(new Set(texts).size).toBe(3);
    for (const t of texts) expect(t).toMatch(/197\s?€/);
  });

  it('con la llamada agendada', async () => {
    const texts = await askPriceRepeatedly({ kind: 'share_price', instruction: '' }, { upcoming: true });
    expect(new Set(texts).size).toBe(3);
    for (const t of texts) expect(t).toMatch(/197\s?€/);
  });

  it('sin precio configurado (con y sin llamada agendada)', async () => {
    expect(new Set(await askPriceRepeatedly({ kind: 'share_price', instruction: '' }, { priced: false }, 2)).size).toBe(2);
    expect(new Set(await askPriceRepeatedly({ kind: 'share_price', instruction: '' }, { priced: false, upcoming: true }, 2)).size).toBe(2);
    expect(new Set(await askPriceRepeatedly({ kind: 'share_price', instruction: '', withoutCall: true }, { priced: false }, 2)).size).toBe(2);
  });
});

// ───────────── 6) Formas de preguntar el precio ─────────────

describe('Detección de la pregunta por el precio', () => {
  it.each([
    'Antes, ¿cuánto costaría el programa?',
    'Oye, ¿y cuánto costaba?',
    '¿Cuánto me sale al mes?',
    '¿Y qué vale?',
    '¿Cuánto era al mes?',
    '¿Cuánto valdría?',
    '¿Cuál es la cuota?',
    '¿Cuánto cuesta?',
    '¿Qué precio tiene?',
  ])('«%s» → pregunta el precio', (text) => {
    expect(analyze(text).asksPrice).toBe(true);
  });

  it.each([
    'Lo que más me cuesta es la constancia',
    'Creo que vale la pena, ¿no?',
    'Pago la cuota del gimnasio pero no voy',
    '¿Cuánto estás dispuesto a esperar?',
    'Lo que cuesta es levantarse temprano',
    '¿Para qué vale la llamada?',
  ])('«%s» → no pregunta el precio', (text) => {
    expect(analyze(text).asksPrice).toBe(false);
  });

  it('tras proponer la llamada, «¿cuánto costaría?» da el precio (no vuelve a hablar de la llamada)', () => {
    const lead = makeLead({ qualification: { goal: { value: 'perder 10 kilos', confidence: 0.8, updatedAt: NOW.toISOString() } }, score: 80 });
    const state: SetterState = { callProposedAt: NOW.toISOString(), priceAskedCount: 1 };
    const analysis = analyzeHeuristically(makeAnalysisInput('Antes, ¿cuánto costaría el programa?', { state, lead, history: [outbound('¿Te encaja una llamada de valoración?')] }));
    const biz = makeBusinessContext({ settings: { ...makeBusinessContext().settings, pricePolicy: 'share_directly' } });
    expect(decideDirective({ biz, leadCtx: makeLeadContext({ lead }), state, analysis, kaiHasSpoken: true, now: NOW }).kind).toBe('share_price');
  });
});
