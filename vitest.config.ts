import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    exclude: ['test/robotcell.test.ts', 'node_modules/**'],
    testTimeout: 30000,
  },
});
