import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import { env } from '../config/env.js';

/**
 * Conexión a base de datos.
 * - Producción: PostgreSQL real (DATABASE_URL).
 * - Desarrollo sin DATABASE_URL: PGlite (Postgres embebido, se guarda en .data/pglite).
 * - Tests: PGlite en memoria.
 * El resto de la aplicación solo ve el tipo `Database`, sin saber cuál se usa.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DbHandle {
  db: Database;
  driver: 'postgres' | 'pglite';
  close: () => Promise<void>;
}

let current: DbHandle | null = null;

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.join(here, 'migrations');

export async function createDatabase(opts: { url?: string; memory?: boolean } = {}): Promise<DbHandle> {
  const url = opts.url ?? env.DATABASE_URL;
  if (url && !opts.memory) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new Pool({
      connectionString: url,
      max: 10,
      ssl: /sslmode=require|neon\.tech|supabase\.co/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
    const db = drizzle(pool, { schema }) as unknown as Database;
    return { db, driver: 'postgres', close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  let client: InstanceType<typeof PGlite>;
  if (opts.memory) {
    client = new PGlite();
  } else {
    const dir = path.resolve(process.cwd(), env.PGLITE_DIR);
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema }) as unknown as Database;
  return { db, driver: 'pglite', close: () => client.close() };
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.driver === 'postgres') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

export function setDatabase(handle: DbHandle | null) {
  current = handle;
}

export function getDb(): Database {
  if (!current) throw new Error('La base de datos no está inicializada. Llama a initDatabase() al arrancar.');
  return current.db;
}

export function getDbHandle(): DbHandle | null {
  return current;
}

export async function initDatabase(opts: { memory?: boolean; url?: string } = {}): Promise<DbHandle> {
  const handle = await createDatabase(opts);
  await runMigrations(handle);
  setDatabase(handle);
  return handle;
}

export async function closeDatabase() {
  if (current) {
    await current.close();
    current = null;
  }
}

export { schema };
