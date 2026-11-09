/**
 * p5-setter-calidad: control de calidad determinista (cifras, testimonios, precios en letras, promesas, consejos
 * médicos y presión) y horas para leads que escriben desde otro país.
 */
import { describe, expect, it } from 'vitest';
import { buildAnalysisSystemPrompt } from '../../src/ai/prompts/analysis.prompt.js';
import { buildSetterTurnContext } from '../../src/ai/prompts/setter.prompt.js';
import type { Directive } from '../../src/ai/setter/strategy.js';
import { validateReply, type ValidationContext } from '../../src/ai/validation/output-validator.js';
import { formatInZone, humanSlotLabel, leadZone, leadZoneNote, zonePlace } from '../../src/lib/time.js';
import { MADRID, MEXICO, NOW, local, makeAppointment, makeBusinessContext, makeLead, makeLeadContext, makeValidationContext } from './factories.js';

const issuesOf = (text: string, c: ValidationContext) => validateReply(text, c).issues;
const expectOk = (text: string, c: ValidationContext) => expect(validateReply(text, c), text).toEqual({ ok: true, issues: [] });
const expectIssue = (text: string, pattern: RegExp, c: ValidationContext) => {
  const issues = issuesOf(text, c);
  expect(issues.some((i) => pattern.test(i)), `${text} → ${JSON.stringify(issues)}`).toBe(true);
};

const INVENTED = /perfil del entrenador/;

