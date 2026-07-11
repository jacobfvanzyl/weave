import { Buffer } from 'node:buffer';
import { ChatGPTCodexAuthService, type CodexCredentials } from './chatgpt-codex-auth.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

class MemoryCredentials {
  values = new Map<string, CodexCredentials>();
  puts = 0;
  async get(ownerId: string) {
    return this.values.get(ownerId);
  }
  async put(ownerId: string, credentials: CodexCredentials) {
    this.puts += 1;
    this.values.set(ownerId, credentials);
  }
}

const jwt = (accountId: string) =>
  [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })).toString('base64url'),
    'signature',
  ].join('.');

const tokenResponse = (accountId = 'account-1') =>
  new Response(
    JSON.stringify({
      access_token: jwt(accountId),
      refresh_token: 'refresh-secret',
      expires_in: 3600,
      id_token: jwt(accountId),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

Deno.test('ChatGPTCodexAuthService creates owner-bound PKCE login and completes it once', async () => {
  const credentials = new MemoryCredentials();
  let capturedBody = '';
  const service = new ChatGPTCodexAuthService({
    credentials,
    now: () => 1_000,
    random: (size) => new Uint8Array(size).fill(size),
    fetch: async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      return tokenResponse();
    },
  });

  const login = service.startBrowserLogin('owner-1');
  const url = new URL(login.url);
  assertEquals(url.origin, 'https://auth.openai.com');
  assertEquals(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(login.expiresAt, 301_000);

  const result = await service.completeBrowserLogin({ ownerId: 'owner-1', code: 'one-time-code', state: login.state });
  assertEquals(result.accountId, 'account-1');
  assert(capturedBody.includes('code=one-time-code'), 'authorization code should be exchanged');
  assertEquals(credentials.values.get('owner-1')?.refresh, 'refresh-secret');

  await service.completeBrowserLogin({ ownerId: 'owner-1', code: 'replay', state: login.state }).then(
    () => {
      throw new Error('expected replay rejection');
    },
    (error) => assert(String(error).includes('expired or not found'), 'expected single-use state'),
  );
});

Deno.test('ChatGPTCodexAuthService rejects expired and cross-owner login state before exchange', async () => {
  const credentials = new MemoryCredentials();
  let now = 1_000;
  let requests = 0;
  const service = new ChatGPTCodexAuthService({
    credentials,
    now: () => now,
    fetch: async () => {
      requests += 1;
      return tokenResponse();
    },
  });

  const crossOwner = service.startBrowserLogin('owner-1');
  await service.completeBrowserLogin({ ownerId: 'owner-2', code: 'code', state: crossOwner.state }).then(
    () => {
      throw new Error('expected owner rejection');
    },
    (error) => assert(String(error).includes('different owner'), 'expected owner-bound state'),
  );

  const expired = service.startBrowserLogin('owner-1');
  now = expired.expiresAt + 1;
  await service.completeBrowserLogin({ ownerId: 'owner-1', code: 'code', state: expired.state }).then(
    () => {
      throw new Error('expected expiry rejection');
    },
    (error) => assert(String(error).includes('expired or not found'), 'expected expired state'),
  );
  assertEquals(requests, 0);
});

Deno.test('ChatGPTCodexAuthService serializes refreshes for one owner', async () => {
  const credentials = new MemoryCredentials();
  credentials.values.set('owner-1', {
    access: jwt('account-1'),
    refresh: 'old-refresh',
    expires: 1_000,
    accountId: 'account-1',
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const service = new ChatGPTCodexAuthService({
    credentials,
    now: () => 1_000,
    fetch: async () => {
      requests += 1;
      await gate;
      return tokenResponse('account-1');
    },
  });

  const first = service.getCredentials('owner-1');
  const second = service.getCredentials('owner-1');
  await Promise.resolve();
  release();
  const [left, right] = await Promise.all([first, second]);
  assertEquals(requests, 1);
  assertEquals(left.access, right.access);
  assertEquals(credentials.puts, 1);
});

Deno.test('ChatGPTCodexAuthService reports disconnected status and sanitizes exchange failures', async () => {
  const credentials = new MemoryCredentials();
  const disconnected = new ChatGPTCodexAuthService({ credentials });
  assertEquals(await disconnected.getAuthStatus('owner-1'), {
    connected: false,
    accountId: undefined,
    expires: undefined,
  });

  const failing = new ChatGPTCodexAuthService({
    credentials,
    fetch: async () => new Response('upstream-secret-token', { status: 401 }),
  });
  const login = failing.startBrowserLogin('owner-1');
  await failing.completeBrowserLogin({ ownerId: 'owner-1', code: 'code', state: login.state }).then(
    () => {
      throw new Error('expected exchange failure');
    },
    (error) => {
      assert(String(error).includes('(401)'), 'expected status code');
      assert(!String(error).includes('upstream-secret-token'), 'upstream response body must be redacted');
    },
  );
});
