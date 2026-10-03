import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmationText, noShowText, reminderTemplateParams, reminderText } from '../../src/automation/messages.js';
import { countEmojis } from '../../src/lib/text.js';
import { MADRID, MEXICO, makeTone } from './factories.js';

const base = {
  leadName: 'laura gómez',
  trainerName: 'Álex',
  callLabel: 'llamada de valoración',
  startsAt: new Date('2026-10-06T16:00:00.000Z'), // martes 6/10: 18:00 Madrid, 10:00 México
  timezone: MADRID,
  tone: makeTone({ emojiUsage: 'low', formality: 2 }),
};

describe('confirmationText', () => {
  it('fecha y hora exactas en la zona del negocio (Madrid)', () => {
    expect(confirmationText(base)).toBe('Laura, te confirmo la llamada de valoración con Álex el martes 6 de octubre a las 18:00 ✅ Si necesitas cambiarla, dímelo por aquí.');
  });

  it('fecha y hora exactas en la zona del negocio (México)', () => {
    expect(confirmationText({ ...base, timezone: MEXICO })).toContain('el martes 6 de octubre a las 10:00');
  });

  it('cambia de día cuando la zona horaria lo exige', () => {
    const lateUtc = { ...base, startsAt: new Date('2026-10-06T03:00:00.000Z') };
    expect(confirmationText({ ...lateUtc, timezone: MADRID })).toContain('el martes 6 de octubre a las 05:00');
    expect(confirmationText({ ...lateUtc, timezone: MEXICO })).toContain('el lunes 5 de octubre a las 21:00');
  });

  it('respeta el horario de invierno (después del 25/10)', () => {
    expect(confirmationText({ ...base, startsAt: new Date('2026-10-27T17:00:00.000Z') })).toContain('el martes 27 de octubre a las 18:00');
  });

  it('incluye el enlace de la reunión si existe', () => {
    expect(confirmationText({ ...base, meetingUrl: 'https://meet.google.com/abc-defg-hij' })).toContain('✅ Enlace: https://meet.google.com/abc-defg-hij Si necesitas');
  });

  it('sin emojis si el tono no los usa', () => {
    const text = confirmationText({ ...base, tone: makeTone({ emojiUsage: 'none' }) });
    expect(countEmojis(text)).toBe(0);
  });

  // BUG (menor): sin emoji y/o sin nombre el texto queda mal puntuado: “…a las 18:00 Si necesitas…”
  // (falta el punto) y empieza en minúscula (“te confirmo…”).
  it.fails('BUG: sin emojis la frase de la fecha termina en punto', () => {
    expect(confirmationText({ ...base, tone: makeTone({ emojiUsage: 'none' }) })).toContain('a las 18:00. Si necesitas');
  });

  it.fails('BUG: sin nombre del lead el mensaje empieza en mayúscula', () => {
    expect(confirmationText({ ...base, leadName: '' })).toMatch(/^Te confirmo/);
  });
});

describe('reminderText', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z')); // lunes 12:00 en Madrid
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('24 h antes: “mañana a las 18:00” relativo a hoy en la zona del negocio', () => {
    const text = reminderText(base, '24h');
    expect(text).toMatch(/^(¡Hola|Hola|Buenas) Laura! /);
    expect(text).toContain('Te recuerdo que mañana a las 18:00 tienes la llamada de valoración con Álex 📅 ¿Te sigue viniendo bien?');
  });

  it('24 h antes en México', () => {
    expect(reminderText({ ...base, timezone: MEXICO }, '24h')).toContain('mañana a las 10:00');
  });

  it('el saludo es estable para la misma cita', () => {
    expect(reminderText(base, '24h')).toBe(reminderText(base, '24h'));
  });

  it('1 h antes: hora exacta y cierre', () => {
    expect(reminderText(base, '1h')).toBe('Laura, en una hora (a las 18:00) es la llamada de valoración con Álex 🙌 ¡Hablamos enseguida!');
  });

  it('1 h antes con enlace', () => {
    expect(reminderText({ ...base, meetingUrl: 'https://zoom.us/j/1' }, '1h')).toBe('Laura, en una hora (a las 18:00) es la llamada de valoración con Álex 🙌 Te dejo el enlace: https://zoom.us/j/1');
  });

  it('sin emojis si el tono no los usa', () => {
    const tone = makeTone({ emojiUsage: 'none' });
    expect(countEmojis(reminderText({ ...base, tone }, '24h'))).toBe(0);
    expect(countEmojis(reminderText({ ...base, tone }, '1h'))).toBe(0);
  });
});

describe('noShowText', () => {
  it('tono cercano (formalidad ≤ 2)', () => {
    expect(noShowText(base)).toBe('Ey Laura, veo que finalmente no pudiste entrar a la llamada de valoración. ¿Todo bien? Si quieres, buscamos otro hueco.');
  });

  it('tono más formal', () => {
    expect(noShowText({ ...base, tone: makeTone({ formality: 4 }) })).toMatch(/^Hola Laura, veo que/);
  });

  it('sin nombre', () => {
    expect(noShowText({ ...base, leadName: '' })).toMatch(/^Ey, veo que/);
  });
});

describe('reminderTemplateParams', () => {
  it('fecha y hora para la plantilla de WhatsApp', () => {
    expect(reminderTemplateParams(base)).toEqual(['martes 6 de octubre a las 18:00']);
    expect(reminderTemplateParams({ ...base, timezone: MEXICO })).toEqual(['martes 6 de octubre a las 10:00']);
  });
});
