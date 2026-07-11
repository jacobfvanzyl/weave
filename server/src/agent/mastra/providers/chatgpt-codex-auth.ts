import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chatGPTCredentialRepository, type ChatGPTCredentials } from '../../credentials/chatgpt-credential-repository';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ACCOUNT_CLAIM = 'https://api.openai.com/auth';
const redirectUri = 'http://localhost:1455/auth/callback';
const loginLifetimeMs = 5 * 60_000;

export type CodexCredentials = ChatGPTCredentials;

type PendingLogin = {
  verifier: string;
  expiresAt: number;
  ownerId: string;
};

type CredentialStore = Pick<typeof chatGPTCredentialRepository, 'get' | 'put'>;

type CodexAuthServiceOptions = {
  credentials?: CredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
  random?: (size: number) => Uint8Array;
};

const base64Url = (input: Uint8Array | ArrayBuffer) =>
  Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input)).toString('base64url');

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  const payload = token.split('.')[1];
  if (!payload) return undefined;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

export const extractCodexAccountId = (token: string): string | undefined => {
  const payload = decodeJwtPayload(token);
  const auth = payload?.[ACCOUNT_CLAIM];
  const nested = auth && typeof auth === 'object' && 'chatgpt_account_id' in auth ? auth.chatgpt_account_id : undefined;
  const direct = payload?.chatgpt_account_id;
  const organizations = payload?.organizations;
  const organizationId =
    Array.isArray(organizations) && organizations[0] && typeof organizations[0] === 'object' && 'id' in organizations[0]
      ? organizations[0].id
      : undefined;

  if (typeof nested === 'string' && nested.length > 0) return nested;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof organizationId === 'string' && organizationId.length > 0) return organizationId;
  return undefined;
};

const requireValue = (value: string, label: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

export class ChatGPTCodexAuthService {
  private readonly credentials: CredentialStore;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly refreshes = new Map<string, Promise<CodexCredentials>>();

  constructor(options: CodexAuthServiceOptions = {}) {
    this.credentials = options.credentials ?? chatGPTCredentialRepository;
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((size) => randomBytes(size));
  }

  startBrowserLogin(ownerId: string) {
    const normalizedOwnerId = requireValue(ownerId, 'Owner id');
    const verifier = base64Url(this.random(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const state = base64Url(this.random(24));
    const expiresAt = this.now() + loginLifetimeMs;
    const url = new URL(AUTHORIZE_URL);

    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email offline_access');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'mage-hand');

    this.pendingLogins.set(state, { verifier, expiresAt, ownerId: normalizedOwnerId });
    return { url: url.toString(), state, expiresAt };
  }

  async completeBrowserLogin({ ownerId, code, state }: { ownerId: string; code: string; state: string }) {
    const normalizedOwnerId = requireValue(ownerId, 'Owner id');
    const normalizedCode = requireValue(code, 'Authorization code');
    const normalizedState = requireValue(state, 'Login state');
    const pending = this.pendingLogins.get(normalizedState);
    this.pendingLogins.delete(normalizedState);

    if (!pending) throw new Error('Login state expired or not found.');
    if (pending.expiresAt < this.now()) throw new Error('Login state expired or not found.');
    if (pending.ownerId !== normalizedOwnerId) throw new Error('Login state belongs to a different owner.');

    const credentials = await this.exchangeCode(normalizedCode, pending.verifier);
    if (!credentials.accountId) throw new Error('Could not extract ChatGPT account id from login token.');
    await this.credentials.put(normalizedOwnerId, credentials);
    return credentials;
  }

  async getAuthStatus(ownerId: string) {
    const credentials = await this.credentials.get(requireValue(ownerId, 'Owner id'));
    return {
      connected: Boolean(credentials?.access),
      accountId: credentials?.accountId,
      expires: credentials?.expires,
    };
  }

  async getCredentials(ownerId: string): Promise<CodexCredentials> {
    const normalizedOwnerId = requireValue(ownerId, 'Credential owner id');
    const credentials = await this.credentials.get(normalizedOwnerId);
    if (!credentials?.access) {
      throw new Error('No ChatGPT Codex credentials. Connect ChatGPT from Weave Desktop first.');
    }
    if (!this.shouldRefresh(credentials)) return this.withAccountId(credentials);

    const activeRefresh = this.refreshes.get(normalizedOwnerId);
    if (activeRefresh) return await activeRefresh;

    const refresh = this.refreshOwnerCredentials(normalizedOwnerId).finally(() => {
      if (this.refreshes.get(normalizedOwnerId) === refresh) this.refreshes.delete(normalizedOwnerId);
    });
    this.refreshes.set(normalizedOwnerId, refresh);
    return await refresh;
  }

  private shouldRefresh(credentials: CodexCredentials) {
    const expires = credentials.expires ?? 0;
    return Boolean(credentials.refresh && expires > 0 && expires - this.now() < 60_000);
  }

  private withAccountId(credentials: CodexCredentials) {
    const accountId = credentials.accountId ?? extractCodexAccountId(credentials.access);
    if (!accountId) throw new Error('Could not extract ChatGPT account id from Codex access token.');
    return { ...credentials, accountId };
  }

  private async refreshOwnerCredentials(ownerId: string) {
    const current = await this.credentials.get(ownerId);
    if (!current?.access) {
      throw new Error('No ChatGPT Codex credentials. Connect ChatGPT from Weave Desktop first.');
    }
    if (!this.shouldRefresh(current)) return this.withAccountId(current);
    if (!current.refresh) return this.withAccountId(current);

    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) throw new Error(`ChatGPT Codex token refresh failed (${response.status}).`);

    const json = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) throw new Error('ChatGPT Codex token refresh response missing access token.');

    const next: CodexCredentials = {
      access: json.access_token,
      refresh: json.refresh_token ?? current.refresh,
      expires: this.now() + (json.expires_in ?? 3600) * 1000,
      accountId: extractCodexAccountId(json.access_token) ?? current.accountId,
    };
    const resolved = this.withAccountId(next);
    await this.credentials.put(ownerId, resolved);
    return resolved;
  }

  private async exchangeCode(code: string, verifier: string): Promise<CodexCredentials> {
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) throw new Error(`ChatGPT Codex token exchange failed (${response.status}).`);

    const json = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };
    if (!json.access_token || !json.refresh_token) {
      throw new Error('ChatGPT Codex token exchange response missing tokens.');
    }
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: this.now() + (json.expires_in ?? 3600) * 1000,
      accountId: extractCodexAccountId(json.id_token ?? '') ?? extractCodexAccountId(json.access_token),
    };
  }
}

export const chatGPTCodexAuthService = new ChatGPTCodexAuthService();

export const startCodexBrowserLogin = (ownerId: string) => chatGPTCodexAuthService.startBrowserLogin(ownerId);

export const completeCodexBrowserLogin = (input: { ownerId: string; code: string; state: string }) =>
  chatGPTCodexAuthService.completeBrowserLogin(input);

export const getCodexAuthStatus = (ownerId: string) => chatGPTCodexAuthService.getAuthStatus(ownerId);

export const getCodexCredentials = (ownerId: string) => chatGPTCodexAuthService.getCredentials(ownerId);
