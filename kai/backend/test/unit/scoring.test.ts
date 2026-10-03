import { describe, expect, it } from 'vitest';
import { bandMin, computeScore, requiredCaptured, temperatureFor, validateBands } from '../../src/crm/scoring.js';
import { DEFAULT_SCORE_BANDS, type LeadQualification, type QualificationItem, type ScoreBand } from '../../src/lib/domain.js';
import { makeRules, qItem, qualificationOf, rule } from './factories.js';

const ALL_KEYS = ['goal', 'current_situation', 'problem', 'motivation', 'previous_attempts', 'frustration', 'urgency', 'commitment', 'budget', 'fit'];

function fullQualification(confidence = 1): LeadQualification {
  return Object.fromEntries(ALL_KEYS.map((k) => [k, qItem(`valor de ${k}`, { confidence })]));
}

describe('computeScore', () => {
  it('sin reglas activas devuelve 0 y desglose vacío', () => {
    expect(computeScore([], {}, {})).toEqual({ score: 0, breakdown: [] });
    expect(computeScore([rule('goal', 10, { enabled: false }), rule('problem', 0)], qualificationOf({ goal: 'x' }), {})).toEqual({
      score: 0,
      breakdown: [],
    });
  });

  it('lead vacío con las reglas por defecto puntúa 0', () => {
    const { score, breakdown } = computeScore(makeRules(), {}, {});
    expect(score).toBe(0);
    expect(breakdown).toHaveLength(10);
    expect(breakdown.every((b) => b.earned === 0)).toBe(true);
  });

  it('lead completo y con señales máximas puntúa 100 (los pesos por defecto suman 100)', () => {
    const rules = makeRules();
    expect(rules.reduce((s, r) => s + r.weight, 0)).toBe(100);
    const { score } = computeScore(rules, fullQualification(), { urgency: 'high', commitment: 'high', budget: 'yes', fit: 'yes' });
    expect(score).toBe(100);
  });

  it('aplica los pesos de cada regla de forma proporcional', () => {
    const { score, breakdown } = computeScore([rule('goal', 40), rule('problem', 60)], {
      goal: qItem('perder 10 kilos', { confidence: 1 }),
      problem: qItem('no tengo tiempo', { confidence: 0.5 }),
    }, {});
    expect(breakdown).toEqual([
      { key: 'goal', weight: 40, earned: 40 },
      { key: 'problem', weight: 60, earned: 30 },
    ]);
    expect(score).toBe(70);
  });

  it('normaliza sobre el total de pesos activos (no sobre 100)', () => {
    const { score } = computeScore([rule('goal', 5), rule('problem', 5)], { goal: qItem('x', { confidence: 1 }) }, {});
    expect(score).toBe(50);
  });

  it('ignora reglas desactivadas y reglas con peso 0', () => {
    const rules = [rule('goal', 50), rule('problem', 50, { enabled: false }), rule('motivation', 0)];
    const { score, breakdown } = computeScore(rules, { goal: qItem('x', { confidence: 1 }) }, {});
    expect(score).toBe(100);
    expect(breakdown.map((b) => b.key)).toEqual(['goal']);
  });

  it('acota la confianza de las variables de texto entre 0.3 y 1 (0.7 si no viene)', () => {
    const r = [rule('goal', 100)];
    expect(computeScore(r, { goal: qItem('x', { confidence: 0.1 }) }, {}).score).toBe(30);
    expect(computeScore(r, { goal: qItem('x', { confidence: 5 }) }, {}).score).toBe(100);
    const noConfidence = { value: 'x', updatedAt: '2026-10-01T00:00:00Z' } as unknown as QualificationItem;
    expect(computeScore(r, { goal: noConfidence }, {}).score).toBe(70);
  });

  it('una variable de texto sin valor no suma', () => {
    expect(computeScore([rule('goal', 100)], { goal: qItem('') }, {}).score).toBe(0);
  });

  it.each([
    ['urgency', 'high', 100],
    ['urgency', 'medium', 60],
    ['urgency', 'low', 20],
    ['commitment', 'high', 100],
    ['commitment', 'medium', 60],
    ['budget', 'yes', 100],
    ['budget', 'maybe', 50],
    ['budget', 'no', 0],
    ['fit', 'yes', 100],
    ['fit', 'unknown', 30],
    ['fit', 'no', 0],
  ])('nivel %s=%s aporta %i puntos sobre 100', (key, level, expected) => {
    const { score } = computeScore([rule(key, 100)], {}, { [key]: level });
    expect(score).toBe(expected);
  });

  it('la señal del lead tiene prioridad sobre el nivel guardado en la cualificación', () => {
    const qualification = { urgency: qItem('algún día', { level: 'low' }) };
    expect(computeScore([rule('urgency', 100)], qualification, { urgency: 'high' }).score).toBe(100);
  });

  it('usa el nivel de la cualificación si no hay señal', () => {
    const qualification = { commitment: qItem('lo intentaré', { level: 'medium' }) };
    expect(computeScore([rule('commitment', 100)], qualification, {}).score).toBe(60);
  });

  it('una variable de nivel con valor pero sin nivel reconocido aporta 0.4', () => {
    expect(computeScore([rule('budget', 100)], { budget: qItem('ya veremos') }, {}).score).toBe(40);
    expect(computeScore([rule('budget', 100)], {}, {}).score).toBe(0);
  });

  it('calcula un caso mixto realista con las reglas por defecto', () => {
    const qualification = {
      goal: qItem('perder 10 kilos', { confidence: 0.8 }),
      problem: qItem('no tengo tiempo', { confidence: 0.6 }),
      motivation: qItem('mi boda', { confidence: 1 }),
    };
    // 8 + 6 + 12 + urgencia media 14·0.6=8.4 + presupuesto “quizá” 12·0.5=6 + encaje desconocido 10·0.3=3 = 43.4
    const { score, breakdown } = computeScore(makeRules(), qualification, { urgency: 'medium', budget: 'maybe', fit: 'unknown' });
    expect(score).toBe(43);
    expect(breakdown.find((b) => b.key === 'urgency')?.earned).toBe(8.4);
    expect(temperatureFor(score)).toBe('curioso');
  });

  it('redondea lo ganado por regla a un decimal', () => {
    const { breakdown } = computeScore([rule('goal', 7)], { goal: qItem('x', { confidence: 0.33 }) }, {});
    expect(breakdown[0].earned).toBe(2.3);
  });

  describe('topes', () => {
    const allMax = { urgency: 'high', commitment: 'high', budget: 'yes', fit: 'yes' } as const;

    it('si no encaja (fit=no) nunca supera 25', () => {
      const { score } = computeScore(makeRules(), fullQualification(), { ...allMax, fit: 'no' });
      expect(score).toBe(25);
    });

    it('si no puede invertir (budget=no) nunca supera 45', () => {
      const { score } = computeScore(makeRules(), fullQualification(), { ...allMax, budget: 'no' });
      expect(score).toBe(45);
    });

    it('con ambos topes se aplica el más restrictivo', () => {
      const { score } = computeScore(makeRules(), fullQualification(), { ...allMax, budget: 'no', fit: 'no' });
      expect(score).toBe(25);
    });

    it('los topes no suben una puntuación ya baja', () => {
      const { score } = computeScore([rule('goal', 50), rule('fit', 50)], { goal: qItem('x', { confidence: 0.3 }) }, { fit: 'no' });
      expect(score).toBe(15);
    });
  });
});

