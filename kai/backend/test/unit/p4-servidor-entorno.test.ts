/**
 * Revisión nº4 — grupo «servidor»: NODE_ENV olvidado en un servidor público.
 * Sin NODE_ENV (.env.example lo deja comentado), las protecciones de producción (verificar los canales con Meta,
 * clave de cifrado propia, firma de Meta, emails sin enlaces en los registros) quedaban desactivadas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferredProduction, looksLikePublicServer } from '../../src/config/env.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const saved = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.resetModules();
});

/** Carga de nuevo src/config/env.ts con estas variables (como al arrancar el servidor). */
async function loadEnvWith(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import('../../src/config/env.js');
}

describe('¿Configuración de servidor público?', () => {
  it.each([
    ['https://app.entrenador.com', undefined],
    ['http://localhost:5173', 'postgres://kai:secreto@ep-cool-123.eu-central-1.aws.neon.tech/kai?sslmode=require'],
    ['https://kai-production.up.railway.app', 'postgres://kai:secreto@postgres.railway.internal:5432/railway'],
  ])('APP_URL=%s · DATABASE_URL=%s → sí', (appUrl, db) => {
    expect(looksLikePublicServer(appUrl, db)).toBe(true);
  });

  it.each([
    ['http://localhost:5173', undefined],
    ['https://localhost:5173', ''],
    ['http://localhost:5173', 'postgres://kai:kai@localhost:5432/kai'],
    ['http://localhost:3000', 'postgres://kai:kai@db:5432/kai'],
    [undefined, undefined],
  ])('APP_URL=%s · DATABASE_URL=%s → no', (appUrl, db) => {
    expect(looksLikePublicServer(appUrl, db)).toBe(false);
  });

  it('solo se deduce producción si NODE_ENV no está definido', () => {
    expect(inferredProduction({ APP_URL: 'https://app.entrenador.com' })).toBe(true);
    expect(inferredProduction({ APP_URL: 'https://app.entrenador.com', NODE_ENV: '' })).toBe(true);
    expect(inferredProduction({ APP_URL: 'https://app.entrenador.com', NODE_ENV: 'development' })).toBe(false);
    expect(inferredProduction({ APP_URL: 'http://localhost:5173' })).toBe(false);
  });
});

describe('Arranque sin NODE_ENV', () => {
  it('en un servidor público arranca en modo producción (y exige ENCRYPTION_KEY, explicando por qué)', async () => {
    const base = { NODE_ENV: undefined, APP_URL: 'https://app.entrenador.com', DATABASE_URL: 'postgres://kai:secreto@db.ejemplo.com:5432/kai' };
    await expect(loadEnvWith({ ...base, ENCRYPTION_KEY: undefined })).rejects.toThrow(/ENCRYPTION_KEY es obligatoria en producción.*NODE_ENV no está definido/s);

    const mod = await loadEnvWith({ ...base, ENCRYPTION_KEY: KEY });
    expect(mod.isProduction()).toBe(true);
    expect(process.env.NODE_ENV).toBe('production');
    expect(mod.startupWarnings().join('\n')).toMatch(/NODE_ENV no está definido.*NODE_ENV=production/s);
  });

  it('en local sigue siendo desarrollo, y NODE_ENV=development explícito se respeta', async () => {
    expect((await loadEnvWith({ NODE_ENV: undefined, APP_URL: 'http://localhost:5173', DATABASE_URL: undefined, ENCRYPTION_KEY: undefined })).isProduction()).toBe(false);
    const dev = await loadEnvWith({ NODE_ENV: 'development', APP_URL: 'https://pruebas.entrenador.com', DATABASE_URL: 'postgres://kai:secreto@db.ejemplo.com:5432/kai', ENCRYPTION_KEY: undefined });
    expect(dev.isProduction()).toBe(false);
    expect(dev.startupWarnings().join('\n')).not.toMatch(/NODE_ENV no está definido/);
  });
});