describe('p5-setter-calidad · validador: cifras y testimonios inventados', () => {
  /** Negocio sin cifras de autoridad: cualquier dato del entrenador es inventado. */
  const bare = makeValidationContext({ allowedPricesCents: [19700], currencies: ['EUR'], factsText: 'Graduado en CAFYD.' });

  it.each([
    'Una clienta mía, Marta, perdió 12 kilos en tres meses.',
    'Llevo quince años ayudando a hombres como tú.',
    'Llevo 10 años entrenando.',
    'Tengo más de doscientos clientes que lo han conseguido.',
    'Tenemos una tasa de éxito del 95%.',
    'El 90% de mis clientes baja de peso en el primer mes.',
    'Mis alumnos han perdido de media 8 kilos.',
    'Más de mil personas ya han pasado por el programa.',
    'Un alumno mío bajó tres tallas en dos meses.',
    'He ayudado a 300 hombres a ponerse en forma.',
    'Hemos ayudado a cientos de hombres como tú.',
    'Ahora hay un 20% de descuento.',
    'Mi cliente Juan perdió 15 kilos.',
    'El 100% de mis clientes lo consigue.',
    'Tienes a tu disposición a Álex, que lleva 15 años ayudando a hombres como tú.',
  ])('rechaza «%s»', (text) => expectIssue(text, INVENTED, bare));

  it('rechaza el testimonio sin cifras de un cliente que no está en el perfil', () => {
    expectIssue('Uno de mis alumnos consiguió dejar el azúcar en un mes.', /caso de un cliente/, bare);
  });

  it('permite las cifras que están en los datos del negocio', () => {
    const facts = makeValidationContext({ factsText: 'Más de 500 clientes transformados. 10 años de experiencia. Juan perdió 15 kg en 12 semanas.' });
    expectOk('Llevo 10 años entrenando.', facts);
    expectOk('Más de 500 clientes han pasado por el programa.', facts);
    expectOk('He ayudado a cientos de personas como tú.', facts);
    expectOk('Un cliente mío, Juan, perdió 15 kilos en 12 semanas.', facts);
    // “Cientos” sí; “miles” no sale de 500 clientes.
    expectIssue('Miles de clientes lo avalan.', INVENTED, facts);
  });

  it('sin saber lo que dijo el lead, no da por inventadas las cifras que hablan de él o de alguien suyo', () => {
    expectOk('Si llevas 10 años entrenando sin ver cambios, algo falla en el plan. ¿Qué haces ahora?', bare);
    expectOk('Tu amigo perdió 15 kilos, ¡qué bien! ¿Y tú qué te gustaría conseguir?', bare);
    expectOk('Si lleva usted 10 años entrenando sin resultados, algo falla.', bare);
    expectOk('Entiendo, quieres perder esos 10 kilos antes del verano. ¿Desde cuándo lo intentas?', bare);
    expectOk('A tus 40 años es normal que cueste más. ¿Cuántos días puedes entrenar?', bare);
    expectOk('Has dicho que pesas 95 kilos y quieres llegar a 85, ¿verdad?', bare);
    expectOk('El programa es 100% online.', bare);
  });

  describe('con lo que ha dicho el lead (leadText)', () => {
    const lead = makeValidationContext({
      factsText: 'Graduado en CAFYD.',
      leadText: 'Quiero perder 10 kilos, de 95 a 85. Tengo 40 años. Llevo diez años entrenando. Mi amigo perdió 15 kilos. ¿Es verdad que tienes 500 clientes? Me sobra un 20% de grasa',
    });

    it('KAI puede repetir sus cifras (objetivo, edad, peso, lo de su amigo)', () => {
      expectOk('Entiendo, quieres perder esos 10 kilos. ¿Desde cuándo lo intentas?', lead);
      expectOk('Pasar de 95 a 85 kilos es un objetivo realista. ¿Cuántos días puedes entrenar?', lead);
      expectOk('Que tu amigo perdiera 15 kilos es una buena señal. ¿Qué te gustaría conseguir a ti?', lead);
      expectOk('Si llevas 10 años entrenando sin cambios, algo falla en el plan.', lead);
      expectOk('Ese 20% de grasa que comentas se trabaja con constancia.', lead);
      expectOk('El programa es 100% online.', lead);
    });

    it('rechaza cualquier cifra de kilos o % que no salga de los datos ni del lead', () => {
      expectIssue('Mucha gente pierde 2 o 3 kilos el primer mes.', INVENTED, lead);
      expectIssue('El 80% del resultado está en la alimentación.', INVENTED, lead);
    });

    it('que el lead pregunte por una cifra del entrenador no la hace cierta', () => {
      expectIssue('Sí, más de 500 clientes.', INVENTED, lead);
    });

    it('las cifras del lead no valen para resultados de clientes del entrenador', () => {
      expectIssue('Mis alumnos han perdido de media 10 kilos.', INVENTED, lead);
      expectIssue('Una clienta mía perdió 15 kilos.', /perfil del entrenador/, lead);
    });
  });
});

describe('p5-setter-calidad · validador: precios en letras', () => {
  const eur = makeValidationContext({ allowedPricesCents: [19700], currencies: ['EUR'] });
  const mxn = makeValidationContext({ allowedPricesCents: [1_500_000], currencies: ['MXN'] });

  it('rechaza importes en letras que no están configurados', () => {
    expectIssue('Son ciento cincuenta euros al mes.', /no coincide con ningún precio/, eur);
    expectIssue('Es una inversión de doscientos euros.', /no coincide con ningún precio/, eur);
    expectIssue('Son 16 mil pesos al mes.', /no coincide con ningún precio/, mxn);
  });

  it('permite el precio real dicho en letras o en miles', () => {
    expectOk('Son ciento noventa y siete euros al mes.', eur);
    expectOk('Son 15 mil pesos al mes.', mxn);
    expectOk('Son quince mil pesos al mes.', mxn);
    expectOk('Un peso saludable se consigue con constancia.', eur);
  });
});

