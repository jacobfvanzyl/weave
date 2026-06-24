import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDataDir = join(process.cwd(), '.data');
const legacyDataDir = join(dirname(fileURLToPath(import.meta.url)), 'public', '.data');
const legacyStoragePath = join(legacyDataDir, 'mastra.db');

export const localDataDir = process.env.WEAVE_DATA_DIR
  ?? process.env.MASTRA_LOCAL_DATA_DIR
  ?? (existsSync(legacyStoragePath) ? legacyDataDir : currentDataDir);
mkdirSync(localDataDir, { recursive: true });

export const localStorageUrl = pathToFileURL(join(localDataDir, 'mastra.db')).href;
export const storageUrl = process.env.TURSO_DATABASE_URL ?? process.env.MASTRA_STORAGE_URL ?? localStorageUrl;
export const storageAuthToken = process.env.TURSO_AUTH_TOKEN ?? process.env.MASTRA_STORAGE_AUTH_TOKEN;
