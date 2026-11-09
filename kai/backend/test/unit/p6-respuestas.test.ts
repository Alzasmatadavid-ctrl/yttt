/**
 * p6-respuestas (revisión de regresiones de la ronda 3, motor de reglas y control de calidad):
 *  - answerTo: las aclaraciones, «¿con quién hablo?» o «¿cómo te llamas?» no reciben «eso te lo concreta el
 *    entrenador»; con la llamada agendada, las preguntas de día u hora tampoco; si repite la pregunta, la respuesta
 *    se le recuerda con otras palabras (no la misma con un «Vale.» delante);
 *  - la misma objeción por tercera vez: el cierre va con la marca de la estrategia y después no se le vende la llamada;
 *  - el validador no rechaza los años que contó el lead, «ni un euro» ni «No te prometo…»;
 *  - el objetivo citado en el primer mensaje y en los seguimientos va entero en segunda persona.
 * Sin base de datos.
 */
import { describe, expect, it } from 'vitest';
import { goalPhrase, RuleBasedSetterAgent, type AgentTurnInput } from '../../src/ai/setter/agents.js';
import { decideDirective, type Directive, type SetterState } from '../../src/ai/setter/strategy.js';
import { validateReply, type ValidationContext } from '../../src/ai/validation/output-validator.js';
import type { MessageRow } from '../../src/ai/context/context.js';
import { normalize } from '../../src/lib/text.js';
import { questionCount } from '../../src/lib/domain.js';
import {
  inbound,
  makeAnalysis,
  makeAppointment,
  makeBusinessContext,
  makeConversation,
  makeLead,
  makeLeadContext,
  makeObjections,
  makeSettings,
  makeValidationContext,
  NOW,
  outbound,
  qualificationOf,
} from './factories.js';

const ASK_GOAL: Directive = { kind: 'ask_qualification', instruction: '', questionKey: 'goal', question: '¿Qué te gustaría conseguir?' };

function conv(history: MessageRow[], pending: MessageRow[]) {
  return { conversation: makeConversation(), history, pendingInbound: pending, kaiHasSpoken: true };
}

interface Turn {
  directive?: Directive;
  booked?: boolean;
  meetingUrl?: string;
  settings?: Parameters<typeof makeSettings>[0];
  extra?: Partial<AgentTurnInput>;
}

/** El lead escribe varios mensajes seguidos y KAI (motor de reglas) responde a cada uno con la misma directiva. */
async function talk(leadSays: string[], t: Turn = {}, start: MessageRow[] = [outbound('Hola, ¿qué tal?')]) {
  const history = [...start];
  const replies: string[] = [];
  for (const said of leadSays) {
    const msg = inbound(said);
    history.push(msg);
    const out = await new RuleBasedSetterAgent().respond({
      biz: makeBusinessContext({ settings: makeSettings(t.settings) }),
      leadCtx: makeLeadContext({
        lead: makeLead({ name: 'Pedro' }),
        upcomingAppointment: t.booked ? makeAppointment(t.meetingUrl ? { meetingUrl: t.meetingUrl } : {}) : null,
      }),
      convCtx: conv(history, [msg]),
      state: {},
      directive: t.directive ?? { kind: 'post_booking', instruction: '' },
      now: NOW,
      feedback: [],
      toolbox: null,
      mode: 'reply',
      ...t.extra,
    });
    replies.push(out.text);
    history.push(outbound(out.text));
  }
  return replies;
}

const UNSURE = /prefiero no decirte nada inexacto|te lo puede concretar|te los concreta/;

