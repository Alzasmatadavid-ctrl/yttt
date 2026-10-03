import { describe, expect, it } from 'vitest';
import { cleanReply, joinLabels } from '../../src/ai/setter/agents.js';

describe('joinLabels', () => {
  it('una sola etiqueta se devuelve tal cual', () => {
    expect(joinLabels(['mañana a las 18:00'])).toBe('mañana a las 18:00');
  });

  it('dos horarios del mismo día no repiten el día', () => {
    expect(joinLabels(['mañana a las 18:00', 'mañana a las 19:30'])).toBe('mañana a las 18:00 o a las 19:30');
  });

  it('tres horarios del mismo día', () => {
    expect(joinLabels(['pasado mañana a las 10:00', 'pasado mañana a las 12:00', 'pasado mañana a las 17:00'])).toBe(
      'pasado mañana a las 10:00, a las 12:00 o a las 17:00',
    );
  });

  it('días distintos se enumeran completos', () => {
    expect(joinLabels(['mañana a las 18:00', 'el jueves 8 a las 10:00'])).toBe('mañana a las 18:00 o el jueves 8 a las 10:00');
    expect(joinLabels(['hoy a las 18:00', 'mañana a las 10:00', 'el jueves 8 a las 10:00'])).toBe('hoy a las 18:00, mañana a las 10:00 o el jueves 8 a las 10:00');
  });

  it('etiquetas sin el formato “… a las HH:mm” se unen sin agrupar', () => {
    expect(joinLabels(['el lunes por la mañana', 'el martes por la tarde'])).toBe('el lunes por la mañana o el martes por la tarde');
  });

  // BUG (latente): joinLabels([]) lanza TypeError. En RuleBasedSetterAgent (caso clarify_slot) las variantes se
  // calculan ANTES de comprobar labels.length, así que el texto alternativo para “sin etiquetas” nunca llega a usarse.
  it.fails('BUG: una lista vacía no debería lanzar una excepción', () => {
    expect(() => joinLabels([])).not.toThrow();
  });
});

describe('cleanReply', () => {
  it('quita espacios y prefijos tipo “KAI:”', () => {
    expect(cleanReply('  KAI: Hola Laura, ¿qué tal?  ')).toBe('Hola Laura, ¿qué tal?');
    expect(cleanReply('Respuesta: Perfecto')).toBe('Perfecto');
    expect(cleanReply('asistente : vale')).toBe('vale');
    expect(cleanReply('Mensaje: ok')).toBe('ok');
  });

  it('quita comillas envolventes de cualquier tipo', () => {
    expect(cleanReply('"Hola, ¿qué tal?"')).toBe('Hola, ¿qué tal?');
    expect(cleanReply('“Hola, ¿qué tal?”')).toBe('Hola, ¿qué tal?');
    expect(cleanReply('«Hola»')).toBe('Hola');
    expect(cleanReply('"Hola\nqué tal"')).toBe('Hola\nqué tal');
  });

  it('quita prefijo y comillas juntos', () => {
    expect(cleanReply('KAI: "Hola Laura"')).toBe('Hola Laura');
  });

  it('no toca comillas internas ni textos normales', () => {
    expect(cleanReply('Me dijiste "sin prisa", ¿verdad?')).toBe('Me dijiste "sin prisa", ¿verdad?');
    expect(cleanReply('Kaizen es mi filosofía')).toBe('Kaizen es mi filosofía');
  });

  // BUG (menor): si el mensaje EMPIEZA y TERMINA con citas distintas, se recortan sus comillas y queda descuadrado.
  it.fails('BUG: no recorta un mensaje que empieza y termina con dos citas distintas', () => {
    const text = '"Poco a poco" es mi lema, y el tuyo será "lo conseguí"';
    expect(cleanReply(text)).toBe(text);
  });
});
