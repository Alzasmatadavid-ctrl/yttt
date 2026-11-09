/* Aplica las migraciones pendientes. Uso: npm run db:migrate */
import { closeDatabase, initDatabase } from './client.js';
import { bootstrapData } from './bootstrap.js';
import { localDbInUseBy, localDbInUseMessage } from './local-lock.js';

// Con KAI arrancado, la base local está en uso (ver local-lock.ts): no se abre una segunda copia.
const lock = localDbInUseBy();
if (lock) {
  console.error(localDbInUseMessage(lock));
  process.exitCode = 1;
} else {
  const handle = await initDatabase();
  await bootstrapData();
  console.log(`✔ Base de datos al día (${handle.driver}).`);
  await closeDatabase();
}
