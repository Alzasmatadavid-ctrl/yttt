import { defineConfig } from 'drizzle-kit';

// Genera las migraciones SQL a partir del esquema TypeScript.
// Uso: npm run db:generate  (no necesita conexión a la base de datos)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
});
