import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5179 },
});
