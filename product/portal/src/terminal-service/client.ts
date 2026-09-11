import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { openSync, closeSync, constants } from 'node:fs';
import { mkdir, lstat, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { encodeServiceFrame, ServiceFrameReader, serviceDirectory, TERMINAL_SERVICE_VERSION, TERMINAL_CODEC, MAX_STREAM_BYTES, type ServiceHeader, type ServiceRecord } from './contract.ts';

export class TerminalServiceClient {
  #socket?: Socket;
  #opening?: Promise<void>;
  #nextId = 0;
  #pending = new Map<number, { resolve: (value: ServiceHeader & { payload: Buffer }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #listeners = new Set<(header: ServiceHeader, payload: Buffer) => void>();
  #generation?: string;
  #closed = false;
  constructor(readonly stateDirectory: string, readonly executable?: string) {}
  get generation() { return this.#generation; }
  subscribe(listener: (header: ServiceHeader, payload: Buffer) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  async open() {
    if (this.#closed) throw new Error('Terminal Service connection closed');
    if (this.#opening) return this.#opening;
    if (this.#socket && !this.#socket.destroyed) return;
    return this.#opening ??= this.#connect().finally(() => { this.#opening = undefined; });
  }
  async #connect(): Promise<void> {
    const directory = serviceDirectory(this.stateDirectory), path = join(directory, 'service.sock');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error('Unsafe Terminal Service IPC directory');
    const attempt = () => new Promise<Socket>((resolve, reject) => {
      const socket = connect(path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Terminal Service connection timed out')); }, 2000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    });
    let socket: Socket;
    try { socket = await attempt(); }
    catch (error) {
      if (!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const lock = join(directory, 'start.lock');
      let acquired = false;
      try {
        await mkdir(lock, { mode: 0o700 }); acquired = true;
        await writeFile(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
        // A failed owner cannot be replaced silently; this is also checked by
        // the service. Never turn its old live registry into an empty listing.
        try { const registry = JSON.parse(await readFile(join(this.stateDirectory, 'terminal-service.json'), 'utf8')); if (registry.terminals?.length) throw new Error('Terminal Service owner unavailable with live sessions; maintenance required'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rm(path, { force: true });
        const executable = this.executable ?? (process.execPath.includes('weave-portal') ? join(dirname(await realpath(process.execPath)), 'weave-terminal-service') : join(import.meta.dir, '../../dist/weave-terminal-service'));
        await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
        const log = openSync(join(this.stateDirectory, 'terminal-service.log'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          const child = spawn(executable, [this.stateDirectory], { detached: true, stdio: ['ignore', 'ignore', log], env: process.env });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref();
        } finally { closeSync(log); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { if (acquired) await rm(lock, { recursive: true, force: true }); throw error; }
        const owner = Number(await readFile(join(lock, 'owner'), 'utf8').catch(() => ''));
        if (Number.isInteger(owner) && owner > 1) {
          try { process.kill(owner, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
              await rm(lock, { recursive: true, force: true }); return this.#connect();
            }
          }
        }
      }

      let connected: Socket | undefined;
      // A freshly installed signed executable can take several seconds on macOS.
      const startupDeadline = Date.now() + 10000;
      while (Date.now() < startupDeadline) {
        try { connected = await attempt(); break; } catch { await Bun.sleep(50); }
      }
      if (acquired) await rm(lock, { recursive: true, force: true });
      if (!connected) throw new Error('Terminal Service did not start; inspect terminal-service.log in Host state, installation components, and startup lock ownership');
      socket = connected;
    }
    if (this.#closed) { socket.destroy(); throw new Error('Terminal Service connection closed'); }
    this.#socket = socket;
    const reader = new ServiceFrameReader();
    socket.on('data', bytes => {
      try { reader.receive(typeof bytes === 'string' ? Buffer.from(bytes) : bytes, (header, payload) => {
        if (header.event) { for (const listener of this.#listeners) listener(header, payload); return; }
        const pending = this.#pending.get(header.id as number); if (!pending) return;
        this.#pending.delete(header.id as number); clearTimeout(pending.timer);
        if (typeof header.error === 'string') pending.reject(new Error(header.error)); else pending.resolve({ ...(header.result as ServiceHeader), payload });
      }); } catch (error) { socket.destroy(error as Error); }
    });
    const lost = () => {
      if (this.#socket !== socket) return; this.#socket = undefined;
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Terminal Service disconnected; pending input is uncertain')); }
      this.#pending.clear();
      for (const listener of this.#listeners) listener({ event: 'unavailable', generation: this.#generation }, Buffer.alloc(0));
    };
    socket.on('error', lost); socket.on('close', lost);
    try {
      const result = await this.#request({ method: 'hello', version: TERMINAL_SERVICE_VERSION, codec: TERMINAL_CODEC });
      if (result.version !== TERMINAL_SERVICE_VERSION || result.codec !== TERMINAL_CODEC || typeof result.generation !== 'string') throw new Error('Incompatible Terminal Service');
      this.#generation = result.generation;
    } catch (error) { socket.destroy(); throw error; }
  }
  #request(header: ServiceHeader, payload?: Buffer) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('Terminal Service unavailable'));
    if (this.#pending.size >= 1024 || socket.writableLength > MAX_STREAM_BYTES) return Promise.reject(new Error('Terminal Service backpressure'));
    const id = ++this.#nextId;
    return new Promise<ServiceHeader & { payload: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Terminal Service operation timed out; input acceptance may be uncertain')); socket.destroy(); }, 10000);
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(encodeServiceFrame({ ...header, id }, payload));
    });
  }
  async request(header: ServiceHeader, payload?: Buffer) { await this.open(); return this.#request({ ...header, generation: this.#generation }, payload); }
  async list(): Promise<ServiceRecord[]> { return (await this.request({ method: 'list' })).terminals as ServiceRecord[]; }
  dispose() { this.#closed = true; this.#socket?.destroy(); }
}
