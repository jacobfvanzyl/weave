import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { contentSecurityPolicy } from './src/content-security-policy';

/** The policy goes into the built page only: Vite's dev server runs inline scripts of its own. */
const contentSecurityPolicyMeta = (): Plugin => ({
  name: 'weave-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), contentSecurityPolicyMeta()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
