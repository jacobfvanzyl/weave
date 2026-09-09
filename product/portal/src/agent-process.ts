import { isFsError } from './host-files.ts';
import { spawnProcess } from './host-process.ts';
import type { HostProcess } from './host-process.ts';
import type { AgentDefinition } from './config.ts';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage, request } from './json-rpc.ts';
import { readLines } from './line-stream.ts';

type Pending = { method: string; resolve(value: unknown): void; reject(cause: unknown): void };

export type AgentProcessExit = {
  success: boolean;
  code: number;
  signal?: string;
  stderrTail?: string;
};

const inheritedEnvironment = () => {
  const names = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'TERM',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'CODEX_HOME',
  ];
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
};

export class AgentProcess {
  readonly #child: HostProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<string, Pending>();
  readonly #encoder = new TextEncoder();
  readonly #onMessage: (message: JsonRpcMessage) => void;
  readonly #onExit: (exit: AgentProcessExit) => void;
  readonly #stderrTail: string[] = [];
  #nextId = 0;
  #closed = false;
  #intentionalClose = false;

  constructor(
    agent: AgentDefinition,
    cwd: string,
    onMessage: (message: JsonRpcMessage) => void,
    onExit: (exit: AgentProcessExit) => void = () => undefined,
  ) {
    this.#onMessage = onMessage;
    this.#onExit = onExit;
    this.#child = spawnProcess(agent.command, {
      args: agent.args,
      detached: true,
      cwd,
      env: { ...inheritedEnvironment(), ...agent.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.#writer = this.#child.stdin.getWriter();
    void this.#readMessages();
    void this.#readStderr();
    void this.#watchExit();
  }

  async request(method: string, params?: unknown) {
    const id = `portal:${++this.#nextId}`;
    const response = new Promise<unknown>((resolve, reject) =>
      this.#pending.set(idKey(id), { method, resolve, reject })
    );
    console.error(`[agent] request ${method}`);
    await this.send(request(id, method, params));
    console.error(`[agent] wrote ${method}`);
    return await response;
  }

  async send(message: JsonRpcMessage) {
    if (this.#closed) throw new Error('Agent process is closed.');
    await this.#writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async close() {
    if (this.#closed) return;
    this.#intentionalClose = true;
    this.#closed = true;
    try {
      this.#child.kill('SIGTERM');
    } catch (cause) {
      if (!(isFsError(cause, 'ENOENT'))) throw cause;
    }
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 2000);
    try {
      await this.#writer.close().catch(() => undefined);
      await this.#child.status.catch(() => undefined);
    } finally {
      clearTimeout(timer);
      // A launcher may exit before its descendants. Reap only its private group.
      this.#child.kill('SIGKILL');
    }
  }

  async #readMessages() {
    try {
      for await (const line of readLines(this.#child.stdout)) {
        if (!line.trim()) continue;
        const message = parseJsonRpcMessage(line);
        if (message.id !== undefined && message.method === undefined) {
          const pending = this.#pending.get(idKey(message.id));
          if (pending) {
            this.#pending.delete(idKey(message.id));
            console.error(`[agent] response ${pending.method}${message.error ? ' error' : ''}`);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
            continue;
          }
        }
        this.#onMessage(message);
      }
    } catch (cause) {
      this.#failPending(cause);
    }
  }

  async #readStderr() {
    for await (const line of readLines(this.#child.stderr)) {
      if (line) {
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
        console.error(`[agent] ${line}`);
      }
    }
  }

  async #watchExit() {
    const status = await this.#child.status;
    const intentional = this.#intentionalClose;
    this.#closed = true;
    const exit: AgentProcessExit = {
      success: status.success,
      code: status.code,
      ...(status.signal ? { signal: status.signal } : {}),
      ...(this.#stderrTail.length ? { stderrTail: this.#stderrTail.join('\n') } : {}),
    };
    this.#failPending(
      new Error(`Agent exited with status ${status.code}${status.signal ? ` (${status.signal})` : ''}.`),
    );
    if (!intentional) this.#onExit(exit);
  }

  #failPending(cause: unknown) {
    for (const pending of this.#pending.values()) pending.reject(cause);
    this.#pending.clear();
  }
}
