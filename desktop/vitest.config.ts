import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@weave/client': fileURLToPath(new URL('../packages/client/src', import.meta.url)),
      '@weave/protocol': fileURLToPath(new URL('../packages/protocol/src', import.meta.url)),
    },
  },
  test: {
    env: {
      WEAVE_DATABASE_URL: 'postgresql://weave-test:weave-test@127.0.0.1:1/weave-test',
    },
  },
});
