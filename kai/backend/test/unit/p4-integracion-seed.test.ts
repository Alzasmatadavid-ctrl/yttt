/*
 * Demo recién creada («npm run db:seed»): con KAI activo, «Pendientes» solo debe mostrar lo que de verdad necesita al
 * entrenador (el escalado de Andrés Vidal). Antes, cinco hilos terminaban en un mensaje del lead sin respuesta y la demo
 * parecía un KAI que no contesta («Mensaje sin contestar» en 6 conversaciones).
 * Se ejecuta el script de verdad, en su propio proceso y con una carpeta temporal de PGlite.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { setDatabase, type Database } from '../../src/database/client.js';
import * as schema from '../../src/database/schema.js';
import { inboxCounts, listInbox } from '../../src/crm/conversations.service.js';
import { getDashboard } from '../../src/analytics/analytics.service.js';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kai-p4-seed-'));
let client: PGlite | null = null;

afterAll(async () => {
  setDatabase(null);
  await client?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function runSeed(pgliteDir: string): Promise<{ code: number | null; output: string }> {
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: '', PGLITE_DIR: pgliteDir, RUN_WORKER: 'false', ADMIN_EMAIL: '' };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/database/seed.ts'], { cwd: backendDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += String(d)));
  child.stderr.on('data', (d) => (output += String(d)));
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
}

describe('Demo recién creada', () => {
  it('«Pendientes» solo tiene el escalado y ninguna conversación sale como respuesta no enviada', async () => {
    const dir = path.join(tmp, 'pglite');
    const r = await runSeed(dir);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('Datos de demostración creados');

    client = new PGlite(dir);
    const db = drizzle(client, { schema }) as unknown as Database;
    setDatabase({ db, driver: 'pglite', close: () => client!.close() });
    const [biz] = await db.select({ id: schema.businesses.id }).from(schema.businesses).where(eq(schema.businesses.name, 'Demo · David Alzas Coach')).limit(1);
    expect(biz).toBeDefined();

    const counts = await inboxCounts(biz.id);
    expect(counts.pending).toBe(1);
    const pending = await listInbox(biz.id, { filter: 'pending' });
    expect(pending.map((i) => i.lead.name)).toEqual(['Andrés Vidal']);
    expect(pending[0].conversation.handoffActive).toBe(true);
    const all = await listInbox(biz.id, { limit: 200 });
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((i) => i.replyUnsent)).toEqual([]);

    // «Hoy» tampoco dice que haya leads esperando respuesta: el escalado sale como su propio aviso.
    const d = await getDashboard(biz.id);
    expect(d.attention.waiting).toEqual([]);
    expect(d.attention.alerts.filter((a) => a.alert.type === 'handoff').map((a) => a.leadName)).toEqual(['Andrés Vidal']);
  }, 180_000);
});
