/**
 * Revisión nº 1 · agenda y automatizaciones (sin base de datos):
 * - Textos editables de confirmación, recordatorios y no-show (variables, validación y valores por defecto).
 * - Encaje de los seguimientos en la ventana de 24 h del canal, respetando el horario de silencio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automationMessageIssues,
  confirmationText,
  DEFAULT_MESSAGE_TEMPLATES,
  messageTemplateIssues,
  noShowText,
  reminderText,
  renderMessageTemplate,
  type AppointmentMessageKind,
} from '../../src/automation/messages.js';
import { fitIntoWindow, quietPeriodStart } from '../../src/automation/followups.js';
import { hm, local, localStamp, MADRID, makeTone } from './factories.js';

const base = {
  leadName: 'laura gómez',
  trainerName: 'Álex',
  callLabel: 'llamada de valoración',
  startsAt: new Date('2026-10-06T16:00:00.000Z'), // martes 6/10, 18:00 en Madrid
  timezone: MADRID,
  tone: makeTone({ emojiUsage: 'low', formality: 2 }),
};

describe('textos editables de la llamada', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z')); // lunes 12:00 en Madrid
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('los textos por defecto que se muestran en la interfaz son válidos', () => {
    for (const [kind, text] of Object.entries(DEFAULT_MESSAGE_TEMPLATES) as [AppointmentMessageKind, string][]) {
      expect(messageTemplateIssues(kind, text), kind).toEqual([]);
    }
  });

  it('rellena las variables con los datos reales de la cita (fecha relativa al día del envío)', () => {
    const text = renderMessageTemplate('Hola {nombre}, te espero {fecha} a las {hora} para la {llamada} con {entrenador}. Enlace: {enlace}', {
      ...base,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    });
    expect(text).toBe('Hola Laura, te espero mañana a las 18:00 para la llamada de valoración con Álex. Enlace: https://meet.google.com/abc-defg-hij');
  });

  it('{fecha} pasa a “el martes 13 de octubre” cuando la llamada no es en los próximos días', () => {
    const text = renderMessageTemplate('Te confirmo la {llamada} {fecha} a las {hora}.', { ...base, startsAt: new Date('2026-10-13T16:00:00.000Z') });
    expect(text).toBe('Te confirmo la llamada de valoración el martes 13 de octubre a las 18:00.');
  });

  it('sin nombre del lead no deja huecos ni comas sueltas', () => {
    expect(renderMessageTemplate('Hola {nombre}, nos vemos a las {hora}.', { ...base, leadName: '' })).toBe('Hola, nos vemos a las 18:00.');
    expect(renderMessageTemplate('{nombre}, nos vemos a las {hora}.', { ...base, leadName: '' })).toBe('Nos vemos a las 18:00.');
    expect(renderMessageTemplate('¡Hola {nombre}! A las {hora} hablamos.', { ...base, leadName: '' })).toBe('¡Hola! A las 18:00 hablamos.');
  });

  it('sin enlace quita la línea del enlace o su etiqueta, sin dejar “Enlace:” suelto', () => {
    expect(renderMessageTemplate(DEFAULT_MESSAGE_TEMPLATES.confirmation, base)).toBe(
      'Laura, te confirmo la llamada de valoración con Álex mañana a las 18:00 ✅\nSi necesitas cambiarla, dímelo por aquí.',
    );
    expect(renderMessageTemplate('Hola {nombre}, a las {hora} es la {llamada}. Enlace: {enlace}', base)).toBe('Hola Laura, a las 18:00 es la llamada de valoración.');
    expect(renderMessageTemplate('A las {hora} hablamos 🙌 Te dejo el enlace: {enlace} ¡Hasta luego!', base)).toBe('A las 18:00 hablamos 🙌 ¡Hasta luego!');
  });

  it('con enlace lo incluye tal cual', () => {
    const text = renderMessageTemplate(DEFAULT_MESSAGE_TEMPLATES.reminder1h, { ...base, meetingUrl: 'https://zoom.us/j/1' });
    expect(text).toBe('Laura, en una hora (a las 18:00) es la llamada de valoración con Álex 🙌\nTe dejo el enlace: https://zoom.us/j/1');
  });

  it('confirmationText, reminderText y noShowText usan el texto del entrenador si lo hay', () => {
    expect(confirmationText(base, 'Listo {nombre}: {fecha} a las {hora}.')).toBe('Listo Laura: mañana a las 18:00.');
    expect(reminderText(base, '24h', 'Recuerda: {fecha} a las {hora} tienes la {llamada}.')).toBe('Recuerda: mañana a las 18:00 tienes la llamada de valoración.');
    expect(reminderText(base, '1h', 'En nada empezamos (a las {hora}).')).toBe('En nada empezamos (a las 18:00).');
    expect(noShowText(base, '{nombre}, te echamos de menos en la {llamada}. ¿Buscamos otro momento?')).toBe(
      'Laura, te echamos de menos en la llamada de valoración. ¿Buscamos otro momento?',
    );
  });

  it('sin texto personalizado (o vacío) se usa el texto por defecto de KAI, adaptado al tono', () => {
    expect(confirmationText(base, '')).toBe(confirmationText(base));
    expect(confirmationText(base, undefined)).toBe('Laura, te confirmo la llamada de valoración con Álex el martes 6 de octubre a las 18:00 ✅ Si necesitas cambiarla, dímelo por aquí.');
    expect(noShowText(base, '   ')).toMatch(/^Ey Laura, veo que finalmente/);
  });

  it('un texto guardado que ya no es válido no se envía roto: se usa el texto por defecto', () => {
    expect(confirmationText(base, 'Hola {nombre}, te veo {dia}')).toBe(confirmationText(base));
  });

  it('valida variables desconocidas, llaves sueltas y variables obligatorias', () => {
    expect(messageTemplateIssues('confirmation', 'Hola {name}, {fecha} a las {hora}').join(' ')).toMatch(/\{name\} no es una variable válida/);
    expect(messageTemplateIssues('reminder1h', 'Hola {nombre, a las {hora}').join(' ')).toMatch(/llaves/);
    expect(messageTemplateIssues('reminder24h', 'Hola {nombre}, mañana tienes la {llamada}').join(' ')).toMatch(/Incluye \{fecha\} y \{hora\}/);
    expect(messageTemplateIssues('reminder1h', 'Hola {nombre}, en un rato hablamos').join(' ')).toMatch(/Incluye \{hora\}/);
    expect(messageTemplateIssues('noShow', 'Hola {nombre}, ¿todo bien? Si quieres, buscamos otro hueco.')).toEqual([]);
  });

  it('una sola pregunta, sin horas sueltas ni precios', () => {
    expect(messageTemplateIssues('noShow', '¿Todo bien? ¿Buscamos otro hueco?').join(' ')).toMatch(/una pregunta/);
    expect(messageTemplateIssues('confirmation', 'Te espero {fecha} a las 18:00 ({hora})').join(' ')).toMatch(/horas concretas/);
    expect(messageTemplateIssues('confirmation', 'Te espero {fecha} a las {hora}. El plan cuesta 149 €').join(' ')).toMatch(/precios/);
    expect(messageTemplateIssues('confirmation', 'x'.repeat(701) + '{fecha}{hora}').join(' ')).toMatch(/demasiado largo/);
  });

  it('el texto vacío es válido (significa “usar el texto por defecto”)', () => {
    expect(messageTemplateIssues('confirmation', '')).toEqual([]);
    expect(messageTemplateIssues('confirmation', '   ')).toEqual([]);
  });

  it('automationMessageIssues indica el campo de la configuración con problemas', () => {
    const issues = automationMessageIssues({ confirmation: true, confirmationMessage: 'Hola {nombre}', reminder1hMessage: 'A las {hora} hablamos', noShowMessage: '' });
    expect(issues.map((i) => i.field)).toEqual(['confirmationMessage']);
    expect(issues[0].issues.join(' ')).toMatch(/Incluye \{fecha\} y \{hora\}/);
  });
});

describe('seguimientos dentro de la ventana de 24 h del canal', () => {
  const quiet = { start: '21:30', end: '09:00' };

  it('quietPeriodStart: inicio del tramo de silencio en curso', () => {
    expect(localStamp(quietPeriodStart(local('2026-10-06T03:00'), MADRID, quiet))).toBe('2026-10-05 21:30');
    expect(localStamp(quietPeriodStart(local('2026-10-06T23:00'), MADRID, quiet))).toBe('2026-10-06 21:30');
  });

  it('si el envío cae dentro de la ventana, no se toca', () => {
    const runAt = local('2026-10-06T14:00');
    expect(fitIntoWindow({ runAt, windowEnd: local('2026-10-06T19:30'), earliest: local('2026-10-06T11:00'), timezone: MADRID, quietHours: quiet })).toEqual(runAt);
  });

  it('si cae después del cierre, se adelanta al último momento seguro', () => {
    const fitted = fitIntoWindow({ runAt: local('2026-10-07T10:00'), windowEnd: local('2026-10-06T19:30'), earliest: local('2026-10-06T11:00'), timezone: MADRID, quietHours: quiet });
    expect(fitted && localStamp(fitted)).toBe('2026-10-06 19:30');
  });

  it('si el cierre cae en horario de silencio, se envía justo antes de que empiece', () => {
    const fitted = fitIntoWindow({ runAt: local('2026-10-07T12:00'), windowEnd: local('2026-10-07T02:30'), earliest: local('2026-10-06T12:00'), timezone: MADRID, quietHours: quiet });
    expect(fitted && hm(fitted)).toBe('21:29');
    expect(fitted && localStamp(fitted)).toBe('2026-10-06 21:29');
  });

  it('si ya no cabe, no se programa (null)', () => {
    expect(fitIntoWindow({ runAt: local('2026-10-07T12:00'), windowEnd: local('2026-10-06T19:30'), earliest: local('2026-10-06T20:00'), timezone: MADRID, quietHours: quiet })).toBeNull();
    // El cierre cae en silencio y el silencio empezó antes de lo más pronto permitido.
    expect(fitIntoWindow({ runAt: local('2026-10-07T12:00'), windowEnd: local('2026-10-07T02:30'), earliest: local('2026-10-06T22:00'), timezone: MADRID, quietHours: quiet })).toBeNull();
  });
});
