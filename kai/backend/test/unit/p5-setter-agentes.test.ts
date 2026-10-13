/**
 * Revisión nº5 (setter, motor de reglas): sin promesas de recordatorio, sin textos repetidos que escalan la
 * conversación, acuses que dependen de lo que ha contestado el lead, respuesta honesta a sus preguntas, descalificación
 * con explicación, precio con horarios ya ofrecidos, segunda pregunta médica, «del lunes» y objetivo citado con
 * naturalidad en los seguimientos. Sin base de datos.
 */
import { describe, expect, it } from 'vitest';
import { avoidRepeating, goalPhrase, lowerQuestion, ofLabel, RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import type { SetterToolbox } from '../../src/ai/tools/setter-tools.js';
import type { SetterState } from '../../src/ai/setter/strategy.js';
import type { MessageRow } from '../../src/ai/context/context.js';
import { normalize } from '../../src/lib/text.js';
import { questionCount } from '../../src/lib/domain.js';
import { humanSlotLabel } from '../../src/lib/time.js';
import {
  inbound,
  local,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeMessage,
  makeObjections,
  makeService,
  makeSettings,
  makeTrainer,
  NOW,
  outbound,
  qualificationOf,
} from './factories.js';

const SLOT_A = local('2026-10-06T18:00');
const SLOT_B = local('2026-10-06T19:30');

/** Agenda simulada para el motor de reglas (sin base de datos). */
function fakeToolbox(opts: { slots?: Date[] } = {}): SetterToolbox {
  const records: { name: string; input: Record<string, unknown>; ok: boolean; result: unknown }[] = [];
  const run = async (name: string, input: Record<string, unknown>) => {
    let result: unknown;
    if (name === 'get_available_slots') result = { slots: (opts.slots ?? [SLOT_A, SLOT_B]).map((d) => ({ slot_id: `s_${d.getTime()}`, label: humanSlotLabel(d, 'Europe/Madrid', NOW) })) };
    else if (name === 'book_call' || name === 'reschedule_call') result = { ok: true, confirmed: true, label: humanSlotLabel(SLOT_A, 'Europe/Madrid', NOW), meeting_url: null };
    else result = { ok: true };
    records.push({ name, input, ok: true, result });
    return { content: JSON.stringify(result), isError: false };
  };
  return { records, run } as unknown as SetterToolbox;
}

const biz = makeBusinessContext({ services: [makeService({ name: 'Programa Recomposición', priceCents: 14900, durationWeeks: 12 })] });

function conv(history: MessageRow[], pending: MessageRow[] = history.filter((m, i) => m.direction === 'inbound' && i === history.length - 1)) {
  return { conversation: makeConversation(), history, pendingInbound: pending, kaiHasSpoken: true };
}

function agentInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    biz,
    leadCtx: makeLeadContext({ lead: makeLead({ name: 'Hugo Martín' }) }),
    convCtx: conv([outbound('Hola'), inbound('Vale')]),
    state: {},
    directive: { kind: 'post_booking', instruction: '' },
    now: NOW,
    feedback: [],
    toolbox: null,
    mode: 'reply',
    ...overrides,
  };
}

const say = (overrides: Partial<AgentTurnInput>) => new RuleBasedSetterAgent().respond(agentInput(overrides)).then((o) => o.text);

/** ¿Lo rechazaría el control de calidad por repetir uno de los 4 últimos mensajes de KAI? */
function repeatsRecent(text: string, history: MessageRow[]) {
  const recent = history.filter((m) => m.direction === 'outbound').slice(-4).map((m) => normalize(m.content));
  return recent.includes(normalize(text));
}

/** Conversación en bucle: el lead escribe lo mismo varias veces y KAI responde con la misma directiva. */
async function loop(leadSays: string[], build: (history: MessageRow[], turn: number) => Partial<AgentTurnInput>, start: MessageRow[] = [outbound('Hola, ¿qué tal?')]) {
  const history = [...start];
  const replies: string[] = [];
  for (let i = 0; i < leadSays.length; i++) {
    const msg = inbound(leadSays[i]);
    history.push(msg);
    const text = await say({ convCtx: conv(history, [msg]), ...build(history, i) });
    expect(repeatsRecent(text, history), `turno ${i + 1}: «${text}»`).toBe(false);
    replies.push(text);
    history.push(outbound(text));
  }
  return replies;
}

// ───────────── 1) Sin prometer recordatorios ─────────────

