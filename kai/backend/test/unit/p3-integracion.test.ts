/**
 * Revisión nº3 — integración final: lo que se vio al simular conversaciones completas en modo sin IA.
 *  - «Encaje» guardaba como valor cualquier mensaje posterior (“¿qué incluye el programa?”).
 *  - «¿Puede ser una hora más tarde?» ofrecía horarios ANTERIORES a la llamada que ya tenía.
 *  - Preguntar «¿eres un bot?» tras proponer la llamada recibía «Claro, sin ninguna prisa…».
 *  - Un simple «Gracias» recibía «Entiendo.» antes de la siguiente pregunta.
 * Sin base de datos: análisis heurístico + motor de reglas con una agenda simulada.
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import { decideDirective } from '../../src/ai/setter/strategy.js';
import type { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import { pickOfferSlots } from '../../src/calendar/availability.js';
import { questionCount } from '../../src/lib/domain.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import {
  inbound,
  local,
  makeAnalysis,
  makeAnalysisInput,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeService,
  NOW,
  offeredAt,
  outbound,
  qualificationOf,
  slotAt,
} from './factories.js';

// ───────────── «Encaje» en la ficha ─────────────

describe('El encaje deducido del objetivo no guarda frases sueltas', () => {
  it('la primera vez se guarda con el objetivo como prueba', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Quiero perder 10 kilos'));
    expect(a.signals.fit).toBe('yes');
    expect(a.qualification.fit?.level).toBe('yes');
    expect(a.qualification.fit?.value).toBe(a.qualification.goal?.value);
  });

  it('un mensaje posterior (“¿qué incluye el programa?”) no pasa a ser el valor del encaje', () => {
    const lead = makeLead({ qualification: { ...qualificationOf({ goal: 'perder 10 kilos' }), fit: { value: 'perder 10 kilos', confidence: 0.6, updatedAt: NOW.toISOString(), level: 'yes' } } });
    const a = analyzeHeuristically(makeAnalysisInput('Una pregunta, ¿qué incluye el programa?', { lead }));
    expect(a.signals.fit).toBe('yes');
    expect(a.qualification.fit).toBeUndefined();
  });

  it('un menor sigue marcando «no encaja» con su propio mensaje', () => {
    const a = analyzeHeuristically(makeAnalysisInput('Tengo 16 años y quiero perder grasa'));
    expect(a.qualification.fit?.level).toBe('no');
    expect(a.qualification.fit?.value).toContain('16 años');
  });
});

// ───────────── Motor de reglas ─────────────

const appt = makeAppointment(); // miércoles 7/10 a las 18:00 (Madrid); NOW = lunes 5/10, 12:00

/** Agenda simulada que apunta con qué datos se consultó. */
function recordingToolbox() {
  const calls: Record<string, unknown>[] = [];
  const run = async (name: string, input: Record<string, unknown>) => {
    let result: unknown = { ok: true };
    if (name === 'get_available_slots') {
      calls.push(input);
      result = { slots: [local('2026-10-07T19:00'), local('2026-10-07T20:00')].map((d) => ({ slot_id: `s_${d.getTime()}`, label: humanSlotLabel(d, 'Europe/Madrid', NOW) })) };
    }
    return { content: JSON.stringify(result), isError: false };
  };
  return { calls, toolbox: { records: [], run } as unknown as SetterToolbox };
}

function agentInput(text: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    biz: makeBusinessContext({ services: [makeService({ name: 'Programa 12 semanas', priceCents: 19700 })] }),
    leadCtx: makeLeadContext(),
    convCtx: { conversation: makeConversation(), history: [outbound('Hola'), inbound(text)], pendingInbound: [inbound(text)], kaiHasSpoken: true },
    state: {},
    directive: { kind: 'post_booking', instruction: '' },
    now: NOW,
    feedback: [],
    toolbox: null,
    mode: 'reply',
    ...overrides,
  };
}

describe('Mover la llamada «más tarde» o «antes» ofrece horarios en ese sentido', () => {
  it.each([
    ['¿Puede ser una hora más tarde?', 'later_than'],
    ['¿La podemos poner un poco más tarde?', 'later_than'],
    ['¿Podría ser un poco antes?', 'earlier_than'],
    ['Mejor media hora más pronto', 'earlier_than'],
  ])('«%s» → consulta ese mismo día con %s = la hora actual de la llamada', async (text, key) => {
    const { calls, toolbox } = recordingToolbox();
    const out = await new RuleBasedSetterAgent().respond(
      agentInput(text, { leadCtx: makeLeadContext({ upcomingAppointment: appt }), directive: { kind: 'reschedule', instruction: '', needsSlots: true, slotQuery: { date: null, partOfDay: 'any' } }, toolbox }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].date).toBe('2026-10-07');
    expect(calls[0][key]).toBe(appt.startsAt.toISOString());
    expect(out.text).toMatch(/^Sin problema, lo movemos\./);
    expect(questionCount(out.text)).toBe(1);
  });

  it('sin «más tarde» ni «antes» se consulta como siempre (el día que pida, sin límite de hora)', async () => {
    const { calls, toolbox } = recordingToolbox();
    await new RuleBasedSetterAgent().respond(
      agentInput('Mejor el jueves', { leadCtx: makeLeadContext({ upcomingAppointment: appt }), directive: { kind: 'reschedule', instruction: '', needsSlots: true, slotQuery: { date: '2026-10-08', partOfDay: 'any' } }, toolbox }),
    );
    expect(calls).toEqual([{ date: '2026-10-08', part_of_day: 'any' }]);
  });

  it('pickOfferSlots respeta «después de» y «antes de»', () => {
    const slots = ['2026-10-07T10:00', '2026-10-07T17:00', '2026-10-07T18:30', '2026-10-07T19:30'].map((t) => slotAt(t));
    const after = pickOfferSlots(slots, 'Europe/Madrid', { after: appt.startsAt });
    expect(after.map((s) => s.start.getTime())).toEqual([local('2026-10-07T18:30').getTime(), local('2026-10-07T19:30').getTime()]);
    const before = pickOfferSlots(slots, 'Europe/Madrid', { before: appt.startsAt });
    expect(before.every((s) => s.start < appt.startsAt)).toBe(true);
    expect(before).toHaveLength(2);
  });
});