describe('p6-respuestas · answerTo: aclaraciones y quién le escribe', () => {
  it('«Hola, ¿con quién hablo?» en el primer mensaje: se presenta una sola vez y sin «eso te lo concreta Álex»', async () => {
    const [text] = await talk(['Hola, ¿con quién hablo?'], { directive: { kind: 'greet_and_ask', instruction: '' }, extra: { firstMessage: true } }, []);
    expect(text).toMatch(/Soy KAI, el asistente virtual del equipo de Álex/);
    expect(text.match(/asistente virtual/g)).toHaveLength(1);
    expect(text).not.toMatch(UNSURE);
  });

  it('si el entrenador solo se presenta cuando se lo preguntan, a «¿con quién hablo?» sí se presenta', async () => {
    const [first] = await talk(['Hola, ¿con quién hablo?'], { directive: { kind: 'greet_and_ask', instruction: '' }, settings: { disclosureMode: 'on_request' }, extra: { firstMessage: true } }, []);
    expect(first).toMatch(/Soy KAI, el asistente virtual del equipo de Álex/);
    const [later] = await talk(['¿Quién eres?'], { directive: ASK_GOAL, settings: { disclosureMode: 'on_request', persona: 'trainer' } });
    expect(later).toMatch(/^Te escribe KAI, el asistente virtual de Álex\. ¿Qué te gustaría conseguir\?$/);
  });

  it.each(['¿Cómo te llamas?', '¿Eres Álex?', '¿Eres el entrenador?'])('«%s» → se presenta (no «los detalles de la llamada…»)', async (q) => {
    const [text] = await talk([q], { directive: ASK_GOAL });
    expect(text).toMatch(/^Soy KAI, el asistente virtual del equipo de Álex\./);
    expect(text).not.toMatch(UNSURE);
  });

  it.each(['¿A qué te refieres?', '¿Me puedes repetir la pregunta?', '¿Me lo explicas mejor?', '¿Qué significa eso?', '¿Hay alguien ahí?'])(
    '«%s» → se le vuelve a plantear la pregunta, sin «eso te lo concreta Álex»',
    async (q) => {
      const [text] = await talk([q], { directive: ASK_GOAL });
      expect(text).not.toMatch(UNSURE);
      expect(text).toMatch(/¿Qué te gustaría conseguir\?$/);
    },
  );

  it('si además pregunta si es un bot, la presentación no se duplica', async () => {
    const [text] = await talk(['¿Quién eres? ¿Eres un bot?'], { directive: ASK_GOAL, extra: { extraNote: 'El lead pregunta si eres un bot' } });
    expect(text.match(/soy KAI/gi)).toHaveLength(1);
  });

  it('«¿Es online?» (corta) se responde con la modalidad, y «¿con quién es la llamada?», con el entrenador', async () => {
    const [online] = await talk(['¿Es online?'], { directive: { kind: 'propose_call', instruction: '' } });
    expect(online).toMatch(/^Es online\./);
    const [who] = await talk(['¿Con quién es la llamada?'], { directive: { kind: 'reassure_call', instruction: '' } });
    expect(who).toMatch(/^La llamada de valoración es con Álex\./);
  });
});

