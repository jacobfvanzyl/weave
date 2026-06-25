import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const serverRoot = process.cwd();
const currentDataDir = join(serverRoot, '.data');
const legacyDataDir = join(serverRoot, 'src', 'mastra', 'public', '.data');
const legacyStoragePath = join(legacyDataDir, 'mastra.db');

export const localDataDir = process.env.WEAVE_DATA_DIR
  ?? process.env.MASTRA_LOCAL_DATA_DIR
  ?? (existsSync(legacyStoragePath) ? legacyDataDir : currentDataDir);
mkdirSync(localDataDir, { recursive: true });

export const localStorageUrl = pathToFileURL(join(localDataDir, 'mastra.db')).href;
export const storageUrl = process.env.TURSO_DATABASE_URL ?? process.env.MASTRA_STORAGE_URL ?? localStorageUrl;
export const storageAuthToken = process.env.TURSO_AUTH_TOKEN ?? process.env.MASTRA_STORAGE_AUTH_TOKEN;
