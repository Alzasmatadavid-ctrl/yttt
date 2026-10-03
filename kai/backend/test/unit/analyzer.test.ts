import { describe, expect, it } from 'vitest';
import { analyzeHeuristically, matchOfferedSlot, resolvePartOfDay, resolvePreferredDate } from '../../src/ai/analysis/analyzer.js';
import { normalize } from '../../src/lib/text.js';
import { MADRID, MEXICO, NOW, makeAnalysisInput, makeLead, offeredAt, outbound, qualificationOf } from './factories.js';

const analyze = (...args: Parameters<typeof makeAnalysisInput>) => analyzeHeuristically(makeAnalysisInput(...args));

describe('analyzeHeuristically: alertas', () => {
  it.each(['STOP', 'baja', 'Basta!', 'No me escribas más, por favor', 'Dame de baja', 'Dejad de escribirme'])('detecta la baja: %j', (text) => {
    expect(analyze(text).flags.optOut).toBe(true);
  });

  it('no confunde “baja” dentro de una frase normal con una baja', () => {
    expect(analyze('Quiero bajar de peso').flags.optOut).toBe(false);
  });

  it.each(['Quiero hablar con una persona', '¿Puedo hablar con el entrenador?', 'Prefiero que me atienda una persona real'])('detecta petición de humano: %j', (text) => {
    expect(analyze(text).flags.humanRequest).toBe(true);
  });

  it.each(['¿Eres un bot?', '¿Hablo con una IA?', 'Oye, ¿esto es automático?', '¿eres un robot?'])('detecta si pregunta si es un bot: %j', (text) => {
    expect(analyze(text).flags.asksIfBot).toBe(true);
  });

  it.each(['Tengo diabetes tipo 2', 'Me pongo insulina cada día', 'Me operaron de la rodilla y tengo una lesión', 'Estoy embarazada de 3 meses', 'Tomo medicación para la tiroides'])(
    'detecta tema médico: %j',
    (text) => {
      expect(analyze(text).flags.medical).toBe(true);
    },
  );

  it.each(['¿Cuánto cuesta?', '¿Qué precio tiene?', 'cuanto vale el programa', '¿Cuál es la tarifa?'])('detecta pregunta de precio: %j', (text) => {
    expect(analyze(text).flags.asksPrice).toBe(true);
  });

  it('un mensaje neutro no activa alertas', () => {
    const { flags } = analyze('Quiero perder 10 kilos para el verano');
    expect(flags.optOut || flags.humanRequest || flags.asksIfBot || flags.medical || flags.asksPrice || flags.angry).toBe(false);
  });

  it('detecta enfado y lo refleja en el sentimiento', () => {
    const a = analyze('Esto es una estafa, sois unos pesados');
    expect(a.flags.angry).toBe(true);
    expect(a.signals.sentiment).toBe('angry');
  });

  it('detecta negociación, reprogramación, cancelación y problemas técnicos', () => {
    expect(analyze('¿Me haces un descuento?').flags.complexNegotiation).toBe(true);
    expect(analyze('¿Podemos cambiar la llamada al jueves?').flags.wantsReschedule).toBe(true);
    expect(analyze('Quiero cancelar la cita').flags.wantsCancel).toBe(true);
    expect(analyze('No me funciona el enlace').flags.technicalIssue).toBe(true);
  });

  it('une varios mensajes pendientes seguidos', () => {
    const a = analyze(['Hola', '¿cuánto cuesta?', 'y ¿eres un bot?']);
    expect(a.flags.asksPrice).toBe(true);
    expect(a.flags.asksIfBot).toBe(true);
  });
});