describe('Al reservar, el motor de reglas no promete un recordatorio', () => {
  it('«¡Hecho! Te apunto…» no dice que le llegará un recordatorio (puede estar desactivado o el canal no permitirlo)', async () => {
    const text = await say({ directive: { kind: 'book_slot', instruction: '', slotId: 's_1' }, toolbox: fakeToolbox() });
    expect(text).toMatch(/^¡Hecho! Te apunto para/);
    expect(text).not.toMatch(/recordatorio/i);
  });
});

// ───────────── 2) Textos fijos repetidos que escalaban la conversación ─────────────

describe('El motor de reglas no repite literalmente un mensaje reciente (el control de calidad lo rechazaría)', () => {
  it('volver a pedir la llamada (p. ej. tras cancelarla) ofrece los mismos horarios con otras palabras', async () => {
    const replies = await loop(['Vale, ¿qué horarios tienes?', 'Al final sí quiero la llamada', 'Venga, dime horarios otra vez', 'Pásame horarios'], () => ({
      directive: { kind: 'offer_slots', instruction: '', needsSlots: true },
      toolbox: fakeToolbox(),
    }));
    expect(new Set(replies).size).toBe(replies.length);
    for (const t of replies) {
      expect(t).toContain('18:00');
      expect(questionCount(t)).toBe(1);
    }
  });

  it('si dice que no a los horarios («el martes no puedo»), no empieza con «Perfecto»', async () => {
    const text = await say({ convCtx: conv([outbound('Hola'), inbound('No, el martes no puedo')]), directive: { kind: 'offer_slots', instruction: '', needsSlots: true }, toolbox: fakeToolbox() });
    expect(text).not.toMatch(/^(Perfecto|Genial)/);
  });

  it('mover la llamada varias veces no repite el mismo texto', async () => {
    const replies = await loop(['¿La podemos mover?', 'Mejor otro día', '¿Y otro hueco?'], () => ({
      leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }),
      directive: { kind: 'reschedule', instruction: '', needsSlots: true },
      toolbox: fakeToolbox(),
    }));
    expect(new Set(replies).size).toBe(3);
  });

  it('sin huecos libres, tampoco repite el mismo aviso', async () => {
    const replies = await loop(['¿Tienes hueco?', '¿Y ahora?', '¿Nada?'], () => ({ directive: { kind: 'offer_slots', instruction: '', needsSlots: true }, toolbox: fakeToolbox({ slots: [] }) }));
    for (const t of replies) expect(t).toMatch(/hueco/);
  });

  it('preguntar el precio cinco veces seguidas no escala la conversación', async () => {
    const replies = await loop(['¿Cuánto cuesta?', '¿Cuánto cuesta?', '¿Pero cuánto es?', '¿Cuánto vale entonces?', '¿Y el precio?', '¿Cuánto?'], (_h, i) => ({
      state: (i === 0 ? {} : { priceShared: true }) as SetterState,
      directive: { kind: 'share_price', instruction: '' },
    }));
    for (const t of replies) expect(t).toMatch(/149/);
  });

  it('la misma objeción por tercera vez: se respeta sin volver a sondear (y sin repetirse)', async () => {
    const price = makeObjections().find((o) => o.key === 'expensive')!;
    const replies = await loop(['Es muy caro para mí', 'Es muy caro para mí', 'Es muy caro para mí', 'Es muy caro para mí', 'Es muy caro para mí'], (_h, i) => ({
      state: { objectionsHandled: Array(i).fill('expensive') },
      directive: { kind: 'handle_objection', instruction: '', objection: price },
    }));
    expect(questionCount(replies[2])).toBe(0);
    expect(replies[2]).toMatch(/insistir|respeto/);
    expect(questionCount(replies[3])).toBe(0);
  });

  it('objeciones distintas encadenadas tienen variantes suficientes', async () => {
    const objections = makeObjections();
    const time = objections.find((o) => o.key === 'no_time')!;
    const replies = await loop(['Ahora mismo no tengo tiempo', 'No tengo tiempo', 'De verdad, no tengo tiempo'], (_h, i) => ({
      state: { objectionsHandled: ['expensive', 'expensive', ...Array(i).fill('no_time')] },
      directive: { kind: 'handle_objection', instruction: '', objection: time },
    }));
    expect(new Set(replies).size).toBe(3);
  });

  it('avoidRepeating: si coincide con un mensaje reciente, cambia el arranque (sin «Entendido. Entendido, …»)', () => {
    expect(avoidRepeating('Hola, ¿qué tal?', ['otra cosa'], 320)).toBe('Hola, ¿qué tal?');
    const again = avoidRepeating('Perfecto. Tengo mañana a las 18:00. ¿Te viene bien?', ['perfecto. tengo mañana a las 18:00. ¿te viene bien?'], 320);
    expect(again).toMatch(/^(Entendido|De acuerdo|Vale)\. Tengo mañana a las 18:00\. ¿Te viene bien\?$/);
    for (let seed = 0; seed < 3; seed++) {
      const t = avoidRepeating('Entendido, no te voy a insistir.', ['Entendido, no te voy a insistir.'], 320, seed);
      expect(t).not.toMatch(/^Entendido\. Entendido/);
      expect(normalize(t)).not.toBe(normalize('Entendido, no te voy a insistir.'));
    }
  });
});

