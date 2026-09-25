import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist/web', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5179 },
  // module workers, so that the worker can import three.js like the page does
  worker: { format: 'es' },
  // relative asset paths, so that the build runs from any folder (plugin, file server)
  base: './',
});