describe('temperatureFor', () => {
  it.each([
    [0, 'frio'],
    [30, 'frio'],
    [31, 'curioso'],
    [50, 'curioso'],
    [51, 'interesado'],
    [70, 'interesado'],
    [71, 'caliente'],
    [85, 'caliente'],
    [86, 'muy_cualificado'],
    [100, 'muy_cualificado'],
  ])('con las bandas por defecto, %i → %s', (score, expected) => {
    expect(temperatureFor(score)).toBe(expected);
  });

  it('respeta bandas personalizadas aunque vengan desordenadas', () => {
    const bands: ScoreBand[] = [
      { key: 'caliente', label: 'Caliente', min: 61, max: 100 },
      { key: 'frio', label: 'Frío', min: 0, max: 40 },
      { key: 'interesado', label: 'Interesado', min: 41, max: 60 },
    ];
    expect(temperatureFor(40, bands)).toBe('frio');
    expect(temperatureFor(41, bands)).toBe('interesado');
    expect(temperatureFor(61, bands)).toBe('caliente');
  });

  it('una puntuación por debajo de la primera banda cae en la primera', () => {
    expect(temperatureFor(-5)).toBe('frio');
  });

  it('sin bandas devuelve “frio”', () => {
    expect(temperatureFor(90, [])).toBe('frio');
  });
});

