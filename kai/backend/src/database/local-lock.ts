/*
 * Candado de la base de datos local (PGlite, sin DATABASE_URL). PGlite no admite dos procesos a la vez: mientras
 * KAI está arrancado deja su número de proceso en «<carpeta>.lock», y «npm run db:seed» / «npm run db:migrate»
 * se niegan a abrirla (lo que escribieran no lo vería el servidor y se perdería al pararlo).
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';

/** Ruta del candado, o null si se usa PostgreSQL (DATABASE_URL). */
export function localDbLockPath(): string | null {
  return env.DATABASE_URL ? null : `${path.resolve(process.cwd(), env.PGLITE_DIR)}.lock`;
}

/** El servidor deja su número de proceso en el candado antes de abrir la base de datos. */
export function writeLocalDbLock(): string | null {
  const lock = localDbLockPath();
  if (lock) {
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));
  }
  return lock;
}

/** Al parar, se quita solo si sigue siendo suyo (al reiniciar con «npm run dev», el proceso nuevo lo vuelve a escribir). */
export function releaseLocalDbLock(lock: string | null) {
  if (!lock) return;
  try {
    if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock, { force: true });
  } catch {
    // Ya no está: nada que hacer.
  }
}

/**
 * Archivo «.lock» de la base de datos local si KAI está arrancado y la está usando, o null.
 * No cuenta si ese proceso ya no existe o si el archivo es de antes de encender el ordenador.
 */
export function localDbInUseBy(): string | null {
  const lock = localDbLockPath();
  if (!lock) return null;
  let pid: number;
  try {
    if (statSync(lock).mtimeMs < Date.now() - uptime() * 1000) return null;
    pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
  } catch {
    return null;
  }
  if (!(pid > 0) || pid === process.pid) return null;
  try {
    process.kill(pid, 0); // Solo comprueba que el proceso existe.
    return lock;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? lock : null;
  }
}

/** Mensaje para el entrenador cuando un comando no puede usar la base de datos porque KAI está arrancado. */
export function localDbInUseMessage(lock: string): string {
  return `✖ KAI está arrancado y está usando la base de datos de tu ordenador. Páralo con Ctrl + C, vuelve a ejecutar este comando y después arráncalo otra vez con «npm run dev».\n  (Si KAI no está abierto en ninguna terminal, borra el archivo ${lock} y vuelve a intentarlo.)`;
}
