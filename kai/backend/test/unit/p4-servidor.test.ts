/**
 * Revisión nº4 — grupo «servidor» (pruebas unitarias): formas naturales de pedir hablar en el modo sin IA y
 * comparación de teléfonos (un número de otro país que acaba igual no es el mismo).
 */
import { describe, expect, it } from 'vitest';
import { analyzeHeuristically } from '../../src/ai/analysis/analyzer.js';
import { decideDirective } from '../../src/ai/setter/strategy.js';
import { countryCodeForTimezone, internationalDigits, samePhoneNumber } from '../../src/integrations/channels/phone.js';
import { NOW, makeAnalysisInput, makeBusinessContext, makeLead, makeLeadContext } from './factories.js';

const flagsOf = (...args: Parameters<typeof makeAnalysisInput>) => analyzeHeuristically(makeAnalysisInput(...args)).flags;

describe('Modo sin IA: «¿Podemos hablar?» es pedir la llamada', () => {
  it.each([
    '¿Podemos hablar?',
    '¿Cuándo hablamos?',
    'Vale, ¿cuándo podríamos hablar?',
    '¿Podríamos hablar mañana?',
    '¿Hablamos?',
    'Vale, ¿hablamos?',
    '¿Podemos hablar por teléfono?',
    'Prefiero hablar por teléfono',
    '¿Quedamos para hablar?',
    '¿Qué día hablamos?',
  ])('«%s» → quiere la llamada', (text) => {
    const flags = flagsOf(text);
    expect(flags.wantsCall).toBe(true);
    expect(flags.declinesCall).toBe(false);
  });

  it.each([
    'Hablamos por aquí mejor',
    '¿Podemos hablar por WhatsApp?',
    '¿Podemos hablar del precio?',
    '¿Podemos hablar sobre el plan?',
    'Ahora no podemos hablar',
    'Podemos hablar más tarde',
    'Hoy no puedo hablar por teléfono',
    '¿Cuándo hablamos de lo de la dieta?',
    'Prefiero no hablar por teléfono',
  ])('«%s» → no es pedir la llamada', (text) => {
    expect(flagsOf(text).wantsCall).toBe(false);
  });

  it('tras rechazar la llamada, pedir hablar sí vuelve a abrir la agenda', () => {
    expect(flagsOf('¿Podemos hablar?', { state: { callDeclinedAt: NOW.toISOString() } as never }).wantsCall).toBe(true);
  });

  it('a mitad de la cualificación, la estrategia ofrece horarios en vez de repetir la pregunta anterior', () => {
    const lead = makeLead({ qualification: { goal: { value: 'perder 8 kilos', confidence: 0.8, updatedAt: NOW.toISOString() } } });
    const state = { lastAskedKey: 'problem', askCounts: { problem: 1 } };
    const analysis = analyzeHeuristically(makeAnalysisInput('¿Podemos hablar?', { lead, state }));
    const d = decideDirective({ biz: makeBusinessContext(), leadCtx: makeLeadContext({ lead }), state, analysis, kaiHasSpoken: true, now: NOW });
    expect(d.kind).toBe('offer_slots');
    expect(d.needsSlots).toBe(true);
  });
});

describe('¿Es el mismo número de teléfono?', () => {
  const ES = countryCodeForTimezone('Europe/Madrid');
  const MX = countryCodeForTimezone('America/Mexico_City');

  it('un número de otro país que acaba igual NO es el mismo', () => {
    expect(samePhoneNumber('+34 612 345 678', '+33612345678', ES)).toBe(false);
    expect(samePhoneNumber('612 345 678', '+33612345678', ES)).toBe(false);
    expect(samePhoneNumber('+56 9 1234 5678', '+51912345678', ES)).toBe(false);
  });

  it('el mismo número con o sin prefijo, con «00» o con otro formato sí lo es', () => {
    expect(samePhoneNumber('612 345 678', '+34612345678', ES)).toBe(true);
    expect(samePhoneNumber('0034 612 345 678', '+34 612-345-678', ES)).toBe(true);
    expect(samePhoneNumber('34612345678', '+34612345678', ES)).toBe(true);
  });

  it('móviles de México y Argentina: el formato de WhatsApp (521…, 549…) es el mismo número', () => {
    expect(samePhoneNumber('+52 55 1234 5678', '+5215512345678', MX)).toBe(true);
    expect(samePhoneNumber('55 1234 5678', '+5215512345678', MX)).toBe(true);
    expect(samePhoneNumber('+54 11 1234 5678', '+5491112345678', ES)).toBe(true);
    expect(internationalDigits('+5215512345678', null)).toBe('525512345678');
  });

  it('sin país conocido y sin prefijo, se comparan los últimos 9 dígitos (como antes)', () => {
    expect(countryCodeForTimezone('Europe/Paris')).toBeNull();
    expect(internationalDigits('0612345678', null)).toBeNull();
    expect(samePhoneNumber('0612345678', '+33612345678', null)).toBe(true);
    expect(samePhoneNumber('0612345678', '0612345679', null)).toBe(false);
  });
});
