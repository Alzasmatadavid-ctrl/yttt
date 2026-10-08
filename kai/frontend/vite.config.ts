import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// En desarrollo, /api se redirige al backend (puerto 3000) para trabajar en el mismo dominio.
// KAI_API_URL y KAI_WEB_PORT permiten levantar varias copias a la vez (por ejemplo, para pruebas).
const apiTarget = process.env.KAI_API_URL ?? 'http://localhost:3000';
const webPort = Number(process.env.KAI_WEB_PORT ?? 5173);
export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.KAI_VITE_CACHE ?? 'node_modules/.vite',
  resolve: {
    alias: {
      // Vocabulario de dominio compartido con el backend (estados, etiquetas, tipos).
      '@shared': fileURLToPath(new URL('../backend/src/lib/domain.ts', import.meta.url)),
    },
  },
  server: {
    port: webPort,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
