import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
};

type LoginStart = {
  url: string;
  state: string;
  expiresAt: number;
};

type ChatGPTLoginBrokerOptions = {
  requestRpc: (method: string, params?: unknown) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
  host?: string;
  port?: number;
  now?: () => number;
};

const successHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Connected</title></head><body><h1>ChatGPT Connected</h1><p>You can close this window and return to Weave.</p><script>setTimeout(() => window.close(), 1200)</script></body></html>';

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const failureHtml = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Login Failed</title></head><body><h1>ChatGPT Login Failed</h1><p>${
    escapeHtml(message)
  }</p></body></html>`;

const parseStart = (value: unknown): LoginStart => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (
    typeof record.url !== 'string' ||
    typeof record.state !== 'string' ||
    typeof record.expiresAt !== 'number' ||
    !Number.isFinite(record.expiresAt)
  ) {
    throw new Error('ChatGPT login start response was invalid.');
  }
  return { url: record.url, state: record.state, expiresAt: record.expiresAt };
};

const parseStatus = (value: unknown): ChatGPTAuthStatus => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (record.connected !== true) throw new Error('ChatGPT login completion response was invalid.');
  return {
    connected: true,
    ...(typeof record.accountId === 'string' ? { accountId: record.accountId } : {}),
    ...(typeof record.expires === 'number' ? { expires: record.expires } : {}),
  };
};

export class ChatGPTLoginBroker {
  private readonly host: string;
  private readonly port: number;
  private readonly now: () => number;
  private inFlight: Promise<ChatGPTAuthStatus> | undefined;
  private abortActive: (() => void) | undefined;

  constructor(private readonly options: ChatGPTLoginBrokerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 1455;
    this.now = options.now ?? Date.now;
  }

  connect(): Promise<ChatGPTAuthStatus> {
    if (this.inFlight) return this.inFlight;
    const attempt = this.runAttempt();
    const tracked = attempt.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  dispose() {
    this.abortActive?.();
  }

  private runAttempt(): Promise<ChatGPTAuthStatus> {
    return new Promise((resolve, reject) => {
      let server: Server | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let expectedState: string | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        this.abortActive = undefined;
        server?.close();
      };
      const finish = (error?: unknown, status?: ChatGPTAuthStatus) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else if (status) resolve(status);
        else reject(new Error('ChatGPT login ended without a result.'));
      };
      this.abortActive = () => finish(new Error('ChatGPT login was cancelled because Weave is closing.'));

      server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`);
          if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
          }

          const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          try {
            if (providerError) throw new Error(providerError);
            if (!code || !state) throw new Error('OpenAI callback did not include code and state.');
            if (!expectedState || state !== expectedState) {
              throw new Error('OpenAI callback state did not match this login attempt.');
            }

            const completion = await this.options.requestRpc('agent.chatgpt.login.complete', { code, state });
            const status = parseStatus(completion);
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(successHtml);
            finish(undefined, status);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
            response.end(failureHtml(message));
            finish(error);
          }
        })();
      });

      server.once('error', (error) =>
        finish(
          error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
            ? new Error(
              `Port ${this.port} is already in use. Close the other ChatGPT login or Codex process and try again.`,
            )
            : error,
        ));
      server.listen(this.port, this.host, () => {
        void (async () => {
          try {
            const address = server?.address() as AddressInfo | null;
            if (!address) throw new Error('Desktop callback listener did not start.');
            const login = parseStart(await this.options.requestRpc('agent.chatgpt.login.start'));
            expectedState = login.state;
            const remainingMs = login.expiresAt - this.now();
            if (remainingMs <= 0) throw new Error('ChatGPT login expired before the browser could open.');
            timeout = setTimeout(() => finish(new Error('ChatGPT login timed out. Try again.')), remainingMs);
            await this.options.openExternal(login.url);
          } catch (error) {
            finish(error);
          }
        })();
      });
    });
  }
}