describe('analyzeHeuristically: cualificación', () => {
  it('captura el objetivo como frase corta (no el mensaje entero)', () => {
    const a = analyze('¡Hola! Me gustaría perder 10 kilos antes del verano, la verdad 😊');
    expect(a.qualification.goal?.value).toBe('perder 10 kilos');
    expect(a.goalSummary).toBe('perder 10 kilos');
    expect(a.signals.fit).toBe('yes');
  });

  it('conserva las tildes del texto original en el objetivo', () => {
    const a = analyze('Lo que más quiero es ganar músculo y fuerza');
    expect(a.qualification.goal?.value).toBe('ganar músculo');
  });

  it('si responde a la pregunta de objetivo, guarda su respuesta completa', () => {
    const a = analyze('Pues bajar barriga y sentirme mejor', { state: { lastAskedKey: 'goal' } });
    expect(a.qualification.goal?.value).toBe('Pues bajar barriga y sentirme mejor');
    expect(a.qualification.goal?.confidence).toBe(0.75);
  });

  it('no sobrescribe un dato que el lead ya dio', () => {
    const lead = makeLead({ qualification: qualificationOf({ goal: 'perder grasa' }) });
    const a = analyze('Pues ya te lo dije antes', { lead, state: { lastAskedKey: 'goal' } });
    expect(a.qualification.goal).toBeUndefined();
  });

  it('una respuesta de una sola palabra no se guarda como dato', () => {
    const a = analyze('Sí', { state: { lastAskedKey: 'problem' } });
    expect(a.qualification.problem).toBeUndefined();
  });

  it('extrae señales de urgencia, compromiso y presupuesto', () => {
    const a = analyze('Quiero empezar cuanto antes, estoy dispuesto a lo que haga falta y puedo invertir en mí');
    expect(a.signals).toMatchObject({ urgency: 'high', commitment: 'high', budget: 'yes' });
    expect(a.qualification.urgency?.level).toBe('high');
    expect(a.qualification.budget?.level).toBe('yes');
  });

  it('detecta que no puede pagar', () => {
    expect(analyze('Ahora mismo no tengo dinero').signals.budget).toBe('no');
  });

  it('un menor de edad no encaja', () => {
    expect(analyze('Tengo 16 años y quiero ganar músculo').signals.fit).toBe('no');
  });

  it('no cambia a “encaja” a un lead ya descartado', () => {
    const lead = makeLead({ signals: { fit: 'no' }, qualification: qualificationOf({ goal: 'perder peso' }) });
    expect(analyze('Quiero perder 5 kilos', { lead }).signals.fit).toBe('no');
  });

  it('solo extrae variables que el negocio tiene activas', () => {
    const input = makeAnalysisInput('Quiero perder 10 kilos para mi boda');
    input.biz.rules = input.biz.rules.filter((r) => r.key !== 'goal');
    const a = analyzeHeuristically(input);
    expect(a.qualification.goal).toBeUndefined();
    expect(a.qualification.motivation?.value).toBe('Quiero perder 10 kilos para mi boda');
  });

  it('extrae el nombre del lead', () => {
    expect(analyze('Hola, me llamo Laura').leadName).toBe('Laura');
    expect(analyze('Buenas! Pues soy Íñigo').leadName).toBe('Íñigo');
    expect(analyze('hola, mi nombre es Ana').leadName).toBe('Ana');
    expect(analyze('hola que tal').leadName).toBeNull();
    expect(analyze('hola, me llamo laura').leadName).toBeNull(); // exige mayúscula para no capturar palabras comunes
  });

  // Regresión: la expresión distinguía mayúsculas también en “me llamo / soy / mi nombre es”, así que la forma más
  // habitual de presentarse, al inicio del mensaje, no se reconocía.
  it('reconoce el nombre al inicio del mensaje (“Me llamo Laura”, “Soy Íñigo”)', () => {
    expect(analyze('Me llamo Laura').leadName).toBe('Laura');
    expect(analyze('Soy Íñigo, encantado').leadName).toBe('Íñigo');
  });

  it('no toma por nombre una palabra en minúscula tras “Soy”', () => {
    expect(analyze('Soy nueva por aquí').leadName).toBeNull();
    expect(analyze('Consoy Pedro').leadName).toBeNull();
  });

  it('guarda recuerdos útiles (eventos, restricciones)', () => {
    const a = analyze('Me caso en junio y quiero llegar bien a la boda. Trabajo a turnos.');
    expect(a.memories.some((m) => m.kind === 'event' && /boda/.test(m.content))).toBe(true);
    expect(a.memories.some((m) => m.kind === 'constraint' && /turnos/.test(m.content))).toBe(true);
  });
});

