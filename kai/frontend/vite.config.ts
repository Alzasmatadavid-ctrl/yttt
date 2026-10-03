import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// En desarrollo, /api se redirige al backend (puerto 3000) para trabajar en el mismo dominio.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Vocabulario de dominio compartido con el backend (estados, etiquetas, tipos).
      '@shared': fileURLToPath(new URL('../backend/src/lib/domain.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
