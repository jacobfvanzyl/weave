const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const getWeaveDatabaseUrl = (env: NodeJS.ProcessEnv = process.env) => optionalString(env.WEAVE_DATABASE_URL);

export const requireWeaveDatabaseUrl = (env: NodeJS.ProcessEnv = process.env) => {
  const url = getWeaveDatabaseUrl(env);
  if (!url) {
    throw new Error('WEAVE_DATABASE_URL is required. Run Postgres migrations before starting the Weave server.');
  }
  return url;
};

export const getDbosSystemDatabaseUrl = (env: NodeJS.ProcessEnv = process.env) =>
  optionalString(env.DBOS_SYSTEM_DATABASE_URL) ?? getWeaveDatabaseUrl(env);

