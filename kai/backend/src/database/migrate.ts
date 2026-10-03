/* Aplica las migraciones pendientes. Uso: npm run db:migrate */
import { closeDatabase, initDatabase } from './client.js';
import { bootstrapData } from './bootstrap.js';

const handle = await initDatabase();
await bootstrapData();
console.log(`✔ Base de datos al día (${handle.driver}).`);
await closeDatabase();
