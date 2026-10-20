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
  },
});
