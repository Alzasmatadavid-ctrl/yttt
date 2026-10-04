import { analyzeHeuristically, matchOfferedSlot } from '../src/ai/analysis/analyzer.js';
import { decideDirective } from '../src/ai/setter/strategy.js';
import { normalize } from '../src/lib/text.js';
import { makeAnalysisInput, offeredAt, NOW, MADRID, makeBusinessContext, makeLeadContext, makeLead, qualificationOf } from '../test/unit/factories.js';
const an = (t: string, o: any = {}) => analyzeHeuristically(makeAnalysisInput(t, o));
console.log('--- optOut');
for (const t of ['No me escribiste ayer, por eso no contesté', 'No me mandes audios porfa, que no puedo escucharlos', 'Si no me escribes por aquí no me entero', 'No me escribas más tarde, que estoy currando', 'No me escribas ahora, que estoy en el curro', 'No me escribas más, por favor', 'No me escribas.', 'Dejad de escribirme', 'no quiero que me escribáis', 'No quiero que me escribas a estas horas', 'STOP', 'Dame de baja', 'borra mis datos'])
  console.log(an(t).flags.optOut, t);
console.log('--- slot');
const A = offeredAt('2026-10-06T18:00', MADRID, 'mañana a las 18:00'); const B = offeredAt('2026-10-08T10:00', MADRID, 'el jueves a las 10:00');
for (const t of ['¿A las 18:00 sería por videollamada?', '¿Las 18:00 es hora de Madrid?', 'A las 18:00 no sé si llego a tiempo', 'Mañana a las 18:00 tengo dentista', 'Uf, a las 10:00 trabajo', 'A las 18:00 perfecto', '¿Puede ser a las 18:00?', 'Vale, a las 18:00 que salgo del trabajo antes', 'La primera'])
  console.log(matchOfferedSlot(normalize(t), [A, B], MADRID, NOW, [A.id, B.id]), t);
console.log('--- decline');
const st = { callProposedAt: NOW.toISOString(), callDeclinedAt: NOW.toISOString() };
for (const t of ['Vale. Trabajo a turnos y ceno tarde', 'Me interesa sobre todo la parte de nutrición', 'Vale, hagamos la llamada', '¿La llamada es obligatoria?', 'Prefiero no decirlo']) {
  const a = an(t, { state: st });
  const lead = makeLead({ score: 70, qualification: qualificationOf({ goal: 'a', problem: 'b', motivation: 'c' }) });
  console.log(a.flags.wantsCall, a.flags.declinesCall, decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: st, analysis: a, kaiHasSpoken: true }).kind, t);
}
console.log('--- others');
for (const t of ['Lo tengo que hablar con ella primero', 'Tío, eres una máquina', '¿Eres una máquina?', 'Quiero hacer la operación bikini', 'Me siento muy pesada y quiero perder 8 kilos', 'Sois unos pesados', 'Quiero hablar con Álex', 'Te lo digo de corazón', 'Joder, qué difícil es adelgazar', 'No, al final no puedo', 'Quiero cancelar la llamada', 'Me ha surgido algo y no voy a poder'])
  { const f = an(t).flags; console.log(JSON.stringify({ h: f.humanRequest, bot: f.asksIfBot, med: f.medical, angry: f.angry, resch: f.wantsReschedule, cancel: f.wantsCancel }), t); }
