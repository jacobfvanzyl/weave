import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ACCOUNT_CLAIM = 'https://api.openai.com/auth';
const localAuthPath = join(homedir(), '.mage-hand', 'chatgpt-auth.json');
const redirectUri = 'http://localhost:1455/auth/callback';

export interface CodexCredentials {
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

type PendingLogin = {
  verifier: string;
  expires: number;
};

const pendingLogins = new Map<string, PendingLogin>();
let callbackServer: http.Server | undefined;

const base64Url = (input: Buffer | ArrayBuffer) =>
  Buffer.from(input).toString('base64url');

const createVerifier = () => base64Url(randomBytes(32));
const createChallenge = (verifier: string) => base64Url(createHash('sha256').update(verifier).digest());
const createState = () => base64Url(randomBytes(24));

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
  const nested = auth && typeof auth === 'object' && 'chatgpt_account_id' in auth
    ? auth.chatgpt_account_id
    : undefined;
  const direct = payload?.chatgpt_account_id;
  const organizations = payload?.organizations;
  const organizationId = Array.isArray(organizations) && organizations[0] && typeof organizations[0] === 'object' && 'id' in organizations[0]
    ? organizations[0].id
    : undefined;

  if (typeof nested === 'string' && nested.length > 0) return nested;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof organizationId === 'string' && organizationId.length > 0) return organizationId;
  return undefined;
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const readLocalCredentials = async (): Promise<CodexCredentials | undefined> => {
  return readJson<CodexCredentials>(localAuthPath);
};

const writeLocalCredentials = async (credentials: CodexCredentials) => {
  await mkdir(dirname(localAuthPath), { recursive: true });
  await writeFile(localAuthPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
};

const exchangeCode = async (code: string, verifier: string): Promise<CodexCredentials> => {
  const response = await fetch(TOKEN_URL, {
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

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`ChatGPT Codex token exchange failed (${response.status}): ${text}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  if (!json.access_token || !json.refresh_token) throw new Error('ChatGPT Codex token exchange response missing tokens');

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    accountId: extractCodexAccountId(json.id_token ?? '') ?? extractCodexAccountId(json.access_token),
  };
};

const successHtml = () => '<!doctype html><html><head><title>ChatGPT Connected</title></head><body><h1>ChatGPT Connected</h1><p>You can close this window and return to Mage Hand.</p><script>setTimeout(() => window.close(), 1200)</script></body></html>';
const errorHtml = (message: string) => `<!doctype html><html><head><title>ChatGPT Login Failed</title></head><body><h1>ChatGPT Login Failed</h1><p>${message}</p></body></html>`;

const ensureCallbackServer = () => {
  if (callbackServer?.listening) return;

  callbackServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost:1455');
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (error) throw new Error(error);
        if (!code || !state) throw new Error('Missing code or state');

        await completeCodexBrowserLogin({ code, state });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(successHtml());
      } catch (callbackError) {
        const message = callbackError instanceof Error ? callbackError.message : String(callbackError);
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorHtml(message));
      }
    })();
  });

  callbackServer.listen(1455, '127.0.0.1');
};

const refreshCredentials = async (credentials: CodexCredentials): Promise<CodexCredentials> => {
  if (!credentials.refresh) return credentials;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`ChatGPT Codex token refresh failed (${response.status}): ${text}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token) throw new Error('ChatGPT Codex token refresh response missing access_token');

  const next = {
    access: json.access_token,
    refresh: json.refresh_token ?? credentials.refresh,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
    accountId: extractCodexAccountId(json.access_token) ?? credentials.accountId,
  };

  await writeLocalCredentials(next);
  return next;
};

export const startCodexBrowserLogin = async () => {
  ensureCallbackServer();
  const verifier = createVerifier();
  const challenge = createChallenge(verifier);
  const state = createState();
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

  pendingLogins.set(state, { verifier, expires: Date.now() + 5 * 60_000 });
  return { url: url.toString(), state };
};

export const completeCodexBrowserLogin = async ({ code, state }: { code: string; state: string }) => {
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);

  if (!pending || pending.expires < Date.now()) throw new Error('Login state expired or not found');

  const credentials = await exchangeCode(code, pending.verifier);
  if (!credentials.accountId) throw new Error('Could not extract ChatGPT account id from login token');

  await writeLocalCredentials(credentials);
  return credentials;
};

export const getCodexAuthStatus = async () => {
  const credentials = await readLocalCredentials();
  return {
    connected: Boolean(credentials?.access),
    accountId: credentials?.accountId,
    expires: credentials?.expires,
    authPath: localAuthPath,
  };
};

export const getCodexCredentials = async (): Promise<CodexCredentials> => {
  const credentials = await readLocalCredentials();
  if (!credentials?.access) {
    throw new Error('No ChatGPT Codex credentials. Connect ChatGPT from Mage Hand login first.');
  }

  const expires = credentials.expires ?? 0;
  const shouldRefresh = Boolean(credentials.refresh && expires > 0 && expires - Date.now() < 60_000);
  const fresh = shouldRefresh ? await refreshCredentials(credentials) : credentials;
  const accountId = fresh.accountId ?? extractCodexAccountId(fresh.access);

  if (!accountId) throw new Error('Could not extract ChatGPT account id from Codex access token');
  return { ...fresh, accountId };
};
