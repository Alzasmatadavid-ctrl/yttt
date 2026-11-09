/**
 * Revisión nº5 — grupo «mensajería»: mensajes de cortesía de un lead dado de baja.
 */
import { describe, expect, it } from 'vitest';
import { isCourtesyOnly } from '../../src/crm/opt-out.js';

describe('isCourtesyOnly (cortesía o despedida, sin nada que contestar)', () => {
  it.each([
    'Gracias',
    'Gracias, igualmente',
    'Muchas gracias!!',
    'Vale, un saludo',
    'ok 👍',
    '👍',
    '🙏🏻',
    'Igualmente, mucho ánimo a vosotros también',
    'De nada, adiós',
    'Perfecto, gracias por todo',
    'Sí, gracias. Hasta luego',
  ])('«%s» es solo cortesía', (text) => {
    expect(isCourtesyOnly(text)).toBe(true);
  });

  it.each([
    '',
    'Gracias, ¿y cuánto cuesta?',
    '?',
    'Gracias, pero me lo he pensado',
    'Vale, quiero la llamada',
    'Me interesa',
    '[📷 Imagen]',
    'No',
    'gracias '.repeat(12),
  ])('«%s» no es solo cortesía', (text) => {
    expect(isCourtesyOnly(text)).toBe(false);
  });
});
