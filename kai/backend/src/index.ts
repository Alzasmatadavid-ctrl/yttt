/**
 * Punto de entrada del servidor de KAI.
 *   1. Conecta la base de datos y aplica migraciones.
 *   2. Crea los datos mínimos (planes, admin).
 *   3. Arranca la API (y la web en producción).
 *   4. Arranca el trabajador de automatizaciones.
 */
import { env, isProduction, resolveAiMode } from './config/env.js';
import { closeDatabase, initDatabase } from './database/client.js';
import { bootstrapData } from './database/bootstrap.js';
import { buildApp } from './app.js';
import { startWorker, stopWorker } from './automation/worker.js';
import { logger } from './lib/logger.js';

const handle = await initDatabase();
await bootstrapData();
const app = await buildApp({ logger: true });
await app.listen({ port: env.PORT, host: env.HOST });
logger.info('kai.started', { port: env.PORT, db: handle.driver, worker: env.RUN_WORKER });
if (!isProduction()) {
  const db = handle.driver === 'pglite' ? 'local (PGlite)' : 'PostgreSQL';
  const ai = resolveAiMode() === 'anthropic' ? 'Claude' : 'modo simulado (sin ANTHROPIC_API_KEY)';
  console.log(`\n  ✔ KAI escuchando en el puerto ${env.PORT} · base de datos: ${db} · IA: ${ai}\n`);
}
if (env.RUN_WORKER) startWorker();

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info('kai.shutdown', { signal });
  stopWorker();
  await app.close();
  await closeDatabase();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
