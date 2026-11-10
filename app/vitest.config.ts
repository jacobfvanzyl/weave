import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'happy-dom',
    exclude: ['acceptance/**', 'dist/**', 'node_modules/**'],
    setupFiles: ['./src/test/setup.ts'],
    // The whole suite runs the `*.host.test.ts` files' dev Hosts and Dispatchers beside the
    // component tests, which then take several times what they take alone: a Session's, with two
    // transcripts on screen, a second each alone and past the default five under that load.
    testTimeout: 20_000,
  },
});
