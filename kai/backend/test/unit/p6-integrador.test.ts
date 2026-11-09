/**
 * p6-integrador (pendientes entre grupos y fallos vistos al simular conversaciones completas sin IA):
 *  - lead de otro país que dice «a las 11» y en cada zona es un horario distinto: el motor de reglas le pregunta
 *    directamente «¿las 11:00 de España o las 11:00 de México?» (no «¡Genial! ¿Te va mejor A o B?»);
 *  - si la hora que pide no se le ofreció, se le pregunta de qué país es (sin cifras) y con «la mía» se buscan huecos
 *    cerca de esa hora (el motor pasa el historial con el mensaje que se analiza al final);
 *  - con horarios ofrecidos, pedir otra hora («a las 11 me va bien», «¿no tienes nada más tarde?») busca en la agenda;
 *  - límites de hora: «después de las 9 no puedo» es de la noche y «a partir de las 18» acota desde esa hora;
 *  - «Al final no voy a poder, tengo que cancelar la llamada» la cancela (no la mueve);
 *  - tras cerrar una objeción sin insistir, un «Vale» no recibe otra pregunta;
 *  - respuestas del motor de reglas: «Gracias» → «Gracias a ti», sin repetir el nombre de la llamada, y «¿no tienes
 *    nada más tarde?» no recibe «eso te lo concreta el entrenador».
 * Sin base de datos.
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { RuleBasedSetterAgent } from '../../src/ai/setter/agents.js';
import { decideDirective, type Directive, type SetterState } from '../../src/ai/setter/strategy.js';
import { validateReply } from '../../src/ai/validation/output-validator.js';
import type { MessageRow } from '../../src/ai/context/context.js';
import type { LeadRow } from '../../src/ai/context/context.js';
import { questionCount } from '../../src/lib/domain.js';
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
  makeValidationContext,
  NOW,
  offeredAt,
} from './factories.js';

const MEXICAN = '5215512345678';
const kai = (content: string, directive: string) => makeMessage({ direction: 'outbound', content, metadata: { directive } });
const PROPOSAL = kai('Por lo que me cuentas, creo que tendría sentido verlo en una llamada de valoración de 30 minutos con Álex. ¿Te encaja?', 'propose_call');
const PROPOSED: SetterState = { callProposedAt: '2026-10-05T09:00:00.000Z' };

interface Turn {
  history?: MessageRow[];
  state?: SetterState;
  lead?: LeadRow;
  /** Inicio de la llamada que ya tiene. */
  appt?: Date;
  /** Redactar también la respuesta con el motor de reglas. */
  write?: boolean;
  /** Directiva fija (sin pasar por la estrategia). */
  directive?: Directive;
}

/** Como el motor: el historial que recibe el análisis ya trae al final el mensaje que se analiza. */
async function turn(said: string, t: Turn = {}): Promise<{ analysis: ReturnType<typeof analyzeHeuristically>; directive: Directive; text: string }> {
  const msg = inbound(said);
  const history = [...(t.history ?? []), msg];
  const state = t.state ?? {};
  const lead = t.lead ?? makeLead({ name: 'Pedro' });
  const biz = makeBusinessContext();
  const leadCtx = makeLeadContext({ lead, upcomingAppointment: t.appt ? makeAppointment({ startsAt: t.appt }) : null });
  const analysis = analyzeHeuristically(makeAnalysisInput(said, { history, state, lead, now: NOW }));
  const directive = t.directive ?? decideDirective({ biz, leadCtx, state, analysis, kaiHasSpoken: true, now: NOW });
  // Reservar, cancelar u ofrecer necesitan la agenda (se prueban de extremo a extremo): aquí basta con la directiva.
  if (!t.write || ['book_slot', 'offer_slots', 'reschedule', 'cancel_booking'].includes(directive.kind)) return { analysis, directive, text: '' };
  const out = await new RuleBasedSetterAgent().respond({
    biz,
    leadCtx,
    convCtx: { conversation: makeConversation(), history, pendingInbound: [msg], kaiHasSpoken: true },
    state,
    directive,
    now: NOW,
    feedback: [],
    toolbox: null,
    mode: 'reply',
  });
  return { analysis, directive, text: out.text };
}

