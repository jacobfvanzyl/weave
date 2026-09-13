import { request } from 'node:http';
import { browserSocketPath, BROWSER_SERVICE_VERSION, MAX_BROWSER_MESSAGE_BYTES } from './service.ts';
import type { WorkspaceBrowser, ProfileBrowser } from './owner.ts';
import { startBrowserService } from './start.ts';
import { parseBrowserNotification, parseBrowserRpcResult, type BrowserRpcMethod, type BrowserRpcContracts } from '@weave/product-protocol';
import { parseBrowserProfileRpcResult, type BrowserProfileRpcMethod, type BrowserProfileRpcContracts } from '@weave/product-protocol';

/** Closing a Portal-side client releases IPC only; the service owns Chromium. */
export class BrowserServiceClient {
  #generation?: string;
  #ownerPid?: number;
  #opening?: Promise<void>;
  #id = 0;
  #closed = false;
  #requests = new Set<ReturnType<typeof request>>();
  constructor(readonly stateDirectory: string, private chromiumExecutable?: string, private cefExecutable?: string) {}
  get managedPagesEnabled() { return Boolean(this.cefExecutable); }
  get ownerPid() { return this.#ownerPid; }
  async open() {
    if (this.#closed) throw new Error('Browser Service client closed');
    if (this.#generation) return;
    return this.#opening ??= (async () => {
      const hello = async () => {
        const result = await this.#request<{ version: number; generation: string; pid: number }>('hello', { version: BROWSER_SERVICE_VERSION });
        if (result.version !== BROWSER_SERVICE_VERSION || typeof result.generation !== 'string' || !Number.isSafeInteger(result.pid) || result.pid <= 1) throw new Error('Incompatible Browser Service');
        this.#generation = result.generation;
        this.#ownerPid = result.pid;
      };
      try { await hello(); }
      catch (error) {
        // Bun's node:http compatibility layer reports an absent Unix listener as
        // FailedToOpenSocket; the starter/service still validate ownership and liveness.
        if (!this.chromiumExecutable || !['ENOENT', 'ECONNREFUSED', 'FailedToOpenSocket'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await startBrowserService(this.stateDirectory, this.chromiumExecutable, hello, this.cefExecutable);
      }
    })().finally(() => { this.#opening = undefined; });
  }
  async #call<Result>(method: string, params: object = {}) {
    await this.open();
    return this.#request<Result>(method, { ...params, serviceGeneration: this.#generation });
  }
  #request<Result>(method: string, params: object): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error('Browser Service client closed'));
    if (this.#requests.size >= 64) return Promise.reject(new Error('Browser Service client capacity exceeded'));
    const id = ++this.#id;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(body) > MAX_BROWSER_MESSAGE_BYTES) return Promise.reject(new Error('Browser request too large'));
    return new Promise((resolve, reject) => {
      const rpc = request({ socketPath: browserSocketPath(this.stateDirectory), path: '/rpc', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BROWSER_MESSAGE_BYTES) rpc.destroy(new Error('Browser response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('Browser Service unavailable');
            const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (message.id !== id || message.jsonrpc !== '2.0') throw new Error('Invalid Browser Service response');
            if (message.error) throw new Error(message.error.message);
            resolve(message.result);
          } catch (error) { reject(error); }
        });
      });
      this.#requests.add(rpc);
      const timeout = setTimeout(() => rpc.destroy(new Error('Browser Service timeout; operation may have executed')), 20000);
      rpc.on('error', reject);
      rpc.on('close', () => { clearTimeout(timeout); this.#requests.delete(rpc); });
      rpc.end(body);
    });
  }
  managedPage<Result = any>(method: string, args: object = {}): Promise<Result> { return this.#call('page.rpc', { method, arguments: args }); }
  list() { return this.#call<WorkspaceBrowser[]>('workspace.list'); }
  async profile<M extends BrowserProfileRpcMethod>(method: M, params: BrowserProfileRpcContracts[M]['params']): Promise<BrowserProfileRpcContracts[M]['result']> {
    return parseBrowserProfileRpcResult(method, await this.#call('profile.rpc', { method, arguments: params }));
  }
  openProfile(profileId: string) { return this.#call<ProfileBrowser>('profile.open', { profileId }); }
  sendProfile<Result = any>(profileId: string, generation: string, method: string, args: object = {}, sessionId?: string) {
    return this.#call<Result>('profile.cdp.send', { profileId, generation, method, arguments: args, ...(sessionId ? { sessionId } : {}) });
  }
  async browser<M extends BrowserRpcMethod>(method: M, params: BrowserRpcContracts[M]['params']): Promise<BrowserRpcContracts[M]['result']> {
    return parseBrowserRpcResult(method, await this.#call('browser.rpc', { method, arguments: params }));
  }
  async events(workspaceId: string, viewId: string) {
    const events = await this.#call<unknown[]>('browser.events', { workspaceId, viewId });
    if (!Array.isArray(events)) throw new Error('Invalid browser events');
    return events.map(parseBrowserNotification);
  }
  renew(workspaceId: string, viewId: string) { return this.#call<{ expiresAt: number }>('browser.renew', { workspaceId, viewId }); }
  detach(workspaceId: string, viewId: string) { return this.#call('browser.detach', { workspaceId, viewId }); }
  openWorkspace(workspaceId: string) { return this.#call<WorkspaceBrowser>('workspace.open', { workspaceId }); }
  closeWorkspace(workspaceId: string, generation: string) { return this.#call<void>('workspace.close', { workspaceId, generation }); }
  send<Result = any>(workspaceId: string, generation: string, method: string, args: object = {}, sessionId?: string) {
    return this.#call<Result>('cdp.send', { workspaceId, generation, method, arguments: args, ...(sessionId ? { sessionId } : {}) });
  }
  dispose() {
    this.#closed = true;
    for (const rpc of this.#requests) rpc.destroy(new Error('Browser Service client closed; pending operations may have executed'));
  }
}
