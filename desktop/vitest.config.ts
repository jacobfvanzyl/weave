import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      WEAVE_DATABASE_URL: 'postgresql://weave-test:weave-test@127.0.0.1:1/weave-test',
    },
  },
});
