/**
 * Ronda 5 (integración final): lo que pedían unos grupos a otros. Objetivo resumido para la ficha, niveles por defecto
 * que no pisan lo que ya dijo el lead, objetivo dado al responder otra pregunta, horas de un lead de otro país (análisis,
 * estrategia, recordatorios), días descartados y hora pedida al ofrecer huecos, motor de reglas con el calendario caído
 * o tras un rechazo, y el juez con IA que no responde. Sin base de datos.
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { decideDirective, type StrategyInput } from '../../src/ai/setter/strategy.js';
import { RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import type { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import type { MessageRow } from '../../src/ai/context/context.js';
import type { LLMProvider } from '../../src/ai/providers/types.js';
import { judgeReply } from '../../src/ai/validation/output-validator.js';
import { pickOfferSlots } from '../../src/calendar/availability.js';
import { confirmationText, reminderText, reminderTemplateParams } from '../../src/automation/messages.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import { DateTime } from 'luxon';
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
  makeMessage,
  makeTone,
  offeredAt,
  outbound,
  slotAt,
} from './factories.js';

/** WhatsApp de un lead de México (Ciudad de México: 8 h menos que Madrid en octubre). */
const MX_PHONE = '5215512345678';
const analyze = (...args: Parameters<typeof makeAnalysisInput>) => analyzeHeuristically(makeAnalysisInput(...args));

describe('Análisis sin IA', () => {
  it('la ficha guarda el objetivo concreto aunque se guarde la respuesta entera', () => {
    const a = analyze('Hola, pues me gustaría perder unos 10 kilos, sobre todo la tripa', { state: { lastAskedKey: 'goal' } });
    expect(a.qualification.goal?.value).toMatch(/sobre todo la tripa/);
    expect(a.goalSummary).toBe('perder unos 10 kilos');
    // Sin frase reconocible, el mensaje tal cual.
    expect(analyze('Sentirme mejor conmigo mismo y tener más energía', { state: { lastAskedKey: 'goal' } }).goalSummary).toBe(
      'Sentirme mejor conmigo mismo y tener más energía',
    );
  });

  it('el objetivo dado al responder otra pregunta no se guarda como esa respuesta', () => {
    const a = analyze('Quiero perder 8 kilos', { state: { lastAskedKey: 'current_situation' } });
    expect(a.qualification.current_situation).toBeUndefined();
    expect(a.qualification.goal?.value).toBe('perder 8 kilos');
    // Si ya se sabe su objetivo, sí es su respuesta.
    const b = analyze('Quiero perder 8 kilos', {
      state: { lastAskedKey: 'current_situation' },
      lead: makeLead({ qualification: { goal: { value: 'perder peso', confidence: 0.8, updatedAt: NOW.toISOString() } } }),
    });
    expect(b.qualification.current_situation?.value).toBe('Quiero perder 8 kilos');
  });

  it('el nivel por defecto de la última pregunta no pisa una señal que ya tenía', () => {
    const urgent = makeLead({ signals: { urgency: 'high', commitment: 'low', budget: 'no' } });
    expect(analyze('Pues no lo sé bien', { state: { lastAskedKey: 'urgency' }, lead: urgent }).signals.urgency).toBeUndefined();
    expect(analyze('Vale', { state: { lastAskedKey: 'commitment' }, lead: urgent }).signals.commitment).toBeUndefined();
    expect(analyze('Sí', { state: { lastAskedKey: 'budget' }, lead: urgent }).signals.budget).toBeUndefined();
    // Sin señal previa, se mantiene el comportamiento de siempre.
    expect(analyze('Pues no lo sé bien', { state: { lastAskedKey: 'urgency' } }).signals.urgency).toBe('medium');
  });

  it('preguntar por la llamada no es aceptarla; pedirla preguntando, sí', () => {
    const state = { callProposedAt: NOW.toISOString() };
    const history = [makeMessage({ direction: 'outbound', content: 'Creo que tendría sentido verlo en una llamada de valoración. ¿Te encaja?', metadata: { directive: 'propose_call' } })];
    for (const t of ['¿Cuánto dura la llamada y para qué es?', '¿La llamada tiene algún coste?', '¿La llamada es por Zoom?'])
      expect(analyze(t, { state, history }).flags.wantsCall, t).toBe(false);
    for (const t of ['¿Hacemos la llamada?', '¿Me podéis llamar?', 'Vale, la llamada me viene bien'])
      expect(analyze(t, { state, history }).flags.wantsCall, t).toBe(true);
  });

  it('«no me organizo» es su problema (no se le vuelve a preguntar)', () => {
    expect(analyze('Trabajo a turnos y no me organizo').qualification.problem?.value).toMatch(/no me organizo/);
  });

  it('un lead de México elige «a las 10» pensando en su hora', () => {
    const a = offeredAt('2026-10-06T18:00');
    const b = offeredAt('2026-10-06T19:30');
    const state = { offeredSlots: [a, b], lastOfferIds: [a.id, b.id], offeredAt: NOW.toISOString() };
    const history = [outbound('Perfecto. Tengo mañana a las 18:00 (hora de España; en México, a las 10:00) o a las 19:30. ¿Cuál te viene mejor?')];
    expect(analyze('A las 10 me va bien', { state, history, lead: makeLead({ whatsappId: MX_PHONE }) }).selectedSlotId).toBe(a.id);
    // Un lead de España no tiene ningún horario a las 10.
    expect(analyze('A las 10 me va bien', { state, history, lead: makeLead({ whatsappId: '34600111222' }) }).selectedSlotId).toBeNull();
  });
});