describe('p6-respuestas · answerTo con la llamada agendada', () => {
  it.each(['¿La llamada es a las 18:00?', '¿La llamada es el miércoles?', '¿Era mañana, no?', '¿Es a las 18:00?'])('«%s» → solo el recordatorio de la cita (sin «prefiero no decirte nada inexacto»)', async (q) => {
    const [text] = await talk([q], { booked: true });
    expect(text).not.toMatch(UNSURE);
    expect(text).toMatch(/pasado mañana a las 18:00/);
  });

  it('con enlace de videollamada, «¿Me llamáis vosotros o llamo yo?» se responde con el enlace', async () => {
    const url = 'https://meet.google.com/abc-defg-hij';
    const [text] = await talk(['¿Me llamáis vosotros o llamo yo?'], { booked: true, meetingUrl: url });
    expect(text).toContain(`videollamada; te conectas a la hora acordada desde este enlace: ${url}`);
    expect(text).not.toMatch(UNSURE);
  });

  it('si repite la misma pregunta, la respuesta se le recuerda con otras palabras (no la misma con «Vale.» delante)', async () => {
    const replies = await talk(['¿Me llamáis vosotros o llamo yo?', '¿Me llamáis vosotros o llamo yo?', '¿Me llamáis vosotros o llamo yo?'], { booked: true });
    expect(replies[0]).toMatch(/^Los detalles de la llamada de valoración te los concreta Álex; prefiero no decirte nada inexacto\./);
    expect(replies[1]).toMatch(/^Como te decía, los detalles de la llamada de valoración te los concreta Álex\./);
    expect(replies[2]).toMatch(/^Siento no poder concretártelo yo: los detalles de la llamada de valoración te los concreta Álex\./);
    for (const r of replies) expect(r).not.toMatch(/^(?:Vale|De acuerdo|Entendido)\./);
  });

  it('lo mismo con una respuesta con dato y con una con enlace', async () => {
    const online = await talk(['¿Es online?', '¿Es online?', '¿Es online?'], { directive: { kind: 'reassure_call', instruction: '' } });
    expect(online.map((r) => r.split(/(?<=\.) /)[0])).toEqual(['Es online.', 'Es online, como te decía.', 'Es online; te lo confirmo de nuevo.']);
    const url = 'https://meet.google.com/abc-defg-hij';
    const link = await talk(['¿Me llamáis o llamo yo?', '¿Es por zoom?'], { booked: true, meetingUrl: url });
    expect(link[1]).toMatch(/^Como te decía, la llamada de valoración es por videollamada; te conectas a la hora acordada desde este enlace: https:\/\/meet\.google\.com\/abc-defg-hij /);
  });
});

describe('p6-respuestas · la misma objeción por tercera vez', () => {
  const biz = makeBusinessContext();
  const lead = makeLead({ score: 70, qualification: qualificationOf({ goal: 'perder 12 kilos', problem: 'no tengo tiempo', motivation: 'mi salud' }) });
  const decide = (state: SetterState, analysis = makeAnalysis()) => decideDirective({ biz, leadCtx: makeLeadContext({ lead }), state, analysis, kaiHasSpoken: true, now: NOW });

  it('la estrategia marca el cierre y el motor de reglas responde sin pregunta (aunque la cuenta sea otra)', async () => {
    const d = decide({ callProposedAt: NOW.toISOString(), objectionsHandled: ['expensive', 'expensive'] }, makeAnalysis({ objectionKey: 'expensive' }));
    expect(d).toMatchObject({ kind: 'handle_objection', closesObjection: true });
    const objection = makeObjections().find((o) => o.key === 'expensive')!;
    const [text] = await talk(['Sigue siendo caro'], { directive: { kind: 'handle_objection', instruction: '', objection, closesObjection: true } });
    expect(questionCount(text)).toBe(0);
    expect(text).toMatch(/insistir|respeto/);
  });

  it('tras el cierre (el motor guarda callDeclinedAt), un «Vale» no vuelve a vender la llamada', () => {
    const d = decide({ callProposedAt: NOW.toISOString(), callDeclinedAt: NOW.toISOString(), objectionsHandled: ['expensive', 'expensive', 'expensive'] }, makeAnalysis());
    expect(['reassure_call', 'propose_call', 'offer_slots']).not.toContain(d.kind);
  });
});