describe('p5-setter-calidad · validador: promesas, consejos médicos y presión', () => {
  const c = makeValidationContext();

  it.each(['Solo me quedan dos plazas este mes, así que decide hoy.', 'Esta oferta caduca esta noche.', 'Si no lo haces ahora, lo vas a lamentar.', 'Queda una plaza para este mes.'])(
    'rechaza la presión «%s»',
    (text) => expectIssue(text, /[Pp]resiona/, c),
  );

  it.each(['Con el plan vas a perder la barriga seguro.', 'Lo conseguirás, te lo prometo.', 'Seguro que vas a notar cambios en dos semanas.'])('rechaza la promesa «%s»', (text) =>
    expectIssue(text, /garantiza resultados/, c),
  );

  it.each([
    'Con tu hernia lo mejor es que tomes ibuprofeno antes de entrenar.',
    'Eso que cuentas suena a resistencia a la insulina.',
    'Tómate 400 mg de magnesio antes de dormir.',
    'Parece una tendinitis, nada grave.',
  ])('rechaza el consejo médico «%s»', (text) => expectIssue(text, /médico/, c));

  it.each([
    'Con la medicación que tomas, lo mejor es que lo consultes con tu médico.',
    'Si tomas ibuprofeno a menudo, coméntalo con tu médico antes de empezar.',
    'Lo de la rodilla lo tiene que ver un fisio, yo no te puedo decir qué es.',
    'No te vas a arrepentir de preguntar. ¿Te cuento cómo funciona?',
    'Quedan dos días para el lunes. ¿Hablamos entonces?',
    'Cuando dejes de comer a deshoras vas a notar la diferencia.',
  ])('permite «%s»', (text) => expectOk(text, c));
});