describe('analyzeHeuristically: objeciones solo en fase de decisión', () => {
  const text = 'La verdad es que no tengo tiempo, trabajo mucho';

  it('mientras describe su situación, “no tengo tiempo” es información (no objeción)', () => {
    const a = analyze(text, { state: { lastAskedKey: 'problem' } });
    expect(a.objectionKey).toBeNull();
    expect(a.qualification.problem?.value).toBe(text);
  });

  it('tras proponer la llamada es una objeción', () => {
    expect(analyze(text, { state: { callProposedAt: NOW.toISOString() } }).objectionKey).toBe('no_time');
  });

  it('tras dar el precio es una objeción', () => {
    expect(analyze('Uf, me parece caro', { state: { priceShared: true } }).objectionKey).toBe('expensive');
  });

  it('tras ofrecer horarios es una objeción', () => {
    const state = { offeredSlots: [offeredAt('2026-10-06T18:00')], lastOfferIds: [] };
    expect(analyze('Me lo tengo que pensar', { state }).objectionKey).toBe('think_about_it');
  });

  it('si no aporta información de cualificación, una objeción clara se detecta igualmente', () => {
    expect(analyze('Me parece caro').objectionKey).toBe('expensive');
  });

  it('las objeciones desactivadas (no cargadas) no se detectan', () => {
    const input = makeAnalysisInput('Me parece caro', { state: { priceShared: true } });
    input.biz.objections = input.biz.objections.filter((o) => o.key !== 'expensive');
    expect(analyzeHeuristically(input).objectionKey).toBeNull();
  });

  // Regresión: los disparadores se buscaban como subcadena y la biblioteca por defecto incluía “solo”:
  // “Sí, pero solo puedo por la tarde” (aceptando la llamada) se clasificaba como objeción “lo quiero probar por mi cuenta”.
  it('“solo puedo por la tarde” no es la objeción “por mi cuenta”', () => {
    const a = analyze('Sí, pero solo puedo por la tarde', { state: { callProposedAt: NOW.toISOString() } });
    expect(a.objectionKey).toBeNull();
  });

  // Regresión: “caro” se detectaba dentro de “Carolina” (ahora se exigen palabras completas).
  it('un disparador no debe coincidir dentro de otra palabra (“Carolina” ≠ “caro”)', () => {
    const a = analyze('Sí, soy Carolina, la hermana de Marta', { state: { priceShared: true } });
    expect(a.objectionKey).toBeNull();
  });

  it('los disparadores siguen detectándose como palabras completas (con o sin tildes)', () => {
    const state = { callProposedAt: NOW.toISOString() };
    expect(analyze('Uf, es muy caro para mí', { state }).objectionKey).toBe('expensive');
    expect(analyze('Prefiero intentarlo por mi cuenta', { state }).objectionKey).toBe('diy');
    expect(analyze('Creo que lo voy a probar yo sola', { state }).objectionKey).toBe('diy');
    expect(analyze('Déjame pensármelo', { state }).objectionKey).toBe('think_about_it');
  });
});

describe('analyzeHeuristically: llamada y horarios', () => {
  it('detecta que quiere agendar una llamada', () => {
    expect(analyze('¿Podemos hacer una llamada?').flags.wantsCall).toBe(true);
  });

  it('un “sí” tras proponer la llamada cuenta como querer la llamada', () => {
    const history = [outbound('¿Te encaja una llamada de 30 minutos con Álex?')];
    expect(analyze('Sí, vale', { history }).flags.wantsCall).toBe(true);
    expect(analyze('Sí, vale', { state: { callProposedAt: NOW.toISOString() } }).flags.wantsCall).toBe(true);
    expect(analyze('Sí, vale').flags.wantsCall).toBe(false);
  });

  it('rechazar la llamada no cuenta como querer la llamada', () => {
    const a = analyze('No quiero una llamada, prefiero por escrito');
    expect(a.flags.declinesCall).toBe(true);
    expect(a.flags.wantsCall).toBe(false);
  });

  it('proponer un día tras ofrecer la llamada cuenta como querer la llamada', () => {
    const a = analyze('El jueves por la tarde', { state: { callProposedAt: NOW.toISOString() } });
    expect(a.flags.wantsCall).toBe(true);
    expect(a.preferredDate).toBe('2026-10-08');
    expect(a.preferredPartOfDay).toBe('afternoon');
  });

  it('identifica el horario elegido de la última oferta', () => {
    const A = offeredAt('2026-10-06T18:00');
    const B = offeredAt('2026-10-06T19:30');
    const state = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id] };
    expect(analyze('La segunda', { state }).selectedSlotId).toBe(B.id);
    expect(analyze('Mejor a las 18:00', { state }).selectedSlotId).toBe(A.id);
    expect(analyze('Me viene bien, gracias', { state }).selectedSlotId).toBeNull();
  });
});

