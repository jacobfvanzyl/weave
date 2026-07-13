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
const protocolSrc = fileURLToPath(new URL('../packages/protocol/src', import.meta.url));
const protocolRoot = fileURLToPath(new URL('../packages/protocol', import.meta.url));

const mobileDeviceLogPlugin = (): Plugin => ({
  name: 'weave-mobile-device-log',
  configureServer(server) {
    server.middlewares.use('/__weave_mobile_log', (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body) as {
            event?: string;
            fields?: Record<string, unknown>;
            scope?: string;
            seq?: number;
            dt?: number | null;
          };
          console.log(
            `[mobile device] ${payload.scope ?? 'log'}#${payload.seq ?? '-'}`
            + ` ${payload.event ?? 'event'} dt=${payload.dt ?? '-'}`
            + ` ${JSON.stringify(payload.fields ?? {})}`,
          );
        } catch {
          console.log(`[mobile device] ${body}`);
        }
        res.statusCode = 204;
        res.end();
      });
      req.on('error', () => {
        res.statusCode = 400;
        res.end();
      });
    });
  },
});

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
    plugins: [mobileDeviceLogPlugin(), sharedClientDependencyResolver(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@weave/client': clientSrc,
        '@weave/protocol': protocolSrc,
        '~': clientSrc,
        '@': mobileSrc,
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      fs: {
        allow: [mobileRoot, clientRoot, protocolRoot],
      },
    },
  };
});
