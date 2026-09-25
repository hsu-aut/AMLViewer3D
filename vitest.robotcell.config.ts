import { defineConfig } from 'vitest/config';

// The AutomationML e.V. robot cell (not in the repository, see README): npm run test:robotcell
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/robotcell.test.ts'],
    testTimeout: 900000,
    hookTimeout: 900000,
  },
});
