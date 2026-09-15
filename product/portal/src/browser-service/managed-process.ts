import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { CdpPipe } from './cdp-pipe.ts';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { privateDirectory } from './chromium.ts';

export type ManagedPage = { pageId: string; title: string; url: string; rfbSocket: string; width: number; height: number; canGoBack: boolean; canGoForward: boolean; openerPageId?: string };
export type ManagedBrowserEvent = { method: string; params: Record<string, unknown> };
type Child = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
type Pending = { resolve(value: any): void; reject(cause: Error): void; timer: ReturnType<typeof setTimeout> };
const MAX_MESSAGE = 1024 * 1024;

/** One sandboxed native process per Profile. No network listeners or client-owned lifetime. */
export class ManagedBrowserProcess {
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: ManagedBrowserEvent) => void>();
  #nextId = 0;
  #failure?: Error;
  #closing?: Promise<void>;
  #version = '';
  #stderr = '';
  readonly cdp: CdpPipe;
  private exited: Promise<number | null>;
  private constructor(private child: Child, private sockets: string) {
    this.exited = new Promise(resolve => child.once('exit', resolve));
    child.on('error', error => this.#lost(error));
    this.cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  }
  get pid() { return this.child.pid!; }
  get version() { return this.#version; }
  get available() { return !this.#failure && !this.#closing && this.child.exitCode === null; }
  get failure() { return this.#failure?.message; }
  subscribe(listener: (event: ManagedBrowserEvent) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  static async launch(options: { binary: string; directory: string; startupTimeoutMs?: number }) {
    if (!isAbsolute(options.binary)) throw new Error('CEF runtime executable must be absolute');
    await privateDirectory(options.directory);
    options = { ...options, directory: await realpath(options.directory) };
    // CEF owns its cache singleton lock and recovers it after process death.
    let sockets: string | undefined, runtime: ManagedBrowserProcess | undefined;
    try {
      // macOS's long per-user TMPDIR does not fit sockaddr_un with page UUIDs.
      const socketRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
      sockets = await mkdtemp(join(socketRoot, 'weave-rfb-')); await privateDirectory(sockets);
      const child = spawn(options.binary, [options.directory, sockets], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: { ...process.env, WEAVE_BROWSER_CDP_PIPE: '1', ...(process.platform === 'linux' ? { CEF_RESOURCES: dirname(options.binary) } : {}) } }) as Child;
      runtime = new ManagedBrowserProcess(child, sockets);
      await runtime.#start(options.startupTimeoutMs ?? 15000);
      return runtime;
    } catch (cause) {
      if (runtime) await runtime.close();
      else { if (sockets) await rm(sockets, { recursive: true, force: true }); }
      throw cause;
    }
  }
  #lost(cause: Error) {
    this.#failure ??= cause;
    this.cdp.close(cause);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(cause); }
    this.#pending.clear();
  }
  async #start(timeout: number) {
    let ready!: () => void, reject!: (cause: Error) => void;
    const opening = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail; });
    const timer = setTimeout(() => reject(new Error(`CEF startup timed out. ${this.#stderr}`)), timeout);
    void this.exited.then(code => { const error = new Error(`CEF exited (${code}); live page state was lost. ${this.#stderr}`); this.#lost(error); reject(error); });
    void (async () => { const decoder = new TextDecoder(); for await (const chunk of this.child.stderr) this.#stderr = (this.#stderr + decoder.decode(chunk)).slice(-4096); })();
    void (async () => {
      let input = ''; const decoder = new TextDecoder();
      try {
        for await (const chunk of this.child.stdout) {
          input += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = input.indexOf('\n')) >= 0) {
            if (end > MAX_MESSAGE) throw new Error('CEF response too large');
            const line = input.slice(0, end); input = input.slice(end + 1); if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.jsonrpc !== '2.0') throw new Error('Invalid CEF response');
            if (message.method === 'runtime.ready') {
              if (message.params?.version !== 2 || typeof message.params.cefVersion !== 'string') throw new Error('Incompatible CEF runtime');
              this.#version = message.params.cefVersion; ready();
            } else if (typeof message.method === 'string') {
              for (const listener of this.#listeners) listener({ method: message.method, params: message.params });
            } else {
              const pending = this.#pending.get(message.id); if (!pending) continue;
              this.#pending.delete(message.id); clearTimeout(pending.timer);
              if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
            }
          }
          if (input.length > MAX_MESSAGE) throw new Error('CEF response too large');
        }
      } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); this.#lost(error); reject(error); }
    })();
    try { await opening; } finally { clearTimeout(timer); }
  }
  request<Result = any>(method: string, params: object = {}): Promise<Result> {
    if (this.#failure || this.child.exitCode !== null) return Promise.reject(this.#failure ?? new Error('CEF runtime unavailable'));
    if (this.#pending.size >= 64) return Promise.reject(new Error('CEF command capacity exceeded'));
    const id = ++this.#nextId, body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(body) > MAX_MESSAGE) return Promise.reject(new Error('CEF request too large'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CEF ${method} timed out; operation may have executed`)); }, 15000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(body, cause => { if (cause) { this.#pending.delete(id); clearTimeout(timer); reject(cause); } }); }
      catch (cause) { this.#pending.delete(id); clearTimeout(timer); reject(cause); }
    });
  }
  close() {
    return this.#closing ??= (async () => {
      if (this.child.exitCode === null) {
        await this.request('runtime.close').catch(() => {});
        await Promise.race([this.exited, Bun.sleep(6000)]);
        if (this.child.exitCode === null) { this.child.kill('SIGTERM'); await Promise.race([this.exited, Bun.sleep(1500)]); }
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
      }
      await this.exited; this.#lost(new Error('CEF runtime closed'));
      await rm(this.sockets, { recursive: true, force: true });
    })();
  }
}
