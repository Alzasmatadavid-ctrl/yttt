/**
 * Lead scoring determinista y configurable.
 *
 * La IA solo EXTRAE información (objetivo, urgencia, compromiso…). La puntuación se calcula
 * aquí con los pesos que el entrenador configura, para que sea explicable y no “inventada”.
 * La puntuación es interna: nunca se muestra al lead.
 */
import type { LeadQualification, LeadSignals, LeadTemperature, ScoreBand } from '../lib/domain.js';
import { DEFAULT_SCORE_BANDS } from '../lib/domain.js';

export interface ScoringRule {
  key: string;
  weight: number;
  enabled: boolean;
  required?: boolean;
}

export interface ScoreBreakdownItem {
  key: string;
  weight: number;
  earned: number;
}

const LEVEL_STRENGTH: Record<string, number> = { high: 1, medium: 0.6, low: 0.2, yes: 1, maybe: 0.5, no: 0, unknown: 0.3 };

function strengthFor(key: string, qualification: LeadQualification, signals: LeadSignals): number {
  const item = qualification[key];
  const signalLevel = (signals as Record<string, string | undefined>)[key];
  const level = signalLevel ?? item?.level;
  if (['urgency', 'commitment', 'budget', 'fit'].includes(key)) {
    if (level && level in LEVEL_STRENGTH) return LEVEL_STRENGTH[level];
    return item?.value ? 0.4 : 0;
  }
  if (!item || !item.value) return 0;
  return Math.min(1, Math.max(0.3, item.confidence ?? 0.7));
}

export function computeScore(
  rules: ScoringRule[],
  qualification: LeadQualification,
  signals: LeadSignals,
): { score: number; breakdown: ScoreBreakdownItem[] } {
  const enabled = rules.filter((r) => r.enabled && r.weight > 0);
  const total = enabled.reduce((s, r) => s + r.weight, 0);
  if (total === 0) return { score: 0, breakdown: [] };
  const breakdown = enabled.map((r) => {
    const earned = r.weight * strengthFor(r.key, qualification, signals);
    return { key: r.key, weight: r.weight, earned: Math.round(earned * 10) / 10 };
  });
  let score = Math.round((100 * breakdown.reduce((s, b) => s + b.earned, 0)) / total);
  // Topes: si no encaja o no puede invertir, nunca debe aparecer como lead prioritario.
  if (signals.fit === 'no') score = Math.min(score, 25);
  if (signals.budget === 'no') score = Math.min(score, 45);
  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

export function temperatureFor(score: number, bands: ScoreBand[] = DEFAULT_SCORE_BANDS): LeadTemperature {
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  let found: LeadTemperature = sorted[0]?.key ?? 'frio';
  for (const band of sorted) if (score >= band.min) found = band.key;
  return found;
}

export function bandMin(bands: ScoreBand[], key: LeadTemperature, fallback: number) {
  return bands.find((b) => b.key === key)?.min ?? fallback;
}

/** ¿Tiene el lead la información mínima obligatoria? */
export function requiredCaptured(rules: ScoringRule[], qualification: LeadQualification): boolean {
  return rules.filter((r) => r.enabled && r.required).every((r) => Boolean(qualification[r.key]?.value));
}

/** Valida que las bandas cubren 0–100 sin huecos ni solapes. */
export function validateBands(bands: ScoreBand[]): string | null {
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  if (sorted.length === 0) return 'Debe existir al menos una banda.';
  if (sorted[0].min !== 0) return 'La primera banda debe empezar en 0.';
  if (sorted[sorted.length - 1].max !== 100) return 'La última banda debe terminar en 100.';
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].min > sorted[i].max) return `La banda "${sorted[i].label}" tiene el mínimo mayor que el máximo.`;
    if (i > 0 && sorted[i].min !== sorted[i - 1].max + 1) return 'Las bandas deben ser consecutivas, sin huecos ni solapes.';
  }
  return null;
}
