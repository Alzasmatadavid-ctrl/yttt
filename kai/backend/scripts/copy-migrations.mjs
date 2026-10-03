// Copia las migraciones SQL a dist/ para que el servidor compilado pueda aplicarlas al arrancar.
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'database', 'migrations');
const to = path.join(root, 'dist', 'database', 'migrations');
if (!existsSync(from)) {
  console.error(`✖ No se encuentra la carpeta de migraciones: ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.log('✔ Migraciones copiadas a dist/database/migrations');
