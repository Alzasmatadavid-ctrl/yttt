import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      AI_PROVIDER: 'simulated',
      META_APP_SECRET: 'test-app-secret',
      META_VERIFY_TOKEN: 'test-verify-token',
      // Los tests del setter envían cientos de mensajes del simulador en segundos con un mismo negocio.
      // El límite real (20/min) se comprueba en test/integration/p1-integracion.test.ts bajándolo allí.
      SIMULATOR_MAX_PER_MINUTE: '100000',
    },
  },
});
