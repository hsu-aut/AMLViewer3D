import { defineConfig } from 'vitest/config';

// Robots of other COLLADA writers (not in the repository; node scripts/fetch-robots.mjs): npm run test:robots
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/robots.test.ts'],
    testTimeout: 300000,
    // 58 robots, two of them over 20 MB, in one worker.
    execArgv: ['--max-old-space-size=8192'],
  },
});