// ───────────── 3) Acuses según lo que ha contestado ─────────────

describe('El acuse depende de lo que ha contestado el lead', () => {
  const goalQ = { kind: 'ask_qualification' as const, instruction: '', questionKey: 'goal', question: '¿Qué te gustaría conseguir exactamente?' };

  it('«ok» a la pregunta del objetivo: no elogia lo que no ha dicho y la pregunta se reformula', async () => {
    const text = await say({ convCtx: conv([outbound('¿Qué te gustaría conseguir exactamente?'), inbound('ok')]), state: { lastAskedKey: 'goal' }, directive: goalQ });
    expect(text).not.toMatch(/claro|sentido|Genial/);
    expect(text).not.toBe('¿Qué te gustaría conseguir exactamente?');
    expect(text).toMatch(/¿qué te gustaría conseguir exactamente\?/i);
    expect(questionCount(text)).toBe(1);
  });

  it.each(['vale', '👍', 'ya', 'jajaja'])('«%s» no recibe un acuse de respuesta', async (reply) => {
    const text = await say({
      convCtx: conv([outbound('¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?'), inbound(reply)]),
      state: { lastAskedKey: 'current_situation' },
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'current_situation', question: '¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?' },
    });
    expect(text).not.toMatch(/gracias por contármelo|Te entiendo/i);
  });

  it.each(['Que no', 'No', 'Mmm, no estoy seguro', 'Ni idea'])('«%s» no recibe un «Genial» ni un «Perfecto»', async (reply) => {
    const text = await say({
      convCtx: conv([outbound('¿Te planteas invertir en un acompañamiento profesional para conseguirlo?'), inbound(reply)]),
      state: { lastAskedKey: 'budget' },
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'commitment', question: 'Si encontraras la forma de hacerlo, ¿estarías dispuesto a comprometerte de verdad unos meses?' },
    });
    expect(text).not.toMatch(/Genial|Perfecto|Me encanta|claro/);
  });

  it('si el análisis guardó la respuesta, sí usa el acuse de esa variable', async () => {
    const lead = makeLead({ qualification: qualificationOf({ goal: 'perder 10 kilos' }) });
    const text = await say({
      leadCtx: makeLeadContext({ lead }),
      convCtx: conv([outbound('¿Qué te gustaría conseguir exactamente?'), inbound('Quiero perder 10 kilos')]),
      state: { lastAskedKey: 'goal' },
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'current_situation', question: '¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?' },
    });
    expect(text).toMatch(/^(Genial, es un objetivo muy claro|Perfecto, tiene todo el sentido|Me gusta que lo tengas tan claro)\./);
  });

  it('lowerQuestion: sin «Y cuéntame, ¿y qué…?»', () => {
    expect(lowerQuestion('¿Y qué crees que te está impidiendo conseguirlo ahora?')).toBe('¿qué crees que te está impidiendo conseguirlo ahora?');
    expect(lowerQuestion('¿Qué has probado hasta ahora?')).toBe('¿qué has probado hasta ahora?');
    expect(lowerQuestion('Si encontraras la forma, ¿te comprometerías?')).toBe('si encontraras la forma, ¿te comprometerías?');
  });
});

// ───────────── 4) Preguntas del lead que el motor no contestaba ─────────────

