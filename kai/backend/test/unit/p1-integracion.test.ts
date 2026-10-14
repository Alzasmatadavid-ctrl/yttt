/**
 * Revisión nº 1 · integración del backend (sin base de datos).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasSeveralQuestions, ONE_QUESTION_MESSAGE, type ConversationState } from '../../src/lib/domain.js';
import { DEFAULT_QUALIFICATION_RULES } from '../../src/config/defaults.js';
import { perBusinessRateLimit } from '../../src/auth/guards.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('una sola pregunta por variable de cualificación', () => {
  it('detecta textos con más de un «?»', () => {
    expect(hasSeveralQuestions('¿Por qué ahora? ¿Hay alguna fecha?')).toBe(true);
    expect(hasSeveralQuestions('¿Hay alguna fecha o motivo que te haga querer empezar ahora?')).toBe(false);
    expect(hasSeveralQuestions('')).toBe(false);
    expect(ONE_QUESTION_MESSAGE).toBe('Escribe una sola pregunta: KAI hace solo una pregunta por mensaje.');
  });

  it('las preguntas por defecto cumplen la regla (si no, el entrenador no podría guardarlas)', () => {
    for (const r of DEFAULT_QUALIFICATION_RULES) expect(hasSeveralQuestions(r.question), r.key).toBe(false);
  });
});

describe('estado de la conversación', () => {
  it('incluye las marcas de la llamada rechazada y de las dudas ya resueltas', () => {
    const state: ConversationState = { callDeclinedAt: new Date().toISOString(), callReassuredAt: new Date().toISOString() };
    expect(Object.keys(state)).toEqual(['callDeclinedAt', 'callReassuredAt']);
  });
});

describe('límite de peticiones por negocio', () => {
  it('lee el máximo en cada petición y usa la IP si no hay sesión', async () => {
    let max = 5;
    const { config } = perBusinessRateLimit(() => max);
    expect(config.rateLimit.max()).toBe(5);
    max = 2;
    expect(config.rateLimit.max()).toBe(2);
    const anonymous = { headers: {}, ip: '10.0.0.7', authUser: null, tenant: null } as unknown as Parameters<typeof config.rateLimit.keyGenerator>[0];
    expect(await config.rateLimit.keyGenerator(anonymous)).toBe('ip:10.0.0.7');
    const member = { tenant: { businessId: 'b1', permissions: [] }, authUser: { id: 'u1' }, headers: {}, ip: '10.0.0.8' } as unknown as Parameters<typeof config.rateLimit.keyGenerator>[0];
    expect(await config.rateLimit.keyGenerator(member)).toBe('business:b1');
  });
});

describe('datos de demostración', () => {
  it('la descripción del servicio demo (que lee la IA) no lleva notas internas para el entrenador', () => {
    const seed = readFileSync(path.join(here, '../../src/database/seed.ts'), 'utf8');
    const description = /name: 'Programa Kaizen[^']*',\s*(?:\/\/[^\n]*\n\s*)?description: '([^']*)'/.exec(seed)?.[1];
    expect(description).toBe('Acompañamiento online de pérdida de grasa con el método Kaizen.');
    expect(seed).not.toMatch(/Precio de EJEMPLO/);
  });
});
