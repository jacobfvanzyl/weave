import { requireWeaveDatabaseUrl } from '../../storage/database-url';

export const mastraSchemaName = process.env.MASTRA_POSTGRES_SCHEMA ?? 'mastra';

export const getMastraPostgresConnectionString = () => requireWeaveDatabaseUrl();

export const getMastraPostgresConfig = () => ({
  connectionString: getMastraPostgresConnectionString(),
  schemaName: mastraSchemaName,
});
