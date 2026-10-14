/*
 * Base de datos local (PGlite): no admite dos procesos a la vez. Con KAI arrancado, «npm run db:seed» o
 * «npm run db:migrate» escribían en su propia copia, el servidor no lo veía y al pararlo se perdía (la demo
 * «creada» no existía). Ahora el servidor deja su PID en «<carpeta>.lock» y los scripts se niegan a abrirla.
 * Se prueban los scripts de verdad, cada uno en su propio proceso y con una carpeta temporal.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kai-p3-docs-'));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
});

function envFor(pgliteDir: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'development', DATABASE_URL: '', PGLITE_DIR: pgliteDir, PORT: '0', HOST: '127.0.0.1', RUN_WORKER: 'false', ADMIN_EMAIL: '' };
}

function start(script: string, pgliteDir: string): { child: ChildProcess; output: () => string; done: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: backendDir, env: envFor(pgliteDir), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (out += String(d)));
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output: () => out, done };
}

async function run(script: string, pgliteDir: string) {
  const p = start(script, pgliteDir);
  const code = await p.done;
  return { code, output: p.output() };
}

/** PID de un proceso que ya ha terminado (candado huérfano tras un cierre brusco). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

describe('«npm run db:seed» y «npm run db:migrate» con KAI arrancado (PGlite)', () => {
  it('se niegan a abrir la base local si el proceso del candado sigue vivo, con un mensaje claro', async () => {
    const dir = path.join(tmp, 'vivo', 'pglite');
    // Este mismo proceso de pruebas hace de «servidor arrancado».
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(`${dir}.lock`, String(process.pid));

    for (const script of ['src/database/seed.ts', 'src/database/migrate.ts']) {
      const r = await run(script, dir);
      expect(r.code, r.output).toBe(1);
      expect(r.output).toContain('KAI está arrancado y está usando la base de datos de tu ordenador');
      expect(r.output).toContain('Ctrl + C');
      expect(r.output).not.toContain('Datos de demostración creados');
      // No ha llegado a abrir (ni crear) la base de datos.
      expect(existsSync(dir)).toBe(false);
    }
  }, 120_000);

  it('un candado huérfano (de un proceso que ya no existe) no bloquea', async () => {
    const dir = path.join(tmp, 'huerfano', 'pglite');
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(`${dir}.lock`, String(await deadPid()));
    const r = await run('src/database/migrate.ts', dir);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('Base de datos al día (pglite)');
  }, 120_000);

  it('el servidor deja su PID en el candado mientras está arrancado y lo quita al pararse', async () => {
    const dir = path.join(tmp, 'servidor', 'pglite');
    const lock = `${dir}.lock`;
    const server = start('src/index.ts', dir);
    try {
      const deadline = Date.now() + 90_000;
      while (!server.output().includes('KAI escuchando') && server.child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(server.output(), server.output()).toContain('KAI escuchando');
      expect(readFileSync(lock, 'utf8').trim()).toBe(String(server.child.pid));

      // Con el servidor en marcha, el script no toca la base.
      const r = await run('src/database/migrate.ts', dir);
      expect(r.code, r.output).toBe(1);
      expect(r.output).toContain('KAI está arrancado');
    } finally {
      server.child.kill('SIGTERM');
      await server.done;
    }
    expect(existsSync(lock)).toBe(false);
    // Ya parado, el script funciona.
    const after = await run('src/database/migrate.ts', dir);
    expect(after.code, after.output).toBe(0);
  }, 180_000);
});
