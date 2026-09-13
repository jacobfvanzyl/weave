import { lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error('Browser directory must be private to the current user');
  }
}

/** Owns only the Chromium child it launches. Closing never deletes profile data. */
export class ChromiumProcess {
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: CdpEvent) => void>();
  #failure?: Error;
  #version = '';
  #closing?: Promise<void>;
  private constructor(
    readonly directory: string,
    private child: ReturnType<typeof Bun.spawn>,
    private socket: WebSocket,
    private lock: string,
  ) {
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (typeof message.method === 'string') {
          for (const listener of this.#listeners) listener(message);
          return;
        }
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      } catch { this.#lost(new Error('Invalid Chromium debugging message')); socket.close(); }
    };
    socket.onclose = () => this.#lost(new Error('Browser disconnected; pending operations may have executed'));
    socket.onerror = () => this.#lost(new Error('Browser debugging connection failed'));
    void child.exited.then(() => this.#lost(new Error('Browser process exited; live state was lost')));
  }
  get pid() { return this.child.pid; }
  get version() { return this.#version; }
  get available() { return !this.#failure && !this.#closing && this.child.exitCode === null; }
  get failure() { return this.#failure?.message; }
  subscribe(listener: (event: CdpEvent) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #lost(error: Error) {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
  static async launch(options: { binary: string; directory: string; startupTimeoutMs?: number }) {
    if (!isAbsolute(options.directory)) throw new Error('Browser profile path must be absolute');
    await privateDirectory(options.directory);
    const lock = join(options.directory, 'weave-owner.lock');
    // Fail closed on a second owner or owner loss. Never adopt another debugging
    // endpoint or remove Chromium's SingletonLock based on a persisted PID.
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Browser profile already owned or previous owner lost; explicit recovery required');
      throw error;
    }
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let socket: WebSocket | undefined;
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
      const portFile = join(options.directory, 'DevToolsActivePort');
      await unlink(portFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      child = Bun.spawn([
        options.binary, '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
        '--enable-unsafe-extension-debugging', `--user-data-dir=${options.directory}`,
        '--no-first-run', '--no-default-browser-check', 'about:blank',
      ], { stdout: 'ignore', stderr: 'ignore' });
      const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
      let endpoint: string | undefined;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('Chromium exited before debugging became available');
        let contents: string | undefined;
        try { contents = await readFile(portFile, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (contents) {
          const [port, path] = contents.trim().split('\n');
          if (/^\d+$/.test(port!) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path!)) {
            endpoint = `ws://127.0.0.1:${port}${path}`; break;
          }
        }
        await Bun.sleep(50);
      }
      if (!endpoint) throw new Error('Chromium startup timed out');
      socket = new WebSocket(endpoint);
      const connecting = socket;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { connecting.close(); reject(new Error('CDP connection timed out')); }, Math.max(1, deadline - Date.now()));
        connecting.onopen = () => { clearTimeout(timer); resolve(); };
        connecting.onerror = connecting.onclose = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); };
      });
      const browser = new ChromiumProcess(options.directory, child, socket, lock);
      const version = await browser.send<{ product: string }>('Browser.getVersion');
      if (typeof version.product !== 'string') throw new Error('Invalid Chromium version response');
      browser.#version = version.product;
      return browser;
    } catch (error) {
      socket?.close();
      if (child) { await stopChild(child); }
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }
  send<Result = any>(method: string, params: object = {}, sessionId?: string): Promise<Result> {
    if (this.#failure || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(this.#failure ?? new Error('Browser unavailable'));
    if (!/^[A-Za-z]+\.[A-Za-z0-9]+$/.test(method)) return Promise.reject(new Error('Invalid CDP method'));
    if (this.#pending.size >= 256 || this.socket.bufferedAmount > 4 * 1024 * 1024) return Promise.reject(new Error('Browser command capacity exceeded'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP timeout: ${method}; operation may have executed`)); }, 10000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  close() {
    return this.#closing ??= (async () => {
      await this.send('Browser.close').catch(() => {});
      await Promise.race([this.child.exited, Bun.sleep(3000)]);
      await stopChild(this.child);
      this.socket.close(); this.#lost(new Error('Browser closed'));
      await rm(this.lock, { recursive: true, force: true });
    })();
  }
}

async function stopChild(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await child.exited;
}