describe('p6-respuestas · validador: falsos positivos', () => {
  const ctx = (leadText: string): ValidationContext => makeValidationContext({ factsText: 'Graduado en CAFYD.', allowedPricesCents: [14900], currencies: ['EUR'], leadText });
  const ok = (text: string, c: ValidationContext) => expect(validateReply(text, c), text).toEqual({ ok: true, issues: [] });
  const issue = (text: string, rx: RegExp, c: ValidationContext) => expect(validateReply(text, c).issues.some((i) => rx.test(i)), text).toBe(true);

  it('repetir los años que contó el lead no es un dato inventado del entrenador', () => {
    ok('Después de 3 años entrenando por tu cuenta, es normal estancarse. ¿Qué rutina sigues?', ctx('Llevo 3 años entrenando por mi cuenta y no veo cambios'));
    ok('Con 20 años trabajando en una oficina, es normal que te cueste moverte. ¿Cuántos días podrías entrenar?', ctx('Trabajo en una oficina desde hace 20 años'));
  });

  it('pero sigue rechazando los años del entrenador aunque el lead diga la misma cifra', () => {
    issue('Álex lleva 20 años trabajando con hombres como tú.', /perfil del entrenador/, ctx('Trabajo en una oficina desde hace 20 años'));
    issue('Tengo 3 años entrenando a gente como tú.', /perfil del entrenador/, ctx('Llevo 3 años entrenando por mi cuenta'));
    issue('Llevo 15 años ayudando a hombres como tú.', /perfil del entrenador/, ctx('Llevo 15 años sin entrenar'));
    issue('Con 15 años de experiencia, Álex sabe lo que funciona.', /perfil del entrenador/, ctx('Llevo 15 años sin entrenar'));
  });

  it('«ni un euro» no es un importe; «quince euros» sí', () => {
    ok('La llamada no te cuesta ni un euro. ¿Te encaja?', ctx(''));
    issue('Son quince euros al mes.', /no coincide con ningún precio/, ctx(''));
  });

  it('«No te prometo…» y «Te lo prometo: no te voy a llenar de mensajes» no son promesas de resultados', () => {
    ok('No te prometo resultados mágicos, pero sí un plan que se adapte a ti. ¿Te encaja?', ctx(''));
    ok('Te lo prometo: no te voy a llenar de mensajes.', ctx(''));
    issue('Te prometo que vas a perder la barriga.', /garantiza resultados/, ctx(''));
    issue('Lo conseguirás, te lo prometo.', /garantiza resultados/, ctx(''));
    issue('Te prometo resultados en un mes.', /garantiza resultados/, ctx(''));
  });
});

describe('p6-respuestas · el objetivo citado va entero en segunda persona', () => {
  it.each([
    ['Quiero estar fuerte para jugar con mis hijos sin cansarme', 'estar fuerte para jugar con tus hijos sin cansarte'],
    ['Quiero sentirme bien conmigo mismo y verme mejor', 'sentirte bien contigo mismo y verte mejor'],
    ['Quiero perder la barriga que tengo', 'perder la barriga que tienes'],
    ['Quiero ponerme en forma para no ahogarme al subir escaleras', 'ponerte en forma para no ahogarte al subir escaleras'],
    ['Quiero irme de vacaciones sin complejos', 'irte de vacaciones sin complejos'],
    ['Quiero mantenerme firme con la dieta', 'mantenerte firme con la dieta'],
    ['Volver a ser el que era', 'volver a ser el que eras'],
    ['Quiero que baje la barriga', 'que baje la barriga'],
  ])('goalPhrase(«%s») → «%s»', (goal, phrase) => {
    expect(goalPhrase(goal)).toBe(phrase);
  });

  it.each(['Quiero perder el peso que gané en la pandemia', 'Bajar a 80 kilos porque peso 100', 'He engordado 10 kilos este año'])('goalPhrase(«%s») → no se cita (quedaría en primera persona)', (goal) => {
    expect(goalPhrase(goal)).toBeNull();
  });

  it('primer contacto: «Vi que quieres … sin cansarte», sin mezclar personas', async () => {
    const out = await new RuleBasedSetterAgent().respond({
      biz: makeBusinessContext(),
      leadCtx: makeLeadContext({ lead: makeLead({ name: 'Pedro', goalSummary: 'Quiero estar fuerte para jugar con mis hijos sin cansarme' }) }),
      convCtx: { conversation: makeConversation(), history: [], pendingInbound: [], kaiHasSpoken: false },
      state: {},
      directive: { kind: 'first_contact', instruction: '' },
      now: NOW,
      feedback: [],
      toolbox: null,
      mode: 'first_contact',
    });
    expect(out.text).toContain('Vi que quieres estar fuerte para jugar con tus hijos sin cansarte');
    expect(normalize(out.text)).not.toMatch(/\b(?:mis|cansarme)\b/);
  });
});