describe('Preguntas del lead: respuesta honesta y sin «¿qué duda tienes?»', () => {
  it('tras proponer la llamada, «¿Es online o presencial?» se responde y no se le pregunta qué duda tiene', async () => {
    const text = await say({ convCtx: conv([outbound('¿Te encaja la llamada?'), inbound('¿Es online o presencial?')]), state: { callProposedAt: NOW.toISOString() }, directive: { kind: 'reassure_call', instruction: '' } });
    expect(text).toMatch(/Es online\./);
    expect(text).not.toMatch(/qué duda/i);
    expect(questionCount(text)).toBe(1);
  });

  it('la modalidad sale de la ficha del entrenador', async () => {
    const presencial = makeBusinessContext({ trainer: makeTrainer({ modality: 'presencial' }), services: biz.services });
    const text = await say({ biz: presencial, convCtx: conv([outbound('Hola'), inbound('¿Es online o presencial?')]), directive: { kind: 'reassure_call', instruction: '' } });
    expect(text).toMatch(/Es presencial\./);
  });

  it('«¿Y cuánto dura el programa?» al cualificar: se responde con la duración y no se repite la pregunta tal cual', async () => {
    const q = '¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?';
    const text = await say({
      convCtx: conv([outbound(`Es online. ${q}`), inbound('¿Y cuánto dura el programa?')]),
      state: { lastAskedKey: 'current_situation' },
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'current_situation', question: q },
    });
    expect(text).toMatch(/Programa Recomposición dura 12 semanas\./);
    expect(text).not.toBe(q);
    expect(questionCount(text)).toBe(1);
  });

  it('con la llamada agendada, «¿Me llamáis vosotros?» no recibe «cualquier duda, me la preguntas»', async () => {
    const text = await say({
      leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }),
      convCtx: conv([outbound('¡Hecho! Te apunto para el miércoles 7 a las 18:00.'), inbound('¿Me llamáis vosotros?')]),
      directive: { kind: 'post_booking', instruction: '' },
    });
    expect(text).not.toMatch(/cualquier duda|me la preguntas/i);
    expect(text).toMatch(/Álex/);
    expect(text).toMatch(/inexacto/);
  });

  it('con datos de la llamada configurados, se le dan', async () => {
    const withCall = makeBusinessContext({ services: biz.services, settings: makeSettings({ callDescription: 'Es una videollamada por Google Meet; te llama Álex' }) });
    const text = await say({
      biz: withCall,
      leadCtx: makeLeadContext({ upcomingAppointment: makeAppointment() }),
      convCtx: conv([outbound('Hecho.'), inbound('¿Me llamáis vosotros?')]),
      directive: { kind: 'post_booking', instruction: '' },
    });
    expect(text).toContain('Es una videollamada por Google Meet; te llama Álex.');
  });

  it('sin dato, no se inventa nada: lo concreta el entrenador', async () => {
    const text = await say({ convCtx: conv([outbound('Hola'), inbound('¿Tenéis app para registrar las comidas?')]), directive: { kind: 'continue_without_call', instruction: '' } });
    expect(text).toMatch(/concretar mejor Álex; prefiero no decirte nada inexacto/);
    expect(text).not.toMatch(/pregúntame|me la preguntas/);
  });

  it('la charla («¿qué tal?») no se trata como una duda', async () => {
    const text = await say({ convCtx: conv([outbound('Hola'), inbound('Bien, ¿y tú?')]), directive: { kind: 'continue_without_call', instruction: '' } });
    expect(text).not.toMatch(/inexacto/);
  });
});

// ───────────── 5) Lead que no encaja ─────────────

describe('Descalificación: la primera vez siempre con la explicación honesta', () => {
  it('ningún lead recibe «Gracias a ti» ni una despedida sin explicación en el primer mensaje', async () => {
    for (let i = 0; i < 8; i++) {
      const text = await say({
        leadCtx: makeLeadContext({ lead: makeLead({ name: 'Hugo' }) }),
        convCtx: { ...conv([inbound('Hola, tengo 16 años y quiero perder grasa')]), kaiHasSpoken: false },
        firstMessage: true,
        directive: { kind: 'disqualify_kindly', instruction: '' },
      });
      expect(text).toMatch(/no sería lo más adecuado para ti/);
      expect(text).not.toMatch(/Gracias a ti/);
    }
  });

  it('después, si da las gracias, se le contesta a eso (sin repetir la explicación)', async () => {
    const first = makeMessage({ direction: 'outbound', content: 'Gracias por contármelo con tanta sinceridad. Por lo que me cuentas, ahora mismo creo que esto no sería lo más adecuado para ti, y prefiero ser honesto contigo. Te deseo mucho ánimo.', metadata: { directive: 'disqualify_kindly' } });
    const text = await say({ convCtx: conv([inbound('Tengo 16 años'), first, inbound('Vale, gracias')]), directive: { kind: 'disqualify_kindly', instruction: '' } });
    expect(text).toMatch(/^(Gracias a ti|A ti)\./);
    const other = await say({ convCtx: conv([inbound('Tengo 16 años'), first, inbound('¿Seguro?')]), directive: { kind: 'disqualify_kindly', instruction: '' } });
    expect(other).not.toMatch(/Gracias a ti|no sería lo más adecuado/);
  });
});