describe('resolvePreferredDate', () => {
  // NOW = lunes 5/10/2026, 12:00 en Madrid.
  const r = (text: string, tz = MADRID, now = NOW) => resolvePreferredDate(normalize(text), now, tz);

  it.each([
    ['mañana', '2026-10-06'],
    ['Mañana por la tarde', '2026-10-06'],
    ['mañana por la mañana', '2026-10-06'],
    ['pasado mañana', '2026-10-07'],
    ['Pasado mañana a primera hora', '2026-10-07'],
    ['el jueves', '2026-10-08'],
    ['el miércoles', '2026-10-07'],
    ['el sábado por la mañana', '2026-10-10'],
    ['el domingo', '2026-10-11'],
    ['hoy', '2026-10-05'],
    ['esta tarde', '2026-10-05'],
    ['esta noche', '2026-10-05'],
  ])('“%s” → %s', (text, expected) => {
    expect(r(text)).toBe(expected);
  });

  it('el mismo día de la semana que hoy apunta a la semana que viene', () => {
    expect(r('el lunes')).toBe('2026-10-12');
  });

  it.each(['por la mañana', 'de la mañana', 'a las 10 de la mañana', 'cuando quieras', 'me da igual'])('“%s” no es una fecha', (text) => {
    expect(r(text)).toBeNull();
  });

  it('resuelve “mañana” en la zona horaria del negocio', () => {
    const lateNight = new Date('2026-10-05T23:30:00.000Z'); // martes 01:30 en Madrid, lunes 17:30 en México
    expect(r('mañana', MADRID, lateNight)).toBe('2026-10-07');
    expect(r('mañana', MEXICO, lateNight)).toBe('2026-10-06');
  });

  // Regresión: “esta tarde” y “esta noche” se resolvían como hoy, pero “esta mañana” se descartaba.
  it('“esta mañana” debería resolverse como hoy (igual que “esta tarde”)', () => {
    expect(r('¿Tienes algo esta mañana?')).toBe('2026-10-05');
  });
});

describe('resolvePartOfDay', () => {
  it.each([
    ['por la mañana', 'morning'],
    ['a primera hora', 'morning'],
    ['mejor de la mañana', 'morning'],
    ['por la tarde', 'afternoon'],
    ['después de comer', 'afternoon'],
    ['mañana por la tarde', 'afternoon'],
    ['por la noche', 'evening'],
    ['después de trabajar', 'evening'],
    ['a última hora', 'evening'],
  ])('“%s” → %s', (text, expected) => {
    expect(resolvePartOfDay(normalize(text))).toBe(expected);
  });

  it('sin franja → null', () => {
    expect(resolvePartOfDay(normalize('el jueves'))).toBeNull();
    expect(resolvePartOfDay(normalize('mañana'))).toBeNull();
  });
});

