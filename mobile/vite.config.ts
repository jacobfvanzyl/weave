import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createWeaveClientDefines } from '../scripts/client-vite-env';
import { isSharedClientPackage } from '../scripts/shared-client-packages';

const mobileSrc = fileURLToPath(new URL('./src', import.meta.url));
const mobileRoot = fileURLToPath(new URL('.', import.meta.url));
const clientSrc = fileURLToPath(new URL('../packages/client/src', import.meta.url));
const clientRoot = fileURLToPath(new URL('../packages/client', import.meta.url));
const sharedClientDependencyResolver = (): Plugin => ({
  name: 'weave-client-dependency-resolver',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (
      !importer?.startsWith(clientSrc) ||
      !isSharedClientPackage(source, { includeMobileOnly: true })
    ) return null;

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