// ───────────── 6) Precio con horarios ya ofrecidos ─────────────

describe('Precio cuando ya tiene horarios ofrecidos', () => {
  const offered = [SLOT_A, SLOT_B].map((d) => ({ id: `s_${d.getTime()}`, start: d.toISOString(), end: new Date(d.getTime() + 30 * 60_000).toISOString(), label: '' }));
  const state = { callProposedAt: NOW.toISOString(), callAccepted: true, offeredSlots: offered, lastOfferIds: offered.map((o) => o.id), offeredAt: NOW.toISOString() } as SetterState;
  const offerMsg = outbound('Perfecto. Tengo mañana a las 18:00 o a las 19:30. ¿Cuál te viene mejor?');

  it('«Perfecto, ¿y cuánto cuesta?» → precio y retoma los horarios (no vuelve a proponer la llamada)', async () => {
    const text = await say({ convCtx: conv([offerMsg, inbound('Perfecto, ¿y cuánto cuesta?')]), state, directive: { kind: 'share_price', instruction: '' } });
    expect(text).toMatch(/149/);
    expect(text).toMatch(/18:00/);
    expect(text).not.toMatch(/¿Te gustaría verlo/);
    expect(questionCount(text)).toBe(1);
  });

  it('«¿Y tiene algún coste?» → aclara que el precio es el del programa (la llamada no se da por gratis si no está configurado)', async () => {
    const text = await say({ convCtx: conv([offerMsg, inbound('¿Y tiene algún coste?')]), state, directive: { kind: 'share_price', instruction: '' } });
    expect(text).toMatch(/del programa/);
    expect(text).not.toMatch(/no tiene coste|gratis/);
    expect(text).toMatch(/18:00/);
  });

  it('si la descripción de la llamada dice que es gratuita, se le dice', async () => {
    const free = makeBusinessContext({ services: biz.services, settings: makeSettings({ callDescription: 'Llamada gratuita de 30 minutos' }) });
    const text = await say({ biz: free, convCtx: conv([offerMsg, inbound('¿Y tiene algún coste?')]), state, directive: { kind: 'share_price', instruction: '' } });
    expect(text).toMatch(/no tiene coste/);
  });

  it('con la llamada ya propuesta (sin horarios), no se le vuelve a presentar', async () => {
    const text = await say({ convCtx: conv([outbound('¿Te encaja la llamada?'), inbound('¿Cuánto cuesta?')]), state: { callProposedAt: NOW.toISOString() }, directive: { kind: 'share_price', instruction: '' } });
    expect(text).not.toMatch(/¿Te gustaría verlo/);
  });
});

// ───────────── 7) Segunda pregunta médica con el escalado desactivado ─────────────

describe('Tema de salud con el escalado médico desactivado', () => {
  const notice = makeMessage({ direction: 'outbound', content: 'Aviso sanitario…', metadata: { kind: 'medical_notice' } });
  const laterNote = 'Ha mencionado un tema de salud (ya le recomendaste revisarlo con un profesional sanitario): no des consejos médicos ni diagnósticos.';
  const q = '¿Y qué crees que te está impidiendo conseguirlo ahora?';

  it('si vuelve a preguntar algo médico, se le remite a su médico (sin acuses positivos)', async () => {
    const text = await say({
      convCtx: conv([notice, outbound(`Entendido. ${q}`), inbound('¿Y tengo que dejar la insulina para entrenar?')]),
      state: { lastAskedKey: 'problem' },
      extraNote: laterNote,
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'problem', question: q },
    });
    expect(text).toMatch(/médico/);
    expect(text).not.toMatch(/Genial|Perfecto|inexacto/);
    expect(text).not.toMatch(/¿y qué crees/);
    expect(questionCount(text)).toBe(1);
  });

  it('si el aviso se acaba de enviar en un mensaje aparte, no se repite', async () => {
    const text = await say({
      convCtx: conv([inbound('Quiero perder 10 kilos, tengo diabetes tipo 2'), notice], [inbound('Quiero perder 10 kilos, tengo diabetes tipo 2')]),
      state: { lastAskedKey: 'goal' },
      extraNote: 'Ha mencionado un tema de salud y acabas de enviarle este aviso en un mensaje aparte: “…”. No lo repitas.',
      directive: { kind: 'ask_qualification', instruction: '', questionKey: 'current_situation', question: '¿Cómo es tu día a día ahora mismo con el entrenamiento y la comida?' },
    });
    expect(text).not.toMatch(/médico/);
    expect(text).not.toMatch(/Genial|Me gusta/);
  });
});

