import { validateReply } from '../src/ai/validation/output-validator.js';
import { DateTime } from 'luxon';
const tz = 'Europe/Madrid';
const allowed = [DateTime.fromISO('2026-10-06T18:00', { zone: tz }).toJSDate()]; // martes
const ctx = { tone: { formality: 2, energy: 3, directness: 3, emojiUsage: 'low', messageLength: 'short', addressing: 'tu' } as any, wordsToAvoid: [], timezone: tz, allowedTimes: allowed, allowedPricesCents: [15000], currencies: ['EUR'], allowedUrls: [], factsText: '', now: new Date('2026-10-05T10:00:00Z') };
for (const t of [
  '¿Te va bien el jueves sobre las 17?', '¿Quedamos el miércoles 17h?', '¿Te viene bien el sábado a las 18:00?', 'Son 150 dólares al mes', 'Cuesta $150 al mes',
  '¿Te va bien el martes a las 18:00?', '¿Te va bien mañana a las 18:00?', '¿Te va bien hoy a las 18:00?', 'Mañana tengo las 18:00, ¿te va?', 'Tengo el martes 6 a las 18:00', 'A las 6 de la tarde del martes, ¿te va?', 'A las 6 de la mañana del martes, ¿te va?',
  'El programa son 12 semanas y entrenas 3 días', 'Son las 12 semanas del programa', 'Cuesta 150 € al mes', 'El precio es de 150 al mes', 'El programa cuesta 199 al mes', 'Te respondo en 2h', 'Entrena las 2 primeras semanas suave', 'a las seis te va bien?', '¿Te va a las dos de la tarde?', 'Tienes las dos opciones', 'entre las 17 y las 19 tengo hueco', 'Te escribo a la una',
  'Son 150 MXN', '¿Te va bien el 8 a las 18:00?', '¿Te va bien el 6 a las 18:00?',
]) console.log(JSON.stringify(t), '=>', JSON.stringify(validateReply(t, ctx as any).issues));
console.log(validateReply('Te escribo mañana para confirmar lo de las 18:00 del martes', ctx as any).issues);
console.log(validateReply('Te escribo hoy para confirmar lo de las 18:00 del jueves', ctx as any).issues);