describe('bandMin', () => {
  it('devuelve el mínimo de la banda o el valor por defecto', () => {
    expect(bandMin(DEFAULT_SCORE_BANDS, 'caliente', 0)).toBe(71);
    expect(bandMin(DEFAULT_SCORE_BANDS, 'interesado', 0)).toBe(51);
    expect(bandMin([], 'caliente', 71)).toBe(71);
  });
});

describe('validateBands', () => {
  const band = (key: ScoreBand['key'], min: number, max: number): ScoreBand => ({ key, label: key, min, max });

  it('acepta las bandas por defecto', () => {
    expect(validateBands(DEFAULT_SCORE_BANDS)).toBeNull();
  });

  it('acepta bandas válidas aunque vengan desordenadas', () => {
    expect(validateBands([band('caliente', 51, 100), band('frio', 0, 50)])).toBeNull();
  });

  it('exige al menos una banda', () => {
    expect(validateBands([])).toMatch(/al menos una banda/);
  });

  it('la primera banda debe empezar en 0', () => {
    expect(validateBands([band('frio', 1, 50), band('caliente', 51, 100)])).toMatch(/empezar en 0/);
  });

  it('la última banda debe terminar en 100', () => {
    expect(validateBands([band('frio', 0, 50), band('caliente', 51, 99)])).toMatch(/terminar en 100/);
  });

  it('detecta una banda con mínimo mayor que máximo', () => {
    expect(validateBands([band('frio', 0, 30), band('curioso', 31, 10), band('caliente', 32, 100)])).toMatch(/mínimo mayor que el máximo/);
  });

  it('detecta huecos entre bandas', () => {
    expect(validateBands([band('frio', 0, 30), band('caliente', 40, 100)])).toMatch(/sin huecos ni solapes/);
  });

  it('detecta solapes entre bandas', () => {
    expect(validateBands([band('frio', 0, 50), band('caliente', 40, 100)])).toMatch(/sin huecos ni solapes/);
  });
});

describe('requiredCaptured', () => {
  const rules = [rule('goal', 10, { required: true }), rule('problem', 10, { required: true }), rule('budget', 10), rule('motivation', 10, { required: true, enabled: false })];

  it('es verdadero cuando todas las reglas obligatorias activas tienen valor', () => {
    expect(requiredCaptured(rules, qualificationOf({ goal: 'perder grasa', problem: 'tiempo' }))).toBe(true);
  });

  it('es falso si falta alguna obligatoria o está vacía', () => {
    expect(requiredCaptured(rules, qualificationOf({ goal: 'perder grasa' }))).toBe(false);
    expect(requiredCaptured(rules, qualificationOf({ goal: 'perder grasa', problem: '' }))).toBe(false);
  });

  it('ignora las obligatorias desactivadas y las opcionales', () => {
    expect(requiredCaptured(rules, qualificationOf({ goal: 'x', problem: 'y' }))).toBe(true);
  });

  it('sin reglas obligatorias siempre es verdadero', () => {
    expect(requiredCaptured([rule('goal', 10)], {})).toBe(true);
  });

  it('con las reglas por defecto exige objetivo, problema y motivación', () => {
    const defaults = makeRules();
    expect(requiredCaptured(defaults, qualificationOf({ goal: 'a', problem: 'b' }))).toBe(false);
    expect(requiredCaptured(defaults, qualificationOf({ goal: 'a', problem: 'b', motivation: 'c' }))).toBe(true);
  });
});
