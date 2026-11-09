import { describe, expect, it } from 'vitest';
import { validateReply, type ValidationContext } from '../../src/ai/validation/output-validator.js';
import { MADRID, MEXICO, local, makeTone, makeValidationContext } from './factories.js';

/** Horarios reales ofrecidos: martes 6/10 a las 18:00 y a las 19:30 (Madrid). */
const OFFERED = [local('2026-10-06T18:00'), local('2026-10-06T19:30')];

const ctx = (overrides: Partial<ValidationContext> = {}) =>
  makeValidationContext({
    allowedTimes: OFFERED,
    allowedPricesCents: [19700, 150000, 9750],
    allowedUrls: ['https://calendly.com/alex-fit/valoracion?utm_content=abc'],
    factsText: 'Graduado en CAFYD. Más de 500 clientes. 10 años de experiencia.',
    ...overrides,
  });

const issuesOf = (text: string, c: ValidationContext = ctx()) => validateReply(text, c).issues;
const expectOk = (text: string, c: ValidationContext = ctx()) => expect(validateReply(text, c)).toEqual({ ok: true, issues: [] });
const expectIssue = (text: string, pattern: RegExp, c: ValidationContext = ctx()) => {
  const r = validateReply(text, c);
  expect(r.ok).toBe(false);
  expect(r.issues.some((i) => pattern.test(i)), `issues: ${JSON.stringify(r.issues)}`).toBe(true);
};

