import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import type { Plugin } from 'vite';
import { createWeaveClientDefines } from '../scripts/client-vite-env';

const mobileRoot = fileURLToPath(new URL('.', import.meta.url));

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

export default defineConfig(({ mode }) => {
  const appEnv = loadEnv(mode, mobileRoot, '');
  const mobileOnlyEnv = {};

  return {
    base: './',
    define: createWeaveClientDefines({ appEnv, shellEnv: mobileOnlyEnv, workspaceEnv: mobileOnlyEnv }),
    plugins: [mobileDeviceLogPlugin(), react(), tailwindcss()],
  };
});