describe('p5-setter-calidad · horas para leads de otro país (lib/time.ts)', () => {
  const MX_LEAD = '5215512345678';
  const ES_LEAD = '34600111222';
  /** Martes 6/10 a las 18:00 en Madrid = 10:00 en Ciudad de México. NOW es el lunes 5/10 a las 12:00 en Madrid. */
  const SLOT = local('2026-10-06T18:00');
  /** Martes 6/10 a la 01:00 en Madrid = lunes 5/10 a las 17:00 en México. */
  const LATE = local('2026-10-06T01:00');

  it('leadZone: país y zona del lead solo si es de otro país con otra hora', () => {
    expect(leadZone(MX_LEAD, MADRID, SLOT)).toEqual({ country: 'México', timezone: MEXICO });
    expect(leadZone('+52 55 1234 5678', MADRID, SLOT)).toEqual({ country: 'México', timezone: MEXICO });
    expect(leadZone(ES_LEAD, MADRID, SLOT)).toBeNull();
    expect(leadZone('600111222', MADRID, SLOT)).toBeNull(); // sin prefijo: del país del negocio
    expect(leadZone(null, MADRID, SLOT)).toBeNull(); // Instagram, sin teléfono
    // Estados Unidos (+1) tiene varias zonas: solo se sabe que es otro país.
    expect(leadZone('15551234567', MADRID, SLOT)).toEqual({ country: null, timezone: null });
    // Portugal y Canarias tienen la misma hora: no hace falta aclarar nada.
    expect(leadZone('351912345678', 'Atlantic/Canary', SLOT)).toBeNull();
    // Negocio de un país desconocido y número sin prefijo: no se puede saber.
    expect(leadZone('600111222', 'Asia/Tokyo', SLOT)).toBeNull();
  });

  it('humanSlotLabel añade la hora de España y la del lead; sin cambios para un lead del mismo país', () => {
    expect(humanSlotLabel(SLOT, MADRID, NOW, { leadPhone: MX_LEAD })).toBe('mañana a las 18:00 (hora de España; en México, a las 10:00)');
    expect(humanSlotLabel(LATE, MADRID, NOW, { leadPhone: MX_LEAD })).toBe('mañana a las 01:00 (hora de España; en México, hoy a las 17:00)');
    expect(humanSlotLabel(SLOT, MADRID, NOW, { leadPhone: '15551234567' })).toBe('mañana a las 18:00 (hora de España)');
    expect(humanSlotLabel(SLOT, MADRID, NOW, { leadPhone: ES_LEAD })).toBe('mañana a las 18:00');
    expect(humanSlotLabel(SLOT, MADRID, NOW)).toBe('mañana a las 18:00');
    expect(leadZoneNote(SLOT, MADRID, ES_LEAD, NOW)).toBe('');
  });

  it('formatInZone (confirmaciones y recordatorios) también aclara la zona', () => {
    expect(formatInZone(SLOT, MADRID, undefined, { leadPhone: MX_LEAD })).toBe('martes 6 de octubre, 18:00 (hora de España; en México, a las 10:00)');
    expect(formatInZone(SLOT, MADRID)).toBe('martes 6 de octubre, 18:00');
  });

  it('zonePlace nombra la zona del entrenador de forma comprensible', () => {
    expect(zonePlace(MADRID)).toBe('España');
    expect(zonePlace('Atlantic/Canary')).toBe('Canarias');
    expect(zonePlace('Zona/Inventada_Rara')).toBe('Inventada Rara');
  });

  describe('validador: cada hora se comprueba en la zona que nombra el mensaje', () => {
    const c = makeValidationContext({ allowedTimes: [SLOT, LATE], now: NOW });

    it('acepta la etiqueta con las dos horas y la hora del lead dicha con su país', () => {
      expectOk('Tengo mañana a las 18:00 (hora de España; en México, a las 10:00). ¿Te va bien?', c);
      expectOk('Tengo mañana a las 10:00 hora de México.', c);
      expectOk('Tengo el martes a las 18:00, es decir, a las 10:00 en México.', c);
      expectOk('Mañana a las 01:00 (hora de España; en México, hoy a las 17:00).', c);
    });

    it('rechaza una conversión mal hecha o una hora sin zona que no es de la agenda', () => {
      expectIssue('En México, mañana a las 11:00.', /no ha salido de la agenda real/, c);
      expectIssue('Tengo mañana a las 10:00.', /no ha salido de la agenda real/, c);
      expectIssue('Mañana a las 01:00 (hora de España; en México, mañana a las 17:00).', /ese día no hay/, c);
    });
  });

  describe('prompts', () => {
    const biz = makeBusinessContext();
    const directive: Directive = { kind: 'offer_slots', instruction: 'Ofrece los horarios.' };
    const state = { offeredSlots: [{ id: 's1', start: SLOT.toISOString(), end: SLOT.toISOString(), label: 'mañana a las 18:00' }] };

    it('el contexto del setter da las horas con la zona y pide decirla a un lead de otro país', () => {
      const leadCtx = makeLeadContext({ lead: makeLead({ whatsappId: MX_LEAD }), upcomingAppointment: makeAppointment({ startsAt: SLOT }) });
      const text = buildSetterTurnContext({ biz, leadCtx, channel: 'whatsapp', state, directive, now: NOW });
      expect(text).toContain('mañana a las 18:00 (hora de España; en México, a las 10:00) (slot_id s1)');
      expect(text).toContain('martes 6 de octubre a las 18:00 (hora de España; en México, a las 10:00)');
      expect(text).toMatch(/Zona horaria: el lead escribe desde un número de México/);
      expect(text).toMatch(/di siempre que es hora de España/);
    });

    it('sin cambios para un lead del mismo país', () => {
      const leadCtx = makeLeadContext({ lead: makeLead({ whatsappId: ES_LEAD }) });
      const text = buildSetterTurnContext({ biz, leadCtx, channel: 'whatsapp', state, directive, now: NOW });
      expect(text).toContain('- mañana a las 18:00 (slot_id s1)');
      expect(text).not.toMatch(/Zona horaria|hora de España/);
    });

    it('el análisis ve la hora del lead para entender «a las 10» como el horario de las 18:00', () => {
      const lead = makeLead({ whatsappId: MX_LEAD });
      const text = buildAnalysisSystemPrompt({ biz, lead, history: [], pending: [], state, now: NOW });
      expect(text).toContain('s1: mañana a las 18:00 (hora de España; en México, a las 10:00)');
    });
  });
});
