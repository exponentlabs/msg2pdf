import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  build: {
    outDir: resolve('out/renderer'),
    emptyOutDir: false,
    sourcemap: false,
    rolldownOptions: {
      onLog(level, log, handler) {
        // React Server Component markers have no effect in this desktop SPA.
        if (
          log.code === 'MODULE_LEVEL_DIRECTIVE' &&
          log.message.includes('use client') &&
          log.id?.includes('/lucide-react/')
        )
          return;
        handler(level, log);
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
