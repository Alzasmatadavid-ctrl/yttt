/**
 * Revisión nº5 — grupo «plataforma».
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { postgresConnection } from '../../src/database/client.js';
import { LocalDbInUseError, localDbLockPath, releaseLocalDbLock, writeLocalDbLock } from '../../src/database/local-lock.js';
import { env } from '../../src/config/env.js';

describe('DATABASE_URL con sslmode=require (Supabase, Neon)', () => {
  /** SSL que usaría de verdad pg con esta conexión (lo que viene en la URL pisa la opción ssl). */
  const sslOf = (url: string) => {
    const client = new pg.Client(postgresConnection(url));
    return (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
  };

  it.each([
    'postgres://u:p@db.abcd.supabase.co:5432/postgres?sslmode=require',
    'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
    'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    'postgres://u:p@mi-servidor.com:5432/kai?sslmode=require&application_name=kai',
    'postgres://u:p@db.abcd.supabase.co:5432/postgres',
  ])('cifra sin verificar el certificado (la CA de Supabase no es pública): %s', (url) => {
    expect(sslOf(url)).toEqual({ rejectUnauthorized: false });
    expect(postgresConnection(url).connectionString).not.toMatch(/sslmode/);
  });

  it('conserva el resto de parámetros de la dirección', () => {
    expect(postgresConnection('postgres://u:p@h.com/kai?sslmode=require&application_name=kai').connectionString).toBe(
      'postgres://u:p@h.com/kai?application_name=kai',
    );
  });

  it('respeta la URL si se pide verificar el certificado, sin SSL o con un Postgres normal', () => {
    for (const url of [
      'postgres://u:p@h.com/kai?sslmode=verify-full',
      'postgres://u:p@db.abcd.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/ca.crt',
      'postgres://u:p@localhost:5432/kai?sslmode=disable',
      'postgres://kai@db:5432/kai',
    ]) {
      expect(postgresConnection(url)).toEqual({ connectionString: url });
    }
  });
});

describe('Candado de la base de datos local (PGlite) al arrancar', () => {
  let dir: string;
  const saved = { dir: env.PGLITE_DIR, url: env.DATABASE_URL };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kai-p5-lock-'));
    env.PGLITE_DIR = path.join(dir, 'pglite');
    env.DATABASE_URL = undefined;
  });
  afterEach(() => {
    env.PGLITE_DIR = saved.dir;
    env.DATABASE_URL = saved.url;
    rmSync(dir, { recursive: true, force: true });
  });

  it('un segundo KAI con otro ya arrancado no toca su candado (y no abre la base de datos)', () => {
    const lock = localDbLockPath()!;
    const other = String(process.ppid); // Un proceso vivo distinto de este (el «primer KAI»).
    writeFileSync(lock, other);
    expect(() => writeLocalDbLock()).toThrow(LocalDbInUseError);
    expect(() => writeLocalDbLock()).toThrow(/KAI ya está arrancado en otra terminal/);
    expect(readFileSync(lock, 'utf8')).toBe(other);
    // Y al salir este proceso no lo borra: no es suyo.
    releaseLocalDbLock(lock);
    expect(readFileSync(lock, 'utf8')).toBe(other);
  });

  it('sin candado, o con el de un proceso que ya no existe, lo escribe con su número de proceso', () => {
    const lock = localDbLockPath()!;
    expect(writeLocalDbLock()).toBe(lock);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
    releaseLocalDbLock(lock);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, '2147483646'); // Proceso inexistente (p. ej. un arranque anterior que murió).
    expect(writeLocalDbLock()).toBe(lock);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  });

  it('con PostgreSQL (DATABASE_URL) no hay candado', () => {
    env.DATABASE_URL = 'postgres://kai@db:5432/kai';
    expect(writeLocalDbLock()).toBeNull();
  });
});
