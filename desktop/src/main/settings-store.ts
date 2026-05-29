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

export class ConnectionSettingsStore {
  private readonly filePath: string;
  private readonly encryption: EncryptionProvider;
  private readonly env: Record<string, string | undefined>;
  private sessionAuthToken: string | undefined;

  constructor({ userDataPath, encryption, env = process.env }: ConnectionSettingsStoreOptions) {
    this.filePath = path.join(userDataPath, 'connection.json');
    this.encryption = encryption;
    this.env = env;
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
    return this.env.WEAVE_AUTH_TOKEN?.trim() || this.env.VITE_WEAVE_AUTH_TOKEN?.trim() || undefined;
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
