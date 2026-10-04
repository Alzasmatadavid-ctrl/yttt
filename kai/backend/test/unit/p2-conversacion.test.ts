import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { decideDirective } from '../../src/ai/setter/strategy.js';
import { validateReply } from '../../src/ai/validation/output-validator.js';
import { hasSeveralQuestions } from '../../src/lib/domain.js';
import { makeAnalysisInput, makeAppointment, makeBusinessContext, makeLead, makeLeadContext, makeValidationContext, offeredAt, outbound, NOW, qualificationOf } from './factories.js';

const appt = makeAppointment();
function run(text: string, state: any = {}, history: any[] = [], leadOverrides: any = {}) {
  const lead = makeLead(leadOverrides);
  const a = analyzeHeuristically(makeAnalysisInput(text, { state, history, lead }));
  const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead, upcomingAppointment: appt }), state, analysis: a, kaiHasSpoken: true });
  return { a, d };
}
describe('explore', () => {
  it('f0', () => {
    for (const t of ['Me lo he pensado y prefiero no hacer la llamada', 'No me interesa la llamada', 'No necesito la llamada, gracias', 'Mejor otro día, ¿tienes el lunes?', '¿Y el viernes por la tarde?']) {
      const { a, d } = run(t);
      console.log('F0', t, a.flags.declinesCall, a.flags.wantsReschedule, a.flags.wantsCancel, d.kind);
    }
  });
  it('f2', () => {
    for (const t of ['No me viene bien', 'No, al final no me va bien', 'Uf, no, mañana no me cuadra', 'Pues no, no puedo', 'No me va bien a esa hora', 'No']) {
      const { a, d } = run(t);
      console.log('F2', t, a.flags.wantsReschedule, a.flags.wantsCancel, d.kind);
    }
  });
  it('f1', () => {
    const A = offeredAt('2026-10-06T11:00'); const B = offeredAt('2026-10-06T17:00');
    const st = { offeredSlots: [A, B], lastOfferIds: [A.id, B.id], offeredAt: NOW.toISOString(), callProposedAt: NOW.toISOString() };
    const h = [outbound('Mañana tengo a las 11:00 o a las 17:00. ¿Cuál te viene mejor?'), outbound('Lo entiendo, con poco tiempo es cuando más hay que organizarse bien. ¿Cuántos días a la semana podrías sacar aunque fuera un rato?')];
    for (const t of ['5', '3', '17', '5 de la tarde', 'a las 5']) {
      const a = analyzeHeuristically(makeAnalysisInput(t, { state: st, history: h }));
      console.log('F1', t, a.selectedSlotId === B.id ? 'B' : a.selectedSlotId === A.id ? 'A' : a.selectedSlotId);
    }
  });
  it('f4', () => {
    const t = 'Perfecto. ¿Qué objetivo tienes, cuánto pesas, qué edad tienes y cuánto tiempo llevas entrenando?';
    console.log('F4', JSON.stringify(validateReply(t, makeValidationContext())), hasSeveralQuestions(t));
  });
  it('f5', () => {
    for (const t of ['¿Estoy hablando con un bot?', '¿Es un bot?', '¿Esto es un bot?', '¿Hablo con una persona?', '¿Me contesta una persona o un bot?', '¿Estoy hablando con una persona real?']) {
      const a = analyzeHeuristically(makeAnalysisInput(t, { state: { lastAskedKey: 'current_situation' } }));
      console.log('F5', t, a.flags.asksIfBot, a.flags.humanRequest, JSON.stringify(Object.keys(a.qualification)));
    }
  });
  it('f8', () => {
    const lead = makeLead({ signals: { fit: 'no' } });
    const a = analyzeHeuristically(makeAnalysisInput('¿Cuánto cuesta?', { lead }));
    const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state: { priceAskedCount: 2 }, analysis: a, kaiHasSpoken: true });
    console.log('F8', d.kind);
  });
});
