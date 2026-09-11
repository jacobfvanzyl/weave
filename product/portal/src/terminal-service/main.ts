import { createServer, type Socket } from 'node:net';
import { mkdir, chmod, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { loadTerminalVt } from './native.ts';
import { encodeServiceFrame, ServiceFrameReader, serviceDirectory, TERMINAL_SERVICE_VERSION, TERMINAL_CODEC, MAX_STREAM_BYTES, type ServiceRecord, type ServiceHeader } from './contract.ts';

type Runtime = { record: ServiceRecord; vt: number; pty: Bun.Terminal; process: Bun.Subprocess; sequence: number; failure?: string; reportedDirectory?: string; stopping?: Promise<void> };
const text = (value: unknown, name: string, max = 4096) => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
};
const dimension = (value: unknown, max: number) => {
  if (!Number.isInteger(value) || (value as number) < 2 || (value as number) > max) throw new Error('Invalid terminal dimensions');
  return value as number;
};
const shells = new Set(['sh','zsh','bash','fish','dash','ksh','nu','tcsh','csh','pwsh','powershell']);
export async function serveTerminalService(stateDirectory: string, nativePath?: string) {
  process.umask(0o077);
  const directory = serviceDirectory(stateDirectory), socketPath = join(directory, 'service.sock');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error('Terminal IPC directory is not private to this user');
  const vt = loadTerminalVt(nativePath);
  const generation = crypto.randomUUID();
  const terminals = new Map<string, Runtime>();
  const clients = new Map<Socket, { ready: boolean }>();
  let idleExit: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdleExit = () => {
    clearTimeout(idleExit);
    if (!clients.size && !terminals.size) idleExit = setTimeout(() => {
      if (!clients.size && !terminals.size) server.close();
    }, 1000);
  };
  const registryPath = join(stateDirectory, 'terminal-service.json');
  let persistQueue = Promise.resolve();
  const persist = () => {
    const contents = JSON.stringify({ version: TERMINAL_SERVICE_VERSION, codec: TERMINAL_CODEC, generation, ownerPid: process.pid, terminals: [...terminals.values()].map(t => t.record) });
    persistQueue = persistQueue.then(async () => {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${registryPath}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, registryPath);
    });
    return persistQueue;
  };
  // Losing the PTY owner is an explicit maintenance event. An old registry
  // must never be silently replaced by an apparently successful empty list.
  try {
    const previous = JSON.parse(await readFile(registryPath, 'utf8'));
    if (previous.terminals?.length) throw new Error('Terminal owner was lost with live sessions. Run terminal maintenance before starting a replacement.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const send = (socket: Socket, header: ServiceHeader, payload?: Buffer) => {
    const frame = encodeServiceFrame(header, payload);
    if (socket.destroyed || socket.writableLength + frame.length > MAX_STREAM_BYTES && header.event) { socket.destroy(); return; }
    socket.write(frame);
  };
  const publish = (runtime: Runtime, event: string, fields: ServiceHeader = {}, data?: Buffer) => {
    const frame = encodeServiceFrame({ event, terminalId: runtime.record.terminalId, generation, sequence: ++runtime.sequence, ...fields }, data);
    for (const [socket, client] of clients) {
      if (!client.ready) continue;
      if (socket.writableLength + frame.length > MAX_STREAM_BYTES) socket.destroy(); else socket.write(frame);
    }
  };
  const write = (runtime: Runtime, data: Buffer) => {
    if (data.length && runtime.pty.write(data) !== data.length) throw new Error('Terminal input could not be fully accepted; do not replay uncertain input');
  };
  const metadata = (runtime: Runtime) => {
    const next = vt.metadata(runtime.vt);
    let directory = next.directory === runtime.reportedDirectory ? '' : next.directory;
    runtime.reportedDirectory = next.directory;
    if (directory.startsWith('file:')) {
      try { const url = new URL(directory); directory = !url.hostname || [hostname(), hostname().split('.')[0], 'localhost'].includes(url.hostname) ? decodeURIComponent(url.pathname) : ''; } catch { directory = ''; }
    }
    if (isAbsolute(directory) && directory.length <= 4096 && directory !== runtime.record.currentDirectory) {
      runtime.record.currentDirectory = directory;
      publish(runtime, 'directory', { currentDirectory: directory });
    }
    const title = shells.has(runtime.record.processName) ? runtime.record.currentDirectory : runtime.record.processName;
    if (title !== runtime.record.title) { runtime.record.title = title; publish(runtime, 'title', { title, processName: runtime.record.processName }); }
  };
  const stop = (runtime: Runtime) => runtime.stopping ??= (async () => {
    // Deliver HUP to the shell session, allow traps/job cleanup, then close its
    // controlling PTY. Never signal processes from a persisted, unverified PID.
    try { process.kill(-runtime.process.pid, 'SIGHUP'); } catch { runtime.process.kill('SIGHUP'); }
    await Promise.race([runtime.process.exited, Bun.sleep(1500)]);
    if (runtime.process.exitCode === null) {
      runtime.pty.close();
      try { process.kill(-runtime.process.pid, 'SIGTERM'); } catch { runtime.process.kill('SIGTERM'); }
      await Promise.race([runtime.process.exited, Bun.sleep(1000)]);
      if (runtime.process.exitCode === null) runtime.process.kill('SIGKILL');
    }
    await runtime.process.exited;
  })();
  const request = async (socket: Socket, header: ServiceHeader, payload: Buffer) => {
    const client = clients.get(socket)!;
    if (!client.ready) {
      if (header.method !== 'hello' || header.version !== TERMINAL_SERVICE_VERSION || header.codec !== TERMINAL_CODEC || payload.length) throw new Error('Terminal Service/codec mismatch; update components together');
      client.ready = true; return { version: TERMINAL_SERVICE_VERSION, codec: TERMINAL_CODEC, generation, pid: process.pid };
    }
    if (header.generation !== generation) throw new Error('Stale Terminal Service generation');
    if (header.method === 'list') { return { terminals: [...terminals.values()].map(t => ({ ...t.record })) }; }
    if (header.method === 'shutdown') {
      if (terminals.size) throw new Error('Close live Terminals before Terminal Service maintenance');
      setTimeout(() => { server.close(); for (const socket of clients.keys()) socket.end(); clearInterval(poll); }, 10);
      return { stopped: true };
    }
    const id = text(header.terminalId, 'Terminal identity', 256);
    if (header.method === 'create') {
      const context = text(header.executionContextId, 'Execution Context', 256), cwd = text(header.cwd, 'directory');
      const cols = dimension(header.cols, 500), rows = dimension(header.rows, 300);
      if (!isAbsolute(cwd)) throw new Error('Terminal directory must be absolute');
      const existing = terminals.get(id);
      if (existing) {
        if (existing.record.executionContextId !== context || existing.record.initialDirectory !== cwd) throw new Error('Terminal identity conflict');
        return { terminal: existing.record };
      }
      if (terminals.size >= 128) throw new Error('Terminal count limit reached');
      const envInput = header.env;
      if (!envInput || typeof envInput !== 'object' || Array.isArray(envInput)) throw new Error('Invalid terminal environment');
      const env: Record<string,string> = {};
      for (const [key,value] of Object.entries(envInput)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid terminal environment');
        env[key] = value;
      }
      delete env.TMUX; delete env.TMUX_PANE; delete env.NO_COLOR;
      env.TERM = 'xterm-256color'; env.COLORTERM = 'truecolor'; env.TERM_PROGRAM = 'Weave';
      const shell = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
      const handle = vt.create(cols, rows);
      let runtime: Runtime | undefined;
      // Inline creation makes Bun establish a session and controlling terminal.
      // A separately constructed Bun.Terminal skips that setup in Bun 1.3.14.
      const terminal: Bun.TerminalOptions = { cols, rows, name: 'xterm-256color', data(_pty, bytes) {
        if (!runtime || runtime.failure) return;
        try {
          const data = Buffer.from(bytes);
          write(runtime, vt.write(handle, data));
          publish(runtime, 'output', {}, data);
          metadata(runtime);
        } catch (error) { runtime.failure = String(error); console.error('Terminal VT failure:', error); for (const socket of clients.keys()) socket.destroy(); }
      } };
      let child: Bun.Subprocess;
      try { child = Bun.spawn([shell, '-l'], { cwd, env, terminal }); }
      catch (error) { vt.close(handle); throw error; }
      const pty = child.terminal!;
      runtime = { record: { terminalId: id, executionContextId: context, initialDirectory: cwd, currentDirectory: cwd, title: cwd, processName: basename(shell), cols, rows, pid: child.pid, status: 'running' }, vt: handle, pty, process: child, sequence: 0 };
      const created = runtime;
      terminals.set(id, created);
      void child.exited.then(async exitCode => {
        publish(created, 'exit', { exitCode });
        terminals.delete(id); pty.close(); vt.close(handle); await persist(); scheduleIdleExit();
      }).catch(error => { console.error('Terminal registry write failed:', error); for (const socket of clients.keys()) socket.destroy(); });
      await persist(); return { terminal: { ...runtime.record } };
    }
    const runtime = terminals.get(id);
    if (!runtime) { if (header.method === 'close') return { closed: true }; throw new Error('Terminal unavailable'); }
    if (runtime.failure && header.method !== 'close') throw new Error('Terminal emulation is unavailable; deliberate close is required');
    if (header.method === 'snapshot') { const snapshot = vt.snapshot(runtime.vt); return { boundary: runtime.sequence, terminal: { ...runtime.record }, offsets: snapshot.offsets, payload: snapshot.data }; }
    if (header.method === 'input') {
      if (!payload.length || payload.length > 65536 || runtime.stopping) throw new Error('Invalid terminal input');
      write(runtime, payload); return { accepted: true };
    }
    if (header.method === 'resize') {
      const cols = dimension(header.cols, 500), rows = dimension(header.rows, 300);
      if (cols !== runtime.record.cols || rows !== runtime.record.rows) {
        write(runtime, vt.resize(runtime.vt, cols, rows));
        runtime.pty.resize(cols, rows); runtime.record.cols = cols; runtime.record.rows = rows;
      }
      return { accepted: true };
    }
    if (header.method === 'close') { await stop(runtime); return { closed: true }; }
    throw new Error('Unknown Terminal Service operation');
  };
  const server = createServer(socket => {
    clearTimeout(idleExit); clients.set(socket, { ready: false });
    const reader = new ServiceFrameReader();
    // Socket order serializes control barriers. No caller acknowledgement is
    // required before another input frame can enter this bounded stream.
    let queue = Promise.resolve(), queuedBytes = 0;
    socket.on('data', bytes => {
      try { reader.receive(typeof bytes === 'string' ? Buffer.from(bytes) : bytes, (header, payload) => {
        const cost = payload.length + 1024; queuedBytes += cost;
        if (queuedBytes > MAX_STREAM_BYTES || !Number.isSafeInteger(header.id)) throw new Error('Terminal service request overflow');
        queue = queue.then(async () => {
          if (socket.destroyed) return;
          try { const { payload: output, ...result } = await request(socket, header, payload); send(socket, { id: header.id, result }, output as Buffer | undefined); }
          catch (error) { send(socket, { id: header.id, error: error instanceof Error ? error.message : String(error) }); if (!clients.get(socket)?.ready) socket.end(); }
        }).finally(() => { queuedBytes -= cost; });
      }); } catch { socket.destroy(); }
    });
    socket.on('error', () => {}); socket.on('close', () => { clients.delete(socket); scheduleIdleExit(); });
  });
  // OS process names, not command lines. Poll only metadata; no terminal parser
  // or shell command rewriting. A failed sample retains the last known value.
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || !terminals.size) return; polling = true;
    try {
      const child = Bun.spawn(['ps', '-axo', 'pid=,pgid=,tpgid=,comm='], { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(child.stdout).text(); if (await child.exited !== 0) return;
      const processes = output.split('\n').flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line); return m ? [{ pid: +m[1], group: +m[2], foreground: +m[3], name: basename(m[4]).replace(/^-/, '') }] : []; });
      for (const runtime of terminals.values()) {
        const shell = processes.find(p => p.pid === runtime.record.pid);
        const foreground = processes.find(p => p.group === shell?.foreground);
        if (foreground) {
          runtime.record.processName = foreground.name;
          const currentDirectory = vt.processDirectory(foreground.pid);
          if (currentDirectory && currentDirectory !== runtime.record.currentDirectory) { runtime.record.currentDirectory = currentDirectory; publish(runtime, 'directory', { currentDirectory }); }
          // OS observations supersede stale OSC metadata until another output
          // sequence explicitly reports a directory change.
          const title = shells.has(foreground.name) ? runtime.record.currentDirectory : foreground.name;
          if (title !== runtime.record.title) { runtime.record.title = title; publish(runtime, 'title', { title, processName: foreground.name }); }
        }
      }
    } catch (error) { console.error('Terminal metadata sample failed:', error); } finally { polling = false; }
  }, 1000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600); await persist();
  server.on('close', () => { clearTimeout(idleExit); clearInterval(poll); void rm(socketPath, { force: true }); });
  return { server, generation };
}
if (import.meta.main) {
  const stateDirectory = process.argv[2];
  if (!stateDirectory || !isAbsolute(stateDirectory)) throw new Error('Usage: weave-terminal-service <absolute-state-directory>');
  await serveTerminalService(stateDirectory, basename(process.execPath).startsWith('weave-terminal-service') ? join(dirname(process.execPath), 'terminal-vt.node') : undefined);
}
