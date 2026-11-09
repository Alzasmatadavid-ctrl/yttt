/**
 * Revisión de regresiones de la ronda 3 — grupo «resto»: un saludo solo no es cortesía de despedida.
 */
import { describe, expect, it } from 'vitest';
import { isCourtesyOnly } from '../../src/crm/opt-out.js';

describe('isCourtesyOnly: los saludos de apertura no son cortesía', () => {
  it.each(['Buenas tardes', 'Buenos días', 'Buenas', 'Muy buenas tardes', 'Buenas noches', 'Muy buenas', 'Buen día', 'Buenas, buenas'])(
    '«%s» no es solo cortesía (puede ser el comienzo de una conversación)',
    (text) => {
      expect(isCourtesyOnly(text)).toBe(false);
    },
  );

  it.each(['Gracias, buenas noches', 'Igualmente, buenas tardes', 'Buenas noches y gracias por todo', 'Vale, un saludo', 'A ti', 'Muy bien, gracias'])(
    '«%s» sigue siendo cortesía (despedida o agradecimiento)',
    (text) => {
      expect(isCourtesyOnly(text)).toBe(true);
    },
  );
});