// ───────────── 8) «del lunes», no «de el lunes» ─────────────

describe('confirm_cancel con la contracción «del»', () => {
  it('«¿Prefieres que cancele la llamada de valoración del lunes 12…?»', async () => {
    const appt = makeAppointment({ startsAt: local('2026-10-12T19:00') });
    for (let i = 0; i < 3; i++) {
      const text = await say({ leadCtx: makeLeadContext({ lead: makeLead({ name: `Lead ${i}` }), upcomingAppointment: appt }), directive: { kind: 'confirm_cancel', instruction: '' } });
      expect(text).toMatch(/llamada de valoración del lunes 12 .*a las 19:00/);
      expect(text).not.toMatch(/de el /);
    }
  });

  it('ofLabel', () => {
    expect(ofLabel('el lunes 12 a las 19:00')).toBe('del lunes 12 a las 19:00');
    expect(ofLabel('mañana a las 10:00')).toBe('de mañana a las 10:00');
    expect(ofLabel('pasado mañana a las 10:00')).toBe('de pasado mañana a las 10:00');
  });
});

// ───────────── 9) El objetivo citado en los seguimientos ─────────────

describe('Seguimientos: el objetivo se cita con naturalidad', () => {
  it.each([
    ['Quiero perder unos 10 kilos, sobre todo la barriga', 'perder unos 10 kilos'],
    ['perder 10 kilos', 'perder 10 kilos'],
    ['Hola, pues mira, me gustaría bajar barriga para el verano', 'bajar barriga para el verano'],
    ['Mi objetivo es ganar músculo', 'ganar músculo'],
    ['Quiero ponerme en forma para la boda de mi hermana', 'ponerte en forma para la boda de tu hermana'],
    ['Que me quede bien la ropa', 'que te quede bien la ropa'],
    ['Perder 1,5 kilos al mes', 'perder 1,5 kilos al mes'],
  ])('goalPhrase(«%s») → «%s»', (goal, phrase) => {
    expect(goalPhrase(goal)).toBe(phrase);
  });

  it.each(['Tengo 20 kilos de más', 'Estoy fatal, no me veo bien', 'Sí'])('goalPhrase(«%s») → no se cita', (goal) => {
    expect(goalPhrase(goal)).toBeNull();
  });

  it('los tres seguimientos sin IA son gramaticales con el objetivo guardado como respuesta completa', async () => {
    const lead = makeLead({ name: 'Sergio', goalSummary: 'quiero perder unos 10 kilos, sobre todo la barriga' });
    const history = [outbound('¿Qué te gustaría conseguir exactamente?'), inbound('quiero perder unos 10 kilos, sobre todo la barriga'), outbound('¿Te encaja la llamada?'), inbound('Prefiero no hacer ninguna llamada')];
    const texts: string[] = [];
    for (const step of [1, 2, 3]) {
      texts.push(
        await say({
          leadCtx: makeLeadContext({ lead }),
          convCtx: conv(history, []),
          state: { callDeclinedAt: NOW.toISOString() },
          directive: { kind: 'continue_without_call', instruction: '' },
          mode: 'follow_up',
          followUp: { step, totalSteps: 3, angle: 'Retomar', hoursSilent: 30 },
        }),
      );
    }
    for (const t of texts) {
      expect(t).not.toMatch(/de quiero|lo de quiero|sobre todo la barriga/);
    }
    expect(texts[0]).toMatch(/lo que me contaste de perder unos 10 kilos/);
    expect(texts[2]).toMatch(/lo de perder unos 10 kilos/);
  });

  it('primer contacto con el objetivo del formulario: «Vi que quieres perder…»', async () => {
    const lead = makeLead({ name: 'Sergio', goalSummary: 'Quiero perder peso, unos 8 kilos' });
    const text = await say({ leadCtx: makeLeadContext({ lead }), convCtx: { ...conv([], []), kaiHasSpoken: false }, directive: { kind: 'first_contact', instruction: '' }, mode: 'first_contact' });
    expect(text).toMatch(/Vi que quieres perder peso/);
    expect(text).not.toMatch(/quieres quiero/);
  });
});