describe('p6-integrador · lead de otro país: «a las 11» puede ser dos horarios', () => {
  const AT_11 = offeredAt('2026-10-06T11:00'); // 11:00 en España (03:00 en México)
  const AT_19 = offeredAt('2026-10-06T19:00'); // 19:00 en España (11:00 en México)
  const state: SetterState = { ...PROPOSED, offeredSlots: [AT_11, AT_19], lastOfferIds: [AT_11.id, AT_19.id], offeredAt: NOW.toISOString() };
  const lead = makeLead({ name: 'Pedro', whatsappId: MEXICAN });
  const offerMsg = kai('Tengo mañana a las 11:00 (hora de España; en México, a las 03:00) o mañana a las 19:00 (hora de España; en México, a las 11:00). ¿Cuál te viene mejor?', 'offer_slots');
  const ctx = { state, lead, write: true };

  it('le pregunta solo por la zona, con el nombre de cada país, sin «¡Genial!», y pasa el control de calidad', async () => {
    const { directive, text } = await turn('A las 11 me va bien', { ...ctx, history: [offerMsg] });
    expect(directive.kind).toBe('clarify_slot');
    expect(directive.ambiguousTime).toBe('11:00');
    expect(text).toMatch(/las 11:00 de España o (?:a |de )?las 11:00 de México\?$/);
    expect(text).not.toMatch(/genial|perfecto/i);
    expect(questionCount(text)).toBe(1);
    const check = validateReply(text, makeValidationContext({ allowedTimes: [new Date(AT_11.start), new Date(AT_19.start)], now: NOW }));
    expect(check.issues).toEqual([]);
  });

  it('si vuelve a decir «a las 11» sin aclararlo, se le pregunta con otras palabras (no el mismo mensaje)', async () => {
    const first = await turn('A las 11 me va bien', { ...ctx, history: [offerMsg] });
    const second = await turn('Pues a las 11', { ...ctx, history: [offerMsg, inbound('A las 11 me va bien'), kai(first.text, 'clarify_slot')] });
    expect(second.directive.kind).toBe('clarify_slot');
    expect(second.text).toMatch(/las 11:00 de España o (?:a |de )?las 11:00 de México\?$/);
    expect(second.text).not.toBe(first.text);
  });

  it('su respuesta («la mía», «las de España») reserva el horario de esa zona, también con el mensaje al final del historial', async () => {
    const first = await turn('A las 11 me va bien', { ...ctx, history: [offerMsg] });
    const history = [offerMsg, inbound('A las 11 me va bien'), kai(first.text, 'clarify_slot')];
    const mine = await turn('La mía', { ...ctx, history });
    expect(mine.directive.kind).toBe('book_slot');
    expect(mine.directive.slotId).toBe(AT_19.id);
    expect((await turn('Las de España', { ...ctx, history })).directive.slotId).toBe(AT_11.id);
  });
});

describe('p6-integrador · lead de otro país que pide una hora que no se le ofreció', () => {
  const A = offeredAt('2026-10-05T22:30'); // 14:30 en México
  const B = offeredAt('2026-10-06T00:00'); // 16:00 en México
  const state: SetterState = { ...PROPOSED, offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: NOW.toISOString() };
  const lead = makeLead({ name: 'Luis', whatsappId: MEXICAN });
  const offerMsg = kai('Tengo hoy a las 22:30 (hora de España; en México, a las 14:30) o mañana a las 00:00 (hora de España; en México, hoy a las 16:00). ¿Cuál te viene mejor?', 'offer_slots');

  it('se le pregunta de qué país es esa hora, sin escribirla en cifras (pasa el control de calidad)', async () => {
    const { directive, text } = await turn('A las 11 me va bien', { history: [offerMsg], state, lead, write: true });
    expect(directive.kind).toBe('clarify_slot');
    expect(directive.askZoneOnly).toBe(true);
    expect(text).toMatch(/España/);
    expect(text).toMatch(/México/);
    expect(text).not.toMatch(/\d/);
    expect(questionCount(text)).toBe(1);
    expect(validateReply(text, makeValidationContext({ allowedTimes: [new Date(A.start), new Date(B.start)], now: NOW })).issues).toEqual([]);
  });

  it('con «la mía» (o «las 11 de México») se buscan huecos cerca de las 11:00 de México (19:00 en España)', async () => {
    const ask = kai('Para buscarte hueco a esa hora, ¿me la dices en hora de España o en hora de México?', 'clarify_slot');
    const history = [offerMsg, inbound('A las 11 me va bien'), ask];
    for (const said of ['La mía', 'La de México']) {
      const { analysis, directive } = await turn(said, { history, state, lead });
      expect(analysis.timeInBusinessZone, said).toBe(true);
      expect(directive.kind, said).toBe('offer_slots');
      expect(directive.slotQuery?.time, said).toBe('19:00');
    }
    const spain = await turn('La de España', { history, state, lead });
    expect(spain.directive.slotQuery?.time).toBe('11:00');
    const direct = await turn('Las 11 de México', { history: [offerMsg], state, lead });
    expect(direct.directive.kind).toBe('offer_slots');
    expect(direct.directive.slotQuery?.time).toBe('19:00');
  });
});

