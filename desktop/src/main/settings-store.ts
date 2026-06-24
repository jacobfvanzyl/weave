import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopConnectionInput, DesktopConnectionSettings } from '../shared/desktop-api';
import { DEFAULT_MASTRA_URL, normalizeMastraUrl } from '../shared/connection';

type PersistedConnectionSettings = {
  mastraUrl?: string;
  encryptedAuthToken?: string;
};

export type EncryptionProvider = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

export type ConnectionSettingsStoreOptions = {
  userDataPath: string;
  encryption: EncryptionProvider;
  env?: Record<string, string | undefined>;
};

const optionalString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseEnvText = (text: string) => {
  const env: Record<string, string | undefined> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    env[key] = value;
  }
  return env;
};

const loadServerEnv = () => {
  const candidates = [
    process.env.WEAVE_SERVER_ENV_FILE,
    path.join(process.cwd(), '../server/.env'),
    path.join(process.cwd(), 'server/.env'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return parseEnvText(readFileSync(candidate, 'utf8'));
    } catch {
      // Ignore malformed or unreadable local env files; explicit process env still works.
    }
  }

  return {};
};

const hasExplicitAuthEnv = (env: Record<string, string | undefined>) =>
  Object.hasOwn(env, 'WEAVE_OWNER_TOKEN') ||
  Object.hasOwn(env, 'WEAVE_AUTH_TOKEN') ||
  Object.hasOwn(env, 'WEAVE_AUTH_TOKENS') ||
  Object.hasOwn(env, 'VITE_WEAVE_AUTH_TOKEN');

const authTokenFromLegacyMap = (rawTokens: string | undefined) => {
  const raw = optionalString(rawTokens);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const tokens = Object.keys(parsed).filter(token => token.trim());
    return tokens.length === 1 ? tokens[0] : undefined;
  } catch {
    return undefined;
  }
};

export class ConnectionSettingsStore {
  private readonly filePath: string;
  private readonly encryption: EncryptionProvider;
  private readonly env: Record<string, string | undefined>;
  private sessionAuthToken: string | undefined;

  constructor({ userDataPath, encryption, env }: ConnectionSettingsStoreOptions) {
    const baseEnv = env ?? process.env;
    this.filePath = path.join(userDataPath, 'connection.json');
    this.encryption = encryption;
    this.env = env === undefined && !hasExplicitAuthEnv(baseEnv) ? { ...loadServerEnv(), ...baseEnv } : baseEnv;
    this.sessionAuthToken = this.getEnvAuthToken();
  }

  getSettings(): DesktopConnectionSettings {
    const persisted = this.readPersisted();
    return {
      mastraUrl: this.getMastraUrl(persisted),
      hasAuthToken: Boolean(this.getAuthToken(persisted)),
    };
  }

  getAuthToken(persisted = this.readPersisted()) {
    if (this.sessionAuthToken) return this.sessionAuthToken;
    if (!persisted.encryptedAuthToken || !this.encryption.isEncryptionAvailable()) return undefined;

    try {
      return this.encryption.decryptString(Buffer.from(persisted.encryptedAuthToken, 'base64'));
    } catch {
      return undefined;
    }
  }

  saveSettings(input: DesktopConnectionInput): DesktopConnectionSettings {
    const persisted = this.readPersisted();
    persisted.mastraUrl = normalizeMastraUrl(input.mastraUrl);

    if (Object.hasOwn(input, 'authToken')) {
      const authToken = input.authToken?.trim();

      if (!authToken) {
        delete persisted.encryptedAuthToken;
        this.sessionAuthToken = undefined;
      } else if (this.encryption.isEncryptionAvailable()) {
        persisted.encryptedAuthToken = this.encryption.encryptString(authToken).toString('base64');
        this.sessionAuthToken = undefined;
      } else {
        delete persisted.encryptedAuthToken;
        this.sessionAuthToken = authToken;
      }
    }

    this.writePersisted(persisted);
    return this.getSettings();
  }

  private getMastraUrl(persisted = this.readPersisted()) {
    return normalizeMastraUrl(
      persisted.mastraUrl ?? this.env.WEAVE_DESKTOP_SERVER_URL ?? this.env.VITE_MASTRA_URL ?? DEFAULT_MASTRA_URL,
    );
  }

  private getEnvAuthToken() {
    return optionalString(this.env.WEAVE_OWNER_TOKEN)
      ?? optionalString(this.env.WEAVE_AUTH_TOKEN)
      ?? optionalString(this.env.VITE_WEAVE_AUTH_TOKEN)
      ?? authTokenFromLegacyMap(this.env.WEAVE_AUTH_TOKENS);
  }

  private readPersisted(): PersistedConnectionSettings {
    if (!existsSync(this.filePath)) return {};

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedConnectionSettings;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writePersisted(settings: PersistedConnectionSettings) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
}