describe('«¿Eres un bot?» con la llamada propuesta o agendada', () => {
  const botNote = 'El lead pregunta si eres un bot: responde con honestidad que eres el asistente automatizado del equipo.';

  it('tras proponer la llamada: transparencia y vuelve a preguntar si le encaja (sin «sin ninguna prisa»)', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput('Espera, ¿estoy hablando con una persona real?', { directive: { kind: 'reassure_call', instruction: '' }, extraNote: botNote }),
    );
    expect(out.text).toMatch(/^Te soy sincero: soy KAI, el asistente automatizado/);
    expect(out.text).not.toContain('sin ninguna prisa');
    expect(out.text).toMatch(/¿te encaja\?$/);
    expect(questionCount(out.text)).toBe(1);
  });

  it('si además tiene una duda, se mantiene la respuesta para resolverla', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput('¿Eres un bot? ¿Y la llamada para qué es?', { directive: { kind: 'reassure_call', instruction: '' }, extraNote: botNote }),
    );
    expect(out.text).toContain('sin ninguna prisa');
  });

  it('con la llamada agendada: transparencia y le recuerda que sigue en pie (sin un «Entendido.» suelto)', async () => {
    const out = await new RuleBasedSetterAgent().respond(agentInput('¿Eres una IA?', { leadCtx: makeLeadContext({ upcomingAppointment: appt }), extraNote: botNote }));
    expect(out.text).toMatch(/^Te soy sincero: soy KAI/);
    expect(out.text).toContain(`La llamada de valoración sigue en pie ${humanSlotLabel(appt.startsAt, 'Europe/Madrid', NOW)}`);
    expect(out.text).not.toContain('Entendido.');
  });
});

describe('Un simple «gracias» no recibe «Entiendo.»', () => {
  it.each(['Gracias', 'Muchas gracias!', 'Vale, gracias'])('«%s» → «Gracias a ti.» antes de la siguiente pregunta', async (text) => {
    const out = await new RuleBasedSetterAgent().respond(agentInput(text, { directive: { kind: 'ask_qualification', instruction: '', question: '¿Qué has probado hasta ahora?' } }));
    expect(out.text).toBe('Gracias a ti. ¿Qué has probado hasta ahora?');
  });

  it('una respuesta con más contenido mantiene el reconocimiento habitual', async () => {
    const out = await new RuleBasedSetterAgent().respond(
      agentInput('Gracias, la verdad es que trabajo mucho', { state: { lastAskedKey: 'current_situation' }, directive: { kind: 'ask_qualification', instruction: '', question: '¿Qué has probado hasta ahora?' } }),
    );
    expect(out.text).not.toMatch(/^Gracias a ti/);
  });
});

// ───────────── Pide el mismo día que ya se le ofreció ─────────────

describe('Si pide un día que ya cumplen los horarios ofrecidos, se le pregunta cuál (no se repite la oferta)', () => {
  const A = offeredAt('2026-10-06T10:00', 'Europe/Madrid', 'mañana a las 10:00');
  const B = offeredAt('2026-10-06T17:00', 'Europe/Madrid', 'mañana a las 17:00');
  const state = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: new Date(NOW.getTime() - 3600_000).toISOString(), callProposedAt: NOW.toISOString() };
  const decide = (analysis: ReturnType<typeof makeAnalysis>, upcomingAppointment?: ReturnType<typeof makeAppointment>) =>
    decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ upcomingAppointment }), state, analysis, kaiHasSpoken: true, now: NOW });

  it('sin llamada: «mejor el martes» con los dos horarios el martes → clarify_slot', () => {
    expect(decide(makeAnalysis({ flags: { wantsCall: true }, preferredDate: '2026-10-06' })).kind).toBe('clarify_slot');
    expect(decide(makeAnalysis({ flags: { wantsCall: true }, preferredPartOfDay: 'afternoon' })).kind).toBe('offer_slots');
    expect(decide(makeAnalysis({ flags: { wantsCall: true }, preferredDate: '2026-10-09' })).kind).toBe('offer_slots');
  });

  it('moviendo la llamada: igual (antes repetía el mensaje y el control de calidad lo escalaba)', () => {
    const other = makeAppointment({ startsAt: local('2026-10-08T18:00') });
    expect(decide(makeAnalysis({ flags: { wantsReschedule: true }, preferredDate: '2026-10-06' }), other).kind).toBe('clarify_slot');
    expect(decide(makeAnalysis({ flags: { wantsReschedule: true }, preferredDate: '2026-10-07' }), other).kind).toBe('reschedule');
    expect(decide(makeAnalysis({ flags: { wantsReschedule: true } }), other).kind).toBe('reschedule');
  });
});
