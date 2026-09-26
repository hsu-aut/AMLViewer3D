import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/robotcell.test.ts', 'test/robots.test.ts', 'test/output/**', 'node_modules/**'],
    testTimeout: 30000,
  },
});