describe('Huecos que se ofrecen', () => {
  // Martes 6 y miércoles 7, de 9:00 a 12:00 cada media hora.
  const slots = ['06', '07'].flatMap((d) => ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'].map((t) => slotAt(`2026-10-${d}T${t}`)));
  const day = (d: Date) => DateTime.fromJSDate(d).setZone(MADRID).toISODate();

  it('no ofrece los días que el lead ha descartado', () => {
    const picked = pickOfferSlots(slots, MADRID, { excludeDates: ['2026-10-06'] });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.map((s) => day(s.start))).not.toContain('2026-10-06');
    expect(picked.map((s) => day(s.start))).toContain('2026-10-07');
  });

  it('con una hora pedida, primero los huecos más cercanos a ella', () => {
    const picked = pickOfferSlots(slots, MADRID, { nearTime: '11:00' });
    expect(picked.map((s) => DateTime.fromJSDate(s.start).setZone(MADRID).toFormat('HH:mm'))).toEqual(['11:00', '11:00']);
    expect(picked[0].start.getTime()).toBeLessThan(picked[1].start.getTime());
  });
});

describe('Estrategia: hora pedida', () => {
  const input = (overrides: Partial<StrategyInput> = {}): StrategyInput => ({
    biz: makeBusinessContext(),
    leadCtx: makeLeadContext({ lead: makeLead() }),
    state: { callProposedAt: NOW.toISOString() },
    analysis: makeAnalysis({ flags: { wantsCall: true }, preferredTime: '10:00' }),
    kaiHasSpoken: true,
    now: NOW,
    ...overrides,
  });

  it('«¿me podéis llamar a las 10?» busca por la mañana y cerca de las 10', () => {
    const d = decideDirective(input());
    expect(d.kind).toBe('offer_slots');
    expect(d.slotQuery).toMatchObject({ partOfDay: 'morning', time: '10:00' });
  });

  it('con un lead de otro país la hora puede ser la suya: no se deduce nada', () => {
    const d = decideDirective(input({ leadCtx: makeLeadContext({ lead: makeLead({ whatsappId: MX_PHONE }) }) }));
    expect(d.slotQuery?.partOfDay).toBe('any');
    expect(d.slotQuery?.time).toBeUndefined();
  });

  it('las etiquetas que lee un lead de otro país llevan las dos horas', () => {
    const appt = makeAppointment({ startsAt: local('2026-10-06T18:00') });
    const d = decideDirective(
      input({
        leadCtx: makeLeadContext({ lead: makeLead({ whatsappId: MX_PHONE }), upcomingAppointment: appt }),
        analysis: makeAnalysis({ flags: { declinesCall: true } }),
      }),
    );
    expect(d.kind).toBe('confirm_cancel');
    expect(d.instruction).toContain('en México, a las 10:00');
  });
});

