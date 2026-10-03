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
    },
  },
});
