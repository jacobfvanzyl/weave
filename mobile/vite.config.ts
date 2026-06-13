import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createWeaveClientDefines } from '../scripts/client-vite-env';

const mobileSrc = fileURLToPath(new URL('./src', import.meta.url));
const mobileRoot = fileURLToPath(new URL('.', import.meta.url));
const clientSrc = fileURLToPath(new URL('../packages/client/src', import.meta.url));
const clientRoot = fileURLToPath(new URL('../packages/client', import.meta.url));
const sharedClientPackages = [
  '@ai-sdk/react',
  '@assistant-ui/core',
  '@assistant-ui/react',
  '@assistant-ui/react-ai-sdk',
  '@base-ui/react',
  '@capacitor/preferences',
  '@criblinc/docker-names',
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
  '@excalidraw/excalidraw',
  '@lezer/highlight',
  '@replit/codemirror-vim',
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

    return this.resolve(source, path.join(mobileSrc, '__weave_client_dependency_anchor.ts'), {
      ...options,
      skipSelf: true,
    });
  },
});

export default defineConfig(({ mode }) => {
  const appEnv = loadEnv(mode, mobileRoot, '');
  const mobileOnlyEnv = {};

  return {
    base: './',
    define: createWeaveClientDefines({ appEnv, shellEnv: mobileOnlyEnv, workspaceEnv: mobileOnlyEnv }),
    plugins: [sharedClientDependencyResolver(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@weave/client': clientSrc,
        '~': clientSrc,
        '@': mobileSrc,
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      fs: {
        allow: [mobileRoot, clientRoot],
      },
    },
  };
});