describe('Mensajes de la llamada para un lead de otro país', () => {
  const ctx = {
    leadName: 'Luis Pérez',
    trainerName: 'Álex',
    callLabel: 'llamada de valoración',
    startsAt: local('2026-10-06T18:00'),
    timezone: MADRID,
    tone: makeTone(),
    leadPhone: MX_PHONE,
  };

  it('confirmación, recordatorios y plantilla de WhatsApp con su hora', () => {
    expect(confirmationText(ctx)).toContain('(hora de España; en México, a las 10:00)');
    const r1 = reminderText(ctx, '1h');
    expect(r1).toContain('(a las 18:00, hora de España; en México, a las 10:00)');
    expect(r1).not.toMatch(/\([^)]*\(/);
    expect(reminderTemplateParams(ctx)[0]).toContain('en México, a las 10:00');
    // Un lead de España, sin aclaraciones.
    expect(reminderText({ ...ctx, leadPhone: '34600111222' }, '1h')).toContain('(a las 18:00) es la');
  });
});

describe('Motor de reglas', () => {
  const SLOT_A = local('2026-10-07T10:00');
  const SLOT_B = local('2026-10-07T11:00');

  /** Agenda simulada: devuelve `result` para cada herramienta (o huecos libres) y apunta lo que se le pide. */
  function fakeToolbox(result?: Record<string, unknown>, isError = false) {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const toolbox = {
      records: [] as unknown[],
      run: async (name: string, input: Record<string, unknown>) => {
        calls.push({ name, input });
        const r = result ?? { slots: [SLOT_A, SLOT_B].map((d) => ({ slot_id: `s_${d.getTime()}`, label: humanSlotLabel(d, MADRID, NOW) })) };
        return { content: JSON.stringify(r), isError };
      },
    } as unknown as SetterToolbox;
    return { toolbox, calls };
  }

  function agentInput(overrides: Partial<AgentTurnInput> & { said?: string; history?: MessageRow[] } = {}): AgentTurnInput {
    const { said = 'Vale', history = [outbound('Hola')], ...rest } = overrides;
    const msg = inbound(said);
    return {
      biz: makeBusinessContext(),
      leadCtx: makeLeadContext({ lead: makeLead({ name: 'Hugo Martín' }) }),
      convCtx: { conversation: makeConversation(), history: [...history, msg], pendingInbound: [msg], kaiHasSpoken: true },
      state: {},
      directive: { kind: 'post_booking', instruction: '' },
      now: NOW,
      feedback: [],
      toolbox: null,
      mode: 'reply',
      ...rest,
    };
  }
  const say = (input: AgentTurnInput) => new RuleBasedSetterAgent().respond(input).then((o) => o.text);
  const CALENDAR_DOWN = { error: 'No se pudo consultar Google Calendar.', calendar_unavailable: true, note: 'No se puede consultar la agenda ahora mismo.' };

  it('con el calendario caído no dice que el hueco se ha ocupado ni que no hay huecos', async () => {
    const book = fakeToolbox(CALENDAR_DOWN, true);
    const booked = await say(agentInput({ said: 'La primera', toolbox: book.toolbox, directive: { kind: 'book_slot', slotId: 'x', instruction: '' } }));
    expect(booked).not.toMatch(/ocupar|ocupado/);
    expect(booked).toMatch(/no puedo acceder a la agenda/);
    expect(book.calls.map((c) => c.name)).toEqual(['book_call']);

    const offer = fakeToolbox(CALENDAR_DOWN, true);
    const offered = await say(agentInput({ said: 'Sí', toolbox: offer.toolbox, directive: { kind: 'offer_slots', instruction: '', needsSlots: true } }));
    expect(offered).toMatch(/no puedo consultar la agenda/);
    expect(offered).not.toMatch(/no veo huecos/);
  });

  it('tras rechazar los horarios: sin «Perfecto» y sin los días descartados', async () => {
    const { toolbox, calls } = fakeToolbox();
    const text = await say(
      agentInput({
        said: 'El lunes no puedo',
        toolbox,
        directive: { kind: 'offer_slots', instruction: '', needsSlots: true, afterRejection: true, slotQuery: { date: null, partOfDay: 'any', excludeDates: ['2026-10-12'] } },
      }),
    );
    expect(text).not.toMatch(/^(Perfecto|Genial)/);
    expect(calls[0].input.exclude_dates).toEqual(['2026-10-12']);
  });

  it('con la hora que pide, se buscan los huecos cercanos a ella', async () => {
    const { toolbox, calls } = fakeToolbox();
    await say(agentInput({ said: '¿A las 10?', toolbox, directive: { kind: 'offer_slots', instruction: '', needsSlots: true, slotQuery: { date: null, partOfDay: 'morning', time: '10:00' } } }));
    expect(calls[0].input).toMatchObject({ part_of_day: 'morning', near_time: '10:00' });
  });

  it('mantiene la llamada como estaba, da las gracias o un «vale» con la llamada agendada', async () => {
    const leadCtx = makeLeadContext({ lead: makeLead({ name: 'Hugo Martín' }), upcomingAppointment: makeAppointment({ startsAt: local('2026-10-07T10:00') }) });
    const keep = await say(agentInput({ said: 'Mejor la dejamos como estaba', leadCtx, directive: { kind: 'post_booking', instruction: '', keepsBooking: true } }));
    expect(keep).toMatch(/como estaba|mantenemos/);
    expect(keep).toContain('pasado mañana a las 10:00');
    const thanks = await say(agentInput({ said: 'Gracias', leadCtx }));
    expect(thanks).toMatch(/^(Gracias a ti|A ti)\b/);
    for (const said of ['Vale', 'Ok']) expect(await say(agentInput({ said, leadCtx }))).not.toMatch(/Gracias por escribir/);
    // Sin paréntesis dentro de paréntesis con la hora de un lead de otro país.
    const mx = makeLeadContext({ lead: makeLead({ name: 'Luis', whatsappId: MX_PHONE }), upcomingAppointment: makeAppointment({ startsAt: local('2026-10-07T10:00') }) });
    for (let i = 0; i < 4; i++) {
      const text = await say(agentInput({ said: 'Ok', leadCtx: mx, history: [outbound(`Hola ${i}`)] }));
      expect(text).not.toMatch(/\([^)]*\(/);
    }
  });

  it('«¿cuánto dura la llamada y para qué es?»: la duración y para qué es, sin repetirlo', async () => {
    const text = await say(agentInput({ said: '¿Cuánto dura la llamada y para qué es?', directive: { kind: 'reassure_call', instruction: '' } }));
    expect(text).toMatch(/dura \d+ minutos/);
    expect(text.match(/conozca tu caso/g)).toHaveLength(1);
    expect((text.match(/\?/g) ?? []).length).toBe(1);
  });

  it('responde a «¿cómo funciona?» también en el saludo', async () => {
    const text = await say(agentInput({ said: 'Hola! Quiero bajar de peso, ¿cómo funciona?', directive: { kind: 'greet_and_ask', instruction: '', question: '¿Cómo es tu día a día?' }, firstMessage: true, history: [] }));
    expect(text).toMatch(/incluye/);
    expect((text.match(/\?/g) ?? []).length).toBe(1);
  });
});

describe('Juez con IA', () => {
  it('si no responde, lo dice (unavailable) en vez de dar el borrador por revisado sin más', async () => {
    const provider = { id: 'x', describe: () => 'x', chat: async () => ({}), structured: async () => Promise.reject(new Error('caído')) } as unknown as LLMProvider;
    const r = await judgeReply(provider, { reply: 'Hola', lastLeadMessages: 'Hola', facts: '', objective: '' });
    expect(r).toMatchObject({ ok: true, unavailable: true });
  });
});