describe('p6-integrador · con horarios ofrecidos, pedir otra hora busca en la agenda', () => {
  const A = offeredAt('2026-10-06T18:00');
  const B = offeredAt('2026-10-07T18:00');
  const state: SetterState = { ...PROPOSED, offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: NOW.toISOString() };
  const offerMsg = kai('Perfecto. Tengo mañana a las 18:00 o el miércoles 7 a las 18:00. ¿Cuál te viene mejor?', 'offer_slots');

  it('«A las 11 me va bien» o «¿Puede ser a las 17?» (no ofrecidas) → huecos cerca de esa hora, no otra pregunta', async () => {
    for (const [said, time] of [
      ['A las 11 me va bien', '11:00'],
      ['¿Puede ser a las 17?', '17:00'],
    ] as const) {
      const { directive } = await turn(said, { history: [offerMsg], state });
      expect(directive.kind, said).toBe('offer_slots');
      expect(directive.slotQuery?.time, said).toBe(time);
    }
  });

  it('pedir la hora que tienen todas las ofrecidas solo pide elegir entre ellas', async () => {
    const { directive } = await turn('Mejor a las 18', { history: [offerMsg], state });
    expect(directive.kind).toBe('clarify_slot');
  });

  it('«¿No tienes nada más tarde?» busca después de las ofrecidas; «¿algo más temprano?», antes', async () => {
    const later = await turn('¿No tienes nada más tarde?', { history: [offerMsg], state });
    expect(later.directive.kind).toBe('offer_slots');
    expect(later.directive.slotQuery?.excludeTimes).toEqual(['<18:01']);
    const earlier = await turn('¿Algo más temprano?', { history: [offerMsg], state });
    expect(earlier.directive.kind).toBe('offer_slots');
    expect(earlier.directive.slotQuery?.excludeTimes).toEqual(['>17:59']);
  });

  it('«Te digo algo más tarde» no es pedir otra hora', async () => {
    const { analysis, directive } = await turn('Te digo algo más tarde', { history: [offerMsg], state });
    expect(analysis.rejectedTimes).toEqual([]);
    expect(directive.kind).not.toBe('offer_slots');
  });
});

describe('p6-integrador · límites de hora para la llamada', () => {
  const analyze = async (said: string) => (await turn(said, { history: [PROPOSAL], state: PROPOSED })).analysis;

  it('«después de las 9 no puedo» sin franja es de la noche (a las 9 de la mañana descartaría el día entero)', async () => {
    expect((await analyze('Después de las 9 no puedo')).rejectedTimes).toEqual(['>21:00']);
    expect((await analyze('No puedo después de las 10')).rejectedTimes).toEqual(['>22:00']);
    expect((await analyze('Después de las 11 de la mañana no puedo')).rejectedTimes).toEqual(['>11:00']);
    expect((await analyze('Después de las 20 no me va bien')).rejectedTimes).toEqual(['>20:00']);
  });

  it('«a partir de las 18» acepta la llamada y acota desde cuándo: se buscan huecos desde esa hora', async () => {
    for (const [said, bound] of [
      ['Sí, a partir de las 18', '<18:00'],
      ['A partir de las 7 de la tarde', '<19:00'],
      ['Vale, desde las 18:30 me va bien', '<18:30'],
    ] as const) {
      const { analysis, directive } = await turn(said, { history: [PROPOSAL], state: PROPOSED });
      expect(analysis.flags.wantsCall, said).toBe(true);
      expect(analysis.rejectedTimes, said).toEqual([bound]);
      expect(directive.kind, said).toBe('offer_slots');
      expect(directive.slotQuery?.excludeTimes, said).toEqual([bound]);
      expect(directive.slotQuery?.time, said).toBe(bound.slice(1));
    }
  });

  it('no acota la llamada si habla de otra cosa o da un rango («desde las 9 hasta las 14»)', async () => {
    expect((await analyze('Entreno a partir de las 18')).rejectedTimes).toEqual([]);
    expect((await analyze('Trabajo desde las 9 hasta las 14')).rejectedTimes).toEqual([]);
  });
});

