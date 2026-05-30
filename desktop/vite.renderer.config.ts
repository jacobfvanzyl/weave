import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createWeaveClientDefines } from '../scripts/client-vite-env';

const desktopSrc = fileURLToPath(new URL('./src', import.meta.url));
const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const clientSrc = fileURLToPath(new URL('../packages/client/src', import.meta.url));
const clientRoot = fileURLToPath(new URL('../packages/client', import.meta.url));
const sharedClientPackages = [
  '@ai-sdk/react',
  '@assistant-ui/core',
  '@assistant-ui/react',
  '@assistant-ui/react-ai-sdk',
  '@base-ui/react',
  '@codemirror/lang-css',
  '@codemirror/lang-html',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-markdown',
  '@codemirror/language',
  '@codemirror/state',
  '@codemirror/view',
  '@dnd-kit/core',
  '@dnd-kit/modifiers',
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@fontsource-variable/dm-sans',
  '@lezer/highlight',
  '@tanstack/react-query',
  'ai',
  'class-variance-authority',
  'clsx',
  'codemirror',
  'ghostty-web',
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

    return this.resolve(source, path.join(desktopSrc, '__weave_client_dependency_anchor.ts'), {
      ...options,
      skipSelf: true,
    });
  },
});

export default defineConfig(({ mode }) => {
  const appEnv = loadEnv(mode, desktopRoot, '');
  const workspaceEnv = loadEnv(mode, workspaceRoot, '');

  return {
    define: createWeaveClientDefines({ appEnv, shellEnv: process.env, workspaceEnv }),
    plugins: [sharedClientDependencyResolver(), react(), tailwindcss()],
    resolve: {
      alias: {
        '#': desktopSrc,
        '@weave/client': clientSrc,
        '~': clientSrc,
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      fs: {
        allow: [desktopRoot, clientRoot],
      },
    },
  };
});
