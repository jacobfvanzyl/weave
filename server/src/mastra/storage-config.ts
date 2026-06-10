import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const localDataDir = join(process.cwd(), '.data');
mkdirSync(localDataDir, { recursive: true });

export const localStorageUrl = pathToFileURL(join(localDataDir, 'mastra.db')).href;
export const storageUrl = process.env.TURSO_DATABASE_URL ?? process.env.MASTRA_STORAGE_URL ?? localStorageUrl;
export const storageAuthToken = process.env.TURSO_AUTH_TOKEN ?? process.env.MASTRA_STORAGE_AUTH_TOKEN;