describe('p6-integrador · cancelar con la llamada agendada', () => {
  const BOOKED = kai('¡Hecho! Te apunto para el jueves 8 a las 14:00. Si te surge algo, me lo dices por aquí y la movemos.', 'book_slot');
  const appt = local('2026-10-08T14:00');

  it('«Al final no voy a poder, tengo que cancelar la llamada» la cancela (no le ofrece moverla)', async () => {
    for (const said of ['Al final no voy a poder, tengo que cancelar la llamada', 'No voy a poder, cancela la llamada', 'Me ha surgido un imprevisto, cancela la llamada por favor']) {
      const { analysis, directive } = await turn(said, { history: [BOOKED], appt });
      expect(analysis.flags.wantsReschedule, said).toBe(false);
      expect(directive.kind, said).toBe('cancel_booking');
    }
  });

  it('si además pide otro día, se mueve; y «al final no voy a poder» solo, también', async () => {
    for (const said of ['No voy a poder, cancélala y la pasamos al viernes', 'Al final no puedo, cancélala y dame otro día', 'Al final no voy a poder']) {
      expect((await turn(said, { history: [BOOKED], appt })).directive.kind, said).toBe('reschedule');
    }
  });
});

describe('p6-integrador · respuestas sin insistir', () => {
  it('tras cerrar una objeción por tercera vez, un «Vale» no recibe otra pregunta', async () => {
    const closing = kai('Lo entiendo, y no quiero insistir. Si en algún momento quieres retomarlo, aquí me tienes.', 'handle_objection');
    const state: SetterState = { ...PROPOSED, callDeclinedAt: NOW.toISOString(), objectionsHandled: ['price', 'price', 'price'] };
    for (const said of ['Vale', 'Ok, gracias']) {
      const { directive, text } = await turn(said, { history: [closing], state, write: true });
      expect(directive.kind, said).toBe('continue_without_call');
      expect(questionCount(text), `${said} → ${text}`).toBe(0);
    }
    // Si cuenta algo nuevo, o vuelve a escribir días después, la conversación sigue con normalidad.
    expect((await turn('Quiero perder 10 kilos', { history: [closing], state })).directive.kind).toBe('ask_qualification');
    const daysLater: SetterState = { ...state, callDeclinedAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() };
    expect((await turn('Hola', { history: [closing], state: daysLater })).directive.kind).toBe('ask_qualification');
  });

  it('a un «Gracias» sin llamada se le contesta «Gracias a ti» (o «A ti»), no «Vale.»', async () => {
    const cancelled = kai('Hecho, he cancelado la llamada de valoración. Si más adelante quieres retomarlo, escríbeme por aquí sin problema.', 'cancel_booking');
    // Ya cualificado y sin llamada: la estrategia da continue_without_call (seguir por aquí).
    const { text } = await turn('Gracias', { history: [cancelled], write: true, directive: { kind: 'continue_without_call', instruction: '' } });
    expect(text).toMatch(/^(?:Gracias a ti|A ti)\b/);
  });

  it('con la llamada agendada, «¿Cuánto dura la llamada?» no repite el nombre de la llamada', async () => {
    const booked = kai('¡Hecho! Te apunto para mañana a las 18:30. Si te surge algo, me lo dices por aquí y la movemos.', 'book_slot');
    const { text } = await turn('¿Cuánto dura la llamada?', { history: [booked], appt: local('2026-10-06T18:30'), write: true });
    expect(text).toMatch(/dura 30 minutos/);
    expect(text.match(/llamada de valoración/gi) ?? []).toHaveLength(1);
  });

  it('«¿No tienes nada más tarde?» sin horarios ofrecidos no recibe «eso te lo concreta Álex»', async () => {
    const asked = kai('Vale, gracias por contármelo. ¿Qué has probado hasta ahora?', 'ask_qualification');
    const { text } = await turn('¿No tienes nada más tarde?', { history: [asked], write: true });
    expect(text).not.toMatch(/prefiero no decirte nada inexacto|te lo puede concretar/);
  });
});
