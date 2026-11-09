/**
 * Despliegue de un clic (render.yaml en la raíz del repositorio): sin APP_URL, KAI toma la dirección pública que
 * publica el hosting (Render: RENDER_EXTERNAL_URL; Railway: RAILWAY_PUBLIC_DOMAIN), así que el entrenador no tiene
 * que copiarla a mano. Un APP_URL definido (su propio dominio) siempre manda.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformAppUrl } from '../../src/config/env.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const saved = { ...process.env };
const HOSTING_VARS = ['APP_URL', 'RENDER_EXTERNAL_URL', 'RAILWAY_PUBLIC_DOMAIN'];

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  vi.resetModules();
});

/** Carga de nuevo src/config/env.ts con estas variables (como al arrancar el servidor). */
async function loadEnvWith(vars: Record<string, string | undefined>) {
  for (const k of HOSTING_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import('../../src/config/env.js');
}

describe('Dirección pública que da el hosting', () => {
  it('Render: RENDER_EXTERNAL_URL tal cual', () => {
    expect(platformAppUrl({ RENDER_EXTERNAL_URL: 'https://kai-abc1.onrender.com' })).toBe('https://kai-abc1.onrender.com');
  });

  it('Railway: RAILWAY_PUBLIC_DOMAIN con https delante (y sin barras ni esquema repetido)', () => {
    expect(platformAppUrl({ RAILWAY_PUBLIC_DOMAIN: 'kai-production.up.railway.app' })).toBe('https://kai-production.up.railway.app');
    expect(platformAppUrl({ RAILWAY_PUBLIC_DOMAIN: 'https://kai-production.up.railway.app/' })).toBe('https://kai-production.up.railway.app');
  });

  it('sin hosting conocido: nada', () => {
    expect(platformAppUrl({})).toBeUndefined();
    expect(platformAppUrl({ RENDER_EXTERNAL_URL: '  ', RAILWAY_PUBLIC_DOMAIN: '' })).toBeUndefined();
  });
});

describe('APP_URL al arrancar', () => {
  it('sin APP_URL en Render: usa la dirección de Render y arranca en modo producción', async () => {
    const mod = await loadEnvWith({
      NODE_ENV: undefined,
      RENDER_EXTERNAL_URL: 'https://kai-abc1.onrender.com',
      DATABASE_URL: 'postgresql://kai:secreto@dpg-abc123-a/kai',
      ENCRYPTION_KEY: KEY,
    });
    expect(mod.publicAppUrl()).toBe('https://kai-abc1.onrender.com');
    expect(mod.publicApiUrl()).toBe('https://kai-abc1.onrender.com');
    expect(mod.isProduction()).toBe(true);
  });

  it('APP_URL vacía en Railway: usa el dominio de Railway', async () => {
    const mod = await loadEnvWith({ APP_URL: '', RAILWAY_PUBLIC_DOMAIN: 'kai-production.up.railway.app', NODE_ENV: 'test' });
    expect(mod.publicAppUrl()).toBe('https://kai-production.up.railway.app');
  });

  it('un APP_URL propio tiene prioridad sobre el del hosting', async () => {
    const mod = await loadEnvWith({ APP_URL: 'https://app.davidalzas.com', RENDER_EXTERNAL_URL: 'https://kai-abc1.onrender.com', NODE_ENV: 'test' });
    expect(mod.publicAppUrl()).toBe('https://app.davidalzas.com');
  });

  it('APP_URL vacía y sin hosting: el valor por defecto de tu ordenador (antes, una APP_URL vacía impedía arrancar)', async () => {
    const mod = await loadEnvWith({ APP_URL: '', NODE_ENV: 'test' });
    expect(mod.publicAppUrl()).toBe('http://localhost:5173');
  });
});

describe('render.yaml (botón «Deploy to Render»)', () => {
  const yaml = readFileSync(fileURLToPath(new URL('../../../../render.yaml', import.meta.url)), 'utf8');

  it('construye la imagen Docker de la carpeta kai y comprueba /api/health', () => {
    expect(yaml).toMatch(/runtime: docker/);
    expect(yaml).toMatch(/rootDir: kai/);
    expect(yaml).toMatch(/dockerfilePath: \.\/kai\/Dockerfile/);
    expect(yaml).toMatch(/dockerContext: \.\/kai/);
    expect(yaml).toMatch(/healthCheckPath: \/api\/health/);
  });

  it('crea la base de datos, genera la clave de cifrado y solo pide la clave de Claude y la cuenta de administración', () => {
    expect(yaml).toMatch(/key: DATABASE_URL\s+fromDatabase:\s+name: kai-db\s+property: connectionString/);
    expect(yaml).toMatch(/key: ENCRYPTION_KEY\s+generateValue: true/);
    const asked = [...yaml.matchAll(/key: (\w+)\s+sync: false/g)].map((m) => m[1]).sort();
    expect(asked).toEqual(['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ANTHROPIC_API_KEY']);
    expect(yaml).toMatch(/databases:\s+- name: kai-db/);
  });
});
