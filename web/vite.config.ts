import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';

const webSrc = fileURLToPath(new URL('./src', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const clientSrc = fileURLToPath(new URL('../packages/client/src', import.meta.url));
const clientRoot = fileURLToPath(new URL('../packages/client', import.meta.url));
const sharedClientPackages = [
  '@ai-sdk/react',
  '@assistant-ui/core',
  '@assistant-ui/react',
  '@assistant-ui/react-ai-sdk',
  '@base-ui/react',
  '@dnd-kit/core',
  '@dnd-kit/modifiers',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@fontsource-variable/dm-sans',
  '@tanstack/react-query',
  'ai',
  'class-variance-authority',
  'clsx',
  'lucide-react',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-raw',
  'rehype-sanitize',
  'remark-gfm',
  'shiki',
  'tailwind-merge',
  'tailwindcss',
  'zustand',
] as const;

const isSharedClientPackage = (source: string) =>
  sharedClientPackages.some(packageName => source === packageName || source.startsWith(`${packageName}/`));

const sharedClientDependencyResolver = (): Plugin => ({
  name: 'weave-client-dependency-resolver',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer?.startsWith(clientSrc) || !isSharedClientPackage(source)) return null;

    return this.resolve(source, path.join(webSrc, '__weave_client_dependency_anchor.ts'), {
      ...options,
      skipSelf: true,
    });
  },
});

export default defineConfig({
  plugins: [sharedClientDependencyResolver(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@weave/client': clientSrc,
      '~': clientSrc,
      '@': webSrc,
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [webRoot, clientRoot],
    },
  },
});
