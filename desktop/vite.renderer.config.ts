import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const desktopSrc = fileURLToPath(new URL('./src', import.meta.url));
const webSrc = fileURLToPath(new URL('../web/src', import.meta.url));
const webRoot = fileURLToPath(new URL('../web', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '#': desktopSrc,
      '~': webSrc,
      '@': webSrc,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [desktopSrc, webRoot],
    },
  },
});
