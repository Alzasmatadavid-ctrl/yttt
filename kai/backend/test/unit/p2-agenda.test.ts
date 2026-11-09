/**
 * Revisión nº 2 · agenda, automatizaciones y contexto de la IA (sin base de datos):
 * - El rango de búsqueda de huecos se recorta a lo reservable (nada de consultar Calendly durante años).
 * - Confirmación y recordatorios: la automatización y cada opción se respetan también al enviar.
 * - Trato «de usted» en los textos de la llamada (confirmación, recordatorios y no-show).
 * - Transparencia: una plantilla de WhatsApp no cuenta como “KAI ya se ha presentado”.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampSlotRange } from '../../src/calendar/availability.js';
import { appointmentMessageEnabled } from '../../src/automation/reminders.js';
import {
  confirmationText,
  DEFAULT_MESSAGE_TEMPLATES,
  DEFAULT_MESSAGE_TEMPLATES_USTED,
  defaultMessageTemplates,
  messageTemplateIssues,
  noShowText,
  reminderText,
  type AppointmentMessageKind,
} from '../../src/automation/messages.js';
import { leadHasSeenOurText } from '../../src/ai/context/context.js';
import { countEmojis } from '../../src/lib/text.js';
import { inbound, MADRID, makeMessage, makeTone, outbound } from './factories.js';

const DAY = 24 * 3600_000;

describe('rango de huecos recortado a lo reservable', () => {
  const now = new Date('2026-10-05T10:00:00.000Z');

  it('un rango de años se queda en [ahora, ahora + días de antelación máxima]', () => {
    const r = clampSlotRange({ from: new Date('2020-01-01T00:00:00Z'), to: new Date('2100-01-01T00:00:00Z') }, 14, now);
    expect(r.from.toISOString()).toBe(now.toISOString());
    expect(r.to.getTime()).toBe(now.getTime() + 14 * DAY);
  });

  it('sin rango, es exactamente ese intervalo', () => {
    const r = clampSlotRange(undefined, 7, now);
    expect(r).toEqual({ from: now, to: new Date(now.getTime() + 7 * DAY) });
  });

  it('un rango dentro del horizonte no cambia', () => {
    const from = new Date(now.getTime() + DAY);
    const to = new Date(now.getTime() + 3 * DAY);
    expect(clampSlotRange({ from, to }, 14, now)).toEqual({ from, to });
  });

  it('un rango del pasado o más allá del horizonte queda vacío (from >= to)', () => {
    const past = clampSlotRange({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') }, 14, now);
    expect(past.from.getTime()).toBeGreaterThanOrEqual(past.to.getTime());
    const far = clampSlotRange({ from: new Date(now.getTime() + 30 * DAY), to: new Date(now.getTime() + 40 * DAY) }, 14, now);
    expect(far.from.getTime()).toBeGreaterThanOrEqual(far.to.getTime());
  });
});

describe('¿se envía este mensaje de la llamada?', () => {
  const on = { enabled: true, config: {} };

  it('activada y sin desmarcar: sí (las opciones ausentes cuentan como activadas)', () => {
    for (const kind of ['confirmation', 'reminder24h', 'reminder1h'] as const) expect(appointmentMessageEnabled(on, kind)).toBe(true);
  });

  it('automatización desactivada o inexistente: nada', () => {
    for (const kind of ['confirmation', 'reminder24h', 'reminder1h'] as const) {
      expect(appointmentMessageEnabled({ enabled: false, config: { confirmation: true, reminder24h: true, reminder1h: true } }, kind)).toBe(false);
      expect(appointmentMessageEnabled(null, kind)).toBe(false);
    }
  });

  it('cada opción se respeta por separado', () => {
    const cfg = { enabled: true, config: { confirmation: false, reminder24h: true, reminder1h: false } };
    expect(appointmentMessageEnabled(cfg, 'confirmation')).toBe(false);
    expect(appointmentMessageEnabled(cfg, 'reminder24h')).toBe(true);
    expect(appointmentMessageEnabled(cfg, 'reminder1h')).toBe(false);
  });
});

describe('textos de la llamada de usted', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z')); // lunes 12:00 en Madrid
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const usted = {
    leadName: 'laura gómez',
    trainerName: 'Álex',
    callLabel: 'llamada de valoración',
    startsAt: new Date('2026-10-06T16:00:00.000Z'), // martes 6/10, 18:00 en Madrid
    timezone: MADRID,
    tone: makeTone({ emojiUsage: 'low', formality: 2, energy: 4, addressing: 'usted' }),
  };
  /** Formas de tú que no deben aparecer cuando el entrenador trata de usted. */
  const RX_TU = /\b(te|tienes|necesitas|dímelo|pudiste|quieres|ey|buenas)\b/i;

  it('confirmación: «le confirmo» y «si necesita cambiarla, dígamelo»', () => {
    const text = confirmationText(usted);
    expect(text).toBe('Laura, le confirmo la llamada de valoración con Álex el martes 6 de octubre a las 18:00 ✅ Si necesita cambiarla, dígamelo por aquí.');
    expect(confirmationText({ ...usted, leadName: '' })).toMatch(/^Le confirmo/);
  });

  it('recordatorios de 24 h y de 1 h sin tutear (con y sin enlace)', () => {
    for (const meetingUrl of [null, 'https://zoom.us/j/1']) {
      const r24 = reminderText({ ...usted, meetingUrl }, '24h');
      expect(r24).toMatch(/Le recuerdo que mañana a las 18:00 tiene la llamada de valoración con Álex/);
      expect(r24).toMatch(/¿Le sigue viniendo bien\?$/);
      expect(r24).not.toMatch(RX_TU);
      const r1 = reminderText({ ...usted, meetingUrl }, '1h');
      expect(r1).not.toMatch(RX_TU);
    }
    expect(reminderText({ ...usted, meetingUrl: 'https://zoom.us/j/1' }, '1h')).toBe(
      'Laura, en una hora (a las 18:00) es la llamada de valoración con Álex 🙌 Le dejo el enlace: https://zoom.us/j/1',
    );
  });

  it('no-show: «no pudo entrar», nunca «Ey»', () => {
    expect(noShowText(usted)).toBe('Hola Laura, veo que finalmente no pudo entrar a la llamada de valoración. ¿Va todo bien? Si quiere, buscamos otro hueco.');
    expect(noShowText({ ...usted, leadName: '' })).toMatch(/^Hola, veo que/);
  });

  it('sin emojis sigue siendo de usted y sin emojis', () => {
    const tone = makeTone({ emojiUsage: 'none', addressing: 'usted' });
    expect(countEmojis(confirmationText({ ...usted, tone }))).toBe(0);
    expect(confirmationText({ ...usted, tone })).toContain('a las 18:00. Si necesita cambiarla');
  });

  it('de tú no cambia nada', () => {
    const tu = { ...usted, tone: makeTone({ emojiUsage: 'low', formality: 2, addressing: 'tu' }) };
    expect(confirmationText(tu)).toMatch(/te confirmo .* Si necesitas cambiarla, dímelo por aquí\.$/);
    expect(noShowText(tu)).toMatch(/no pudiste entrar/);
  });

  it('el texto personalizado del entrenador se usa tal cual (no se “traduce”)', () => {
    expect(confirmationText(usted, 'Hola {nombre}, te espero {fecha} a las {hora}.')).toBe('Hola Laura, te espero mañana a las 18:00.');
  });

  it('los textos por defecto de usted son válidos y se eligen según el tono', () => {
    for (const [kind, text] of Object.entries(DEFAULT_MESSAGE_TEMPLATES_USTED) as [AppointmentMessageKind, string][]) {
      expect(messageTemplateIssues(kind, text), kind).toEqual([]);
      expect(text, kind).not.toMatch(RX_TU);
    }
    expect(defaultMessageTemplates(makeTone({ addressing: 'usted' }))).toBe(DEFAULT_MESSAGE_TEMPLATES_USTED);
    expect(defaultMessageTemplates(makeTone({ addressing: 'tu' }))).toBe(DEFAULT_MESSAGE_TEMPLATES);
    expect(defaultMessageTemplates(null)).toBe(DEFAULT_MESSAGE_TEMPLATES);
  });
});

describe('transparencia: ¿el lead ya ha leído un mensaje nuestro?', () => {
  const template = makeMessage({
    direction: 'outbound',
    senderType: 'kai',
    contentType: 'template',
    content: '[Plantilla «hola_lead»] Laura',
    metadata: { intendedText: '¡Hola Laura! Soy KAI, el asistente virtual del equipo de Álex.' },
  });

  it('solo una plantilla de primer contacto: todavía no (KAI tiene que presentarse en su primer texto)', () => {
    expect(leadHasSeenOurText([template])).toBe(false);
    expect(leadHasSeenOurText([template, inbound('Hola! Sí, quiero perder peso para el verano')])).toBe(false);
  });

  it('con un texto libre ya enviado: sí', () => {
    expect(leadHasSeenOurText([template, inbound('Hola'), outbound('¡Hola Laura! Soy KAI…')])).toBe(true);
  });

  it('conversación sin mensajes nuestros: no', () => {
    expect(leadHasSeenOurText([])).toBe(false);
    expect(leadHasSeenOurText([inbound('Hola')])).toBe(false);
  });
});
