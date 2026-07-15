import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
} from "../shared/desktop-api";
import { DEFAULT_MASTRA_URL, normalizeMastraUrl } from "../shared/connection";

type PersistedConnectionSettings = {
  mastraUrl?: string;
  encryptedAuthToken?: string;
};

export type EncryptionProvider = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (value: string) => Promise<Buffer>;
  decryptStringAsync?: (value: Buffer) => Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
};

type AsyncEncryptionProvider =
  & EncryptionProvider
  & Required<
    Pick<
      EncryptionProvider,
      | "isAsyncEncryptionAvailable"
      | "encryptStringAsync"
      | "decryptStringAsync"
    >
  >;

export type ConnectionSettingsStoreOptions = {
  userDataPath: string;
  encryption: EncryptionProvider;
  env?: Record<string, string | undefined>;
};

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const parseEnvText = (text: string) => {
  const env: Record<string, string | undefined> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    env[key] = value;
  }
  return env;
};

const loadServerEnv = () => {
  const candidates = [
    process.env.WEAVE_SERVER_ENV_FILE,
    path.join(process.cwd(), "../server/.env"),
    path.join(process.cwd(), "server/.env"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return parseEnvText(readFileSync(candidate, "utf8"));
      }
    } catch {
      // Ignore malformed or unreadable local env files; explicit process env still works.
    }
  }

  return {};
};

const hasExplicitAuthEnv = (env: Record<string, string | undefined>) =>
  Object.hasOwn(env, "WEAVE_OWNER_TOKEN") ||
  Object.hasOwn(env, "WEAVE_AUTH_TOKEN") ||
  Object.hasOwn(env, "WEAVE_AUTH_TOKENS") ||
  Object.hasOwn(env, "VITE_WEAVE_AUTH_TOKEN");

const authTokenFromLegacyMap = (rawTokens: string | undefined) => {
  const raw = optionalString(rawTokens);
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const tokens = Object.keys(parsed).filter((token) => token.trim());
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

  constructor(
    { userDataPath, encryption, env }: ConnectionSettingsStoreOptions,
  ) {
    const baseEnv = env ?? process.env;
    this.filePath = path.join(userDataPath, "connection.json");
    this.encryption = encryption;
    this.env = env === undefined && !hasExplicitAuthEnv(baseEnv)
      ? { ...loadServerEnv(), ...baseEnv }
      : baseEnv;
    this.sessionAuthToken = this.getEnvAuthToken();
  }

  async initialize() {
    if (this.sessionAuthToken) return;

    const persisted = this.readPersisted();
    const asyncEncryption = this.getAsyncEncryption();
    if (!persisted.encryptedAuthToken || !asyncEncryption) return;

    try {
      if (!await asyncEncryption.isAsyncEncryptionAvailable()) return;
      const encrypted = Buffer.from(persisted.encryptedAuthToken, "base64");
      const decrypted = await asyncEncryption.decryptStringAsync(encrypted);
      const authToken = optionalString(decrypted.result);
      if (!authToken) return;

      this.sessionAuthToken = authToken;
      if (decrypted.shouldReEncrypt) {
        persisted.encryptedAuthToken =
          (await asyncEncryption.encryptStringAsync(authToken)).toString(
            "base64",
          );
        this.writePersisted(persisted);
      }
    } catch {
      // Retain the synchronous compatibility path used by getAuthToken().
    }
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
    if (
      !persisted.encryptedAuthToken || !this.encryption.isEncryptionAvailable()
    ) return undefined;

    try {
      return this.encryption.decryptString(
        Buffer.from(persisted.encryptedAuthToken, "base64"),
      );
    } catch {
      return undefined;
    }
  }

  saveSettings(input: DesktopConnectionInput): DesktopConnectionSettings {
    const persisted = this.readPersisted();
    persisted.mastraUrl = normalizeMastraUrl(input.mastraUrl);

    if (Object.hasOwn(input, "authToken")) {
      const authToken = input.authToken?.trim();

      if (!authToken) {
        delete persisted.encryptedAuthToken;
        this.sessionAuthToken = undefined;
      } else if (this.encryption.isEncryptionAvailable()) {
        persisted.encryptedAuthToken = this.encryption.encryptString(authToken)
          .toString("base64");
        this.sessionAuthToken = undefined;
      } else {
        delete persisted.encryptedAuthToken;
        this.sessionAuthToken = authToken;
      }
    }

    this.writePersisted(persisted);
    return this.getSettings();
  }

  async saveSettingsAsync(
    input: DesktopConnectionInput,
  ): Promise<DesktopConnectionSettings> {
    const persisted = this.readPersisted();
    persisted.mastraUrl = normalizeMastraUrl(input.mastraUrl);
    const asyncEncryption = this.getAsyncEncryption();

    if (Object.hasOwn(input, "authToken")) {
      const authToken = input.authToken?.trim();

      if (!authToken) {
        delete persisted.encryptedAuthToken;
        this.sessionAuthToken = undefined;
      } else if (
        asyncEncryption &&
        await asyncEncryption.isAsyncEncryptionAvailable()
      ) {
        persisted.encryptedAuthToken =
          (await asyncEncryption.encryptStringAsync(authToken)).toString(
            "base64",
          );
        this.sessionAuthToken = authToken;
      } else {
        return this.saveSettings(input);
      }
    }

    this.writePersisted(persisted);
    return this.getSettings();
  }

  private getMastraUrl(persisted = this.readPersisted()) {
    return normalizeMastraUrl(
      persisted.mastraUrl ?? this.env.WEAVE_DESKTOP_SERVER_URL ??
        this.env.VITE_MASTRA_URL ?? DEFAULT_MASTRA_URL,
    );
  }

  private getEnvAuthToken() {
    return optionalString(this.env.WEAVE_OWNER_TOKEN) ??
      optionalString(this.env.WEAVE_AUTH_TOKEN) ??
      optionalString(this.env.VITE_WEAVE_AUTH_TOKEN) ??
      authTokenFromLegacyMap(this.env.WEAVE_AUTH_TOKENS);
  }

  private getAsyncEncryption(): AsyncEncryptionProvider | undefined {
    if (
      typeof this.encryption.isAsyncEncryptionAvailable === "function" &&
      typeof this.encryption.encryptStringAsync === "function" &&
      typeof this.encryption.decryptStringAsync === "function"
    ) {
      return this.encryption as AsyncEncryptionProvider;
    }
    return undefined;
  }

  private readPersisted(): PersistedConnectionSettings {
    if (!existsSync(this.filePath)) return {};

    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, "utf8"),
      ) as PersistedConnectionSettings;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private writePersisted(settings: PersistedConnectionSettings) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