describe('validateReply', () => {
  it('un mensaje correcto pasa sin incidencias', () => {
    expectOk('¡Genial, Laura! Mañana tengo hueco a las 18:00 o a las 19:30. ¿Cuál te viene mejor?');
    expectOk('Perfecto, el programa son 197 € al mes e incluye revisión semanal. ¿Lo vemos en la llamada? 💪');
  });

  it('rechaza un mensaje vacío', () => {
    expect(validateReply('   ', ctx())).toEqual({ ok: false, issues: ['El mensaje está vacío.'] });
  });

  describe('una sola pregunta', () => {
    it('detecta más de una pregunta', () => {
      expectIssue('¿Qué tal estás? ¿Y cuál es tu objetivo?', /Hace 2 preguntas/);
    });

    it('admite más preguntas si el contexto lo permite', () => {
      expectOk('¡Hecho! ¿Te llegó el enlace? ¿Alguna duda?', ctx({ maxQuestions: 2 }));
    });

    it('una sola pregunta (con ¿?) es válida', () => {
      expectOk('Entiendo. ¿Qué te gustaría conseguir exactamente?');
    });
  });

  describe('longitud según el tono', () => {
    it.each([
      ['short', 320],
      ['medium', 520],
      ['long', 800],
    ] as const)('tono %s: máximo %i caracteres', (messageLength, max) => {
      const c = ctx({ tone: makeTone({ messageLength }) });
      expectOk('a'.repeat(max), c);
      expectIssue('a'.repeat(max + 1), new RegExp(`demasiado largo \\(${max + 1} caracteres; máximo ${max}\\)`), c);
    });
  });

  describe('formato de chat (sin markdown)', () => {
    it.each(['Esto es **importante** para ti', '- Primer punto\n- Segundo punto', '1. Entrenar\n2. Comer bien', '# Tu plan', 'Mira:\n• uno'])('rechaza: %j', (text) => {
      expectIssue(text, /formato de documento/);
    });

    it('un guion en mitad de la frase no es una lista', () => {
      expectOk('Vale - lo vemos mañana entonces.');
    });
  });

  describe('emojis según el tono', () => {
    it('sin emojis si el entrenador no los usa', () => {
      expectIssue('Genial 💪', /no usa emojis: quítalos/, ctx({ tone: makeTone({ emojiUsage: 'none' }) }));
      expectOk('Genial', ctx({ tone: makeTone({ emojiUsage: 'none' }) }));
    });

    it('tono “low”: como mucho 1', () => {
      const c = ctx({ tone: makeTone({ emojiUsage: 'low' }) });
      expectOk('Genial 💪', c);
      expectIssue('Genial 💪🔥', /demasiados emojis \(2; máximo 1\)/, c);
    });

    it('tono “medium”: hasta 3; tono “high”: hasta 4', () => {
      expectOk('Genial 💪🔥🙌', ctx({ tone: makeTone({ emojiUsage: 'medium' }) }));
      expectIssue('Genial 💪🔥🙌😊', /máximo 3/, ctx({ tone: makeTone({ emojiUsage: 'medium' }) }));
      expectOk('Genial 💪🔥🙌😊', ctx({ tone: makeTone({ emojiUsage: 'high' }) }));
      expectIssue('Genial 💪🔥🙌😊🎉', /máximo 4/, ctx({ tone: makeTone({ emojiUsage: 'high' }) }));
    });
  });

  describe('palabras prohibidas', () => {
    const c = ctx({ wordsToAvoid: ['barato', 'sin compromiso', 'Económico'] });

    it('detecta la palabra (sin distinguir mayúsculas ni tildes)', () => {
      expectIssue('Es muy BARATO, de verdad.', /palabra prohibida “barato”/, c);
      expectIssue('Es una opción economico para empezar.', /palabra prohibida “Económico”/, c);
    });

    it('detecta expresiones de varias palabras', () => {
      expectIssue('La llamada es gratis y sin compromiso.', /“sin compromiso”/, c);
    });

    it('respeta los límites de palabra', () => {
      expectOk('Hola Carolina, ¿qué tal?', ctx({ wordsToAvoid: ['caro'] }));
    });

    it('ignora entradas vacías', () => {
      expectOk('Hola, ¿qué tal?', ctx({ wordsToAvoid: ['', '  '] }));
    });
  });

  describe('horarios: solo los de la agenda real', () => {
    it.each(['a las 18:00', 'a las 19:30', 'a las 18', 'a las 6', 'a las 7 y media', 'a las 18.00h', 'a las 19 y media'])('permite “%s” (ofrecido)', (t) => {
      expectOk(`¿Mañana te va bien ${t}?`);
    });

    it.each(['a las 17', 'a las 18:30', 'a las 17:00', 'a las 8 menos cuarto', 'las 20:15', 'a las 9 y cuarto'])('rechaza “%s” (inventado)', (t) => {
      expectIssue(`¿Mañana te va bien ${t}?`, /no ha salido de la agenda real/);
    });

    it('“a las 18:30” se lee como 18:30 (no como “a las 18”)', () => {
      expectIssue('¿Te va bien a las 18:30?', /“18:30”/);
    });

    it('“menos cuarto” resta una hora', () => {
      expectOk('¿Te va bien a las 7 menos cuarto?', ctx({ allowedTimes: [local('2026-10-06T18:45')] }));
    });

    it('sin horarios ofrecidos, cualquier hora es inventada', () => {
      expectIssue('Te llamo a las 18:00.', /“18:00”/, ctx({ allowedTimes: [] }));
    });

    it('compara en la zona horaria del negocio', () => {
      const allowed = [new Date('2026-10-07T00:00:00.000Z')]; // 18:00 en México, 02:00 en Madrid
      expectOk('¿Te va bien mañana a las 18:00?', ctx({ timezone: MEXICO, allowedTimes: allowed }));
      expectIssue('¿Te va bien mañana a las 18:00?', /no ha salido de la agenda real/, ctx({ timezone: MADRID, allowedTimes: allowed }));
    });

    it('no confunde un importe en miles con una hora', () => {
      expectOk('El pack completo son 1.500 €.');
    });

    // Regresión: la expresión de horas solo reconocía “a las” en minúscula. “A las 17” al inicio de frase
    // (hora inventada) pasaba el control de calidad.
    it('detecta una hora inventada al inicio de frase (“A las 17”)', () => {
      expectIssue('A las 17 tengo un hueco libre, ¿te encaja?', /no ha salido de la agenda real/);
    });

    // Regresión: el “lookahead” (?![:.\d]) que evita leer “18:30” como “a las 18” también descartaba
    // “a las 17.” cuando la hora iba seguida del punto final de la frase.
    it('detecta una hora inventada seguida de punto final (“a las 17.”)', () => {
      expectIssue('Perfecto, te llamo mañana a las 17.', /no ha salido de la agenda real/);
    });

    it('detecta “a las 17h” (hora inventada con “h” pegada)', () => {
      expectIssue('¿Te va bien mañana a las 17h?', /no ha salido de la agenda real/);
      expectOk('¿Te va bien mañana a las 18h?');
      expectOk('A las 18:00 tengo hueco, ¿te encaja?');
    });

    it('la hora en UTC dentro de un enlace de Calendly no cuenta como horario mencionado', () => {
      const link = 'https://calendly.com/alex-fit/valoracion/2026-10-06T16:00:00Z?month=2026-10&utm_content=abc';
      expectOk(`Para confirmarlo, resérvalo aquí: ${link}`, ctx({ allowedUrls: [link] }));
    });
  });

  describe('precios: solo los configurados', () => {
    it.each(['197 €', '197€', '1.500 €', '1500€', '1 500 €', '97,50 euros', '97.50 €', '€197', '197 EUR', '197 euros'])('permite “%s” (configurado)', (p) => {
      expectOk(`El precio es ${p}.`);
    });

    it.each(['199 €', '1.200 €', '97,00 euros', '50 euros', '€20'])('rechaza “%s” (inventado)', (p) => {
      expectIssue(`El precio es ${p}.`, /no coincide con ningún precio configurado/);
    });

    it('sin precios configurados cualquier importe es inventado', () => {
      expectIssue('Son 197 € al mes.', /“197 €”/, ctx({ allowedPricesCents: [] }));
    });

    // Regresión: un precio con punto decimal (“19.50 €”) se interpretaba además como la hora 19:50.
    it('un precio real con punto decimal no debe tomarse por un horario', () => {
      expectOk('La sesión suelta son 19.50 €.', ctx({ allowedPricesCents: [1950] }));
    });
  });

  describe('enlaces', () => {
    it('permite el enlace de la agenda (aunque lleve un punto final)', () => {
      expectOk('Aquí tienes el enlace: https://calendly.com/alex-fit/valoracion?utm_content=abc.');
    });

    it('rechaza enlaces que no vienen de la agenda ni de la configuración', () => {
      expectIssue('Mira esto: https://mi-web-falsa.com/oferta', /enlace que no procede/);
      expectIssue('Reserva aquí https://calendly.com/otro-coach/30min', /enlace que no procede/);
    });

    it('sin enlaces permitidos cualquier URL es inválida', () => {
      expectIssue('https://calendly.com/alex-fit/valoracion', /enlace/, ctx({ allowedUrls: [] }));
    });

    // Regresión: la comparación por prefijo aceptaba cualquier URL que EMPEZARA por una permitida.
    it('no acepta una URL que solo comparte prefijo con la permitida', () => {
      expectIssue('Entra aquí: https://meet.google.com/abc-defg-hijklmn', /enlace que no procede/, ctx({ allowedUrls: ['https://meet.google.com/abc-defg-hij'] }));
      expectIssue('Reserva aquí https://calendly.com/alex-fit', /enlace que no procede/);
    });

    it('admite el mismo enlace sin los parámetros de seguimiento o con barra final, pero no con otros parámetros', () => {
      expectOk('Reserva aquí: https://calendly.com/alex-fit/valoracion');
      expectOk('Reserva aquí: https://calendly.com/alex-fit/valoracion/?utm_content=abc');
      expectIssue('Reserva aquí: https://calendly.com/alex-fit/valoracion?utm_content=otro', /enlace que no procede/);
    });
  });

  describe('reglas de contenido', () => {
    it.each(['Te garantizo que lo vas a conseguir', 'Perderás 10 kilos en nada', 'En 4 semanas verás el cambio', 'Resultados garantizados con mi método'])(
      'rechaza promesas de resultados: %j',
      (t) => expectIssue(t, /Promete o garantiza resultados/),
    );

    it.each(['Puedes dejar la insulina si entrenas', 'Reduce la medicación poco a poco', 'Eso es una tendinitis', 'Seguramente tienes resistencia a la insulina'])(
      'rechaza consejos o diagnósticos médicos: %j',
      (t) => expectIssue(t, /consejo o diagnóstico médico/),
    );

    it.each(['Es tu última oportunidad', 'Solo por hoy te lo dejo así', 'Quedan pocas plazas', 'Plazas limitadas este mes', 'Ahora o nunca'])(
      'rechaza la presión o la escasez: %j',
      (t) => expectIssue(t, /Presiona con urgencia/),
    );

    it('rechaza frases de chatbot genérico', () => {
      expectIssue('Estoy aquí para ayudarte en lo que necesites', /chatbot genérico/);
      expectIssue('No dudes en preguntar lo que quieras', /chatbot genérico/);
    });

    it('rechaza etiquetas o notas internas', () => {
      expectIssue('<thinking>hola</thinking> ¿Qué tal?', /etiquetas o notas internas/);
      expectIssue('⟦NOTA INTERNA⟧ Hola', /etiquetas o notas internas/);
    });

    it('un seguimiento genérico solo se rechaza en modo seguimiento', () => {
      const text = 'Hola Laura, solo te hago un seguimiento por si viste mi mensaje.';
      expectIssue(text, /seguimiento genérico/, ctx({ isFollowUp: true }));
      expect(issuesOf(text, ctx({ isFollowUp: false })).some((i) => /seguimiento genérico/.test(i))).toBe(false);
    });

    it('un seguimiento concreto pasa', () => {
      expectOk('Laura, ¿cómo vas con lo de entrenar antes del verano?', ctx({ isFollowUp: true }));
    });
  });

  describe('mensajes repetidos', () => {
    it('detecta un mensaje idéntico a uno anterior (ignorando mayúsculas, tildes y espacios)', () => {
      expectIssue('hola laura,   ¿que tal?', /Repite exactamente un mensaje anterior/, ctx({ previousMessages: ['Hola Laura, ¿qué tal?'] }));
    });

    it('un mensaje distinto no se considera repetido', () => {
      expectOk('Hola Laura, ¿cómo va todo?', ctx({ previousMessages: ['Hola Laura, ¿qué tal?'] }));
    });
  });

  describe('cifras de autoridad', () => {
    it('permite cifras que aparecen en el perfil real', () => {
      expectOk('He ayudado a más de 500 clientes como tú.');
      expectOk('Llevo 10 años de experiencia con casos así.');
    });

    it('rechaza cifras inventadas', () => {
      expectIssue('He ayudado a más de 800 clientes.', /no aparece en el perfil del entrenador/);
      expectIssue('Tengo 12 años de experiencia.', /no aparece en el perfil/);
      expectIssue('Más de 200 transformaciones reales.', /no aparece en el perfil/);
    });

    it('sin datos de autoridad, cualquier cifra es inventada', () => {
      expectIssue('Ya son 500 alumnos.', /no aparece en el perfil/, ctx({ factsText: '' }));
    });

    // Regresión: una cifra real con separador de miles (“1.000 alumnos”) se marcaba como inventada.
    it('permite una cifra real escrita con separador de miles', () => {
      expectOk('Ya son más de 1.000 alumnos.', ctx({ factsText: 'Más de 1.000 alumnos formados.' }));
    });

    // Regresión: la comprobación era por subcadena: “30 clientes” se daba por buena si el perfil decía “300 clientes”.
    it('rechaza una cifra inventada contenida dentro de otra real', () => {
      expectIssue('He trabajado con 30 clientes.', /no aparece en el perfil/, ctx({ factsText: 'Más de 300 clientes.' }));
      expectIssue('Más de 1.000 alumnos.', /no aparece en el perfil/, ctx({ factsText: 'Más de 100 alumnos y 10 años de experiencia.' }));
      expectOk('Más de 1000 alumnos.', ctx({ factsText: 'Más de 1.000 alumnos formados.' }));
    });
  });

  it('acumula varias incidencias a la vez', () => {
    const r = validateReply('**Última oportunidad**: ¿197 €? ¿O 299 €?', ctx());
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
  });
});