describe('matchOfferedSlot', () => {
  // Oferta antigua: martes 18:00 y 19:30. Última oferta: miércoles 10:00 y jueves 18:00.
  const A = offeredAt('2026-10-06T18:00', MADRID, 'mañana a las 18:00');
  const B = offeredAt('2026-10-06T19:30', MADRID, 'mañana a las 19:30');
  const C = offeredAt('2026-10-07T10:00', MADRID, 'pasado mañana a las 10:00');
  const D = offeredAt('2026-10-08T18:00', MADRID, 'el jueves 8 a las 18:00');
  const all = [A, B, C, D];
  const latest = [C.id, D.id];
  const m = (text: string, lastOfferIds = latest, offered = all, tz = MADRID) => matchOfferedSlot(normalize(text), offered, tz, NOW, lastOfferIds);

  it('sin horarios ofrecidos no elige nada', () => {
    expect(m('la primera', latest, [])).toBeNull();
  });

  it('“la primera / la segunda / la última” se refieren a la última oferta', () => {
    expect(m('La primera')).toBe(C.id);
    expect(m('la segunda porfa')).toBe(D.id);
    expect(m('la última')).toBe(D.id);
    expect(m('Opción 1')).toBe(C.id);
  });

  it('sin registro de la última oferta usa todos los ofrecidos', () => {
    expect(m('la primera', [])).toBe(A.id);
    expect(m('la segunda', [])).toBe(B.id);
    expect(m('la tercera', [])).toBe(C.id);
  });

  it('“a las 6” se entiende como las 18:00 de la última oferta', () => {
    expect(m('Vale, a las 6')).toBe(D.id);
  });

  it.each([
    ['18:00', D],
    ['a las 10', C],
    ['10', C],
    ['a las 10:00h', C],
  ])('elige por hora: “%s”', (text, expected) => {
    expect(m(text)).toBe(expected.id);
  });

  it('si la hora no está en la última oferta, la busca en ofertas anteriores', () => {
    expect(m('a las 19:30')).toBe(B.id);
    expect(m('a las 7 y media')).toBe(B.id);
  });

  it('si la hora es ambigua (dos ofertas a las 18:00) no elige', () => {
    expect(m('a las 6', [])).toBeNull();
  });

  it('elige por día si solo hay un hueco ofrecido ese día y lo confirma', () => {
    expect(m('El jueves me viene genial')).toBe(D.id);
    expect(m('mejor pasado mañana')).toBe(C.id);
  });

  it('con un único hueco ofrecido, un “sí” lo elige', () => {
    expect(m('Sí, perfecto', [A.id], [A])).toBe(A.id);
    expect(m('No sé todavía', [A.id], [A])).toBeNull();
  });

  it('la hora se interpreta en la zona horaria del negocio (México)', () => {
    const mx = offeredAt('2026-10-06T18:00', MEXICO);
    expect(matchOfferedSlot(normalize('a las 18:00'), [mx], MEXICO, NOW, [mx.id])).toBe(mx.id);
    expect(matchOfferedSlot(normalize('a las 18:00'), [mx], MADRID, NOW, [mx.id])).toBeNull();
  });

  // Regresión: los ordinales se buscaban en cualquier parte del mensaje. Tras ofrecer horarios, frases comunes
  // elegían (y reservaban) un hueco que el lead no había elegido. El análisis con IA heredaba el error porque
  // usa el resultado heurístico como “red de seguridad” (analysis.selectedSlotId ||= safety.selectedSlotId).
  it('“Dame un segundo, que miro la agenda” no elige el segundo horario', () => {
    expect(m('Dame un segundo, que miro la agenda')).toBeNull();
  });

  it('“Primero dime cuánto cuesta” no elige el primer horario', () => {
    expect(m('Primero dime cuánto cuesta')).toBeNull();
  });

  it('“El jueves no puedo, mejor otro día” no elige el hueco del jueves', () => {
    expect(m('El jueves no puedo, mejor otro día')).toBeNull();
  });

  it('“La última vez que lo intenté…” no elige el último horario', () => {
    expect(m('La última vez que lo intenté lo dejé al mes')).toBeNull();
  });

  it('el análisis completo no debe marcar un horario elegido con “dame un segundo”', () => {
    const state = { offeredSlots: all, lastOfferIds: latest };
    expect(analyze('Dame un segundo, que miro la agenda', { state }).selectedSlotId).toBeNull();
  });

  it('“a primera hora” o “la primera hora libre” son franjas, no la primera opción', () => {
    expect(m('¿Tienes algo mañana a primera hora?')).toBeNull();
    expect(m('Me vendría bien la primera hora libre que tengas')).toBeNull();
    expect(m('La primera vez que entrené fue en el gimnasio')).toBeNull();
  });

  it('formas naturales de elegir por posición', () => {
    expect(m('Me quedo con la segunda')).toBe(D.id);
    expect(m('La primera me viene genial')).toBe(C.id);
    expect(m('Segunda, gracias')).toBe(D.id);
    expect(m('Vale, primera porfa')).toBe(C.id);
    expect(m('El segundo horario')).toBe(D.id);
    expect(m('Opción 2')).toBe(D.id);
  });

  it('si rechaza un horario o pide otro, no elige ninguno (mejor preguntar que reservar mal)', () => {
    expect(m('A las 18:00 no puedo')).toBeNull();
    expect(m('La primera no me viene bien')).toBeNull();
    expect(m('¿Tienes otro día?')).toBeNull();
    expect(m('Ninguna me va bien')).toBeNull();
    expect(m('Sí, perfecto', [A.id], [A])).toBe(A.id);
  });

  it('un número que no tiene forma de hora no se toma por un horario', () => {
    expect(m('Tengo 18 años y a las 10 me va bien')).toBe(C.id);
    expect(m('Quiero perder 10 kilos, ¿a las cuántas es?')).toBeNull();
    expect(m('Entreno 10 horas a la semana, ¿a las cuántas sería?')).toBeNull();
    expect(m('Vale, 10h')).toBe(C.id);
  });

  it('“prefiero/mejor” solo cuentan como palabra completa al elegir por día', () => {
    expect(m('El jueves, que tengo la mesa libre')).toBeNull();
  });
});
