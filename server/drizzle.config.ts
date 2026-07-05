import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.WEAVE_DATABASE_URL ?? 'postgres://weave:weave@127.0.0.1:54329/weave_dbos',
  },
  verbose: true,
  strict: true,
});

