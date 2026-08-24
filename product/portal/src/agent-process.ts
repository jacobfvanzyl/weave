import type { AgentDefinition } from './config.ts';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage, request } from './json-rpc.ts';
import { readLines } from './line-stream.ts';

type Pending = { resolve(value: unknown): void; reject(cause: unknown): void };

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
    const value = Deno.env.get(name);
    return value === undefined ? [] : [[name, value]];
  }));
};

export class AgentProcess {
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<string, Pending>();
  readonly #encoder = new TextEncoder();
  readonly #onMessage: (message: JsonRpcMessage) => void;
  #nextId = 0;
  #closed = false;

  constructor(agent: AgentDefinition, cwd: string, onMessage: (message: JsonRpcMessage) => void) {
    this.#onMessage = onMessage;
    this.#child = new Deno.Command(agent.command, {
      args: agent.args,
      cwd,
      env: { ...inheritedEnvironment(), ...agent.env },
      clearEnv: true,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    void this.#readMessages();
    void this.#readStderr();
    void this.#watchExit();
  }

  async request(method: string, params?: unknown) {
    const id = `portal:${++this.#nextId}`;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(idKey(id), { resolve, reject }));
    await this.send(request(id, method, params));
    return await response;
  }

  async send(message: JsonRpcMessage) {
    if (this.#closed) throw new Error('Agent process is closed.');
    await this.#writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.kill('SIGTERM');
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
    await this.#writer.close().catch(() => undefined);
    await this.#child.status.catch(() => undefined);
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
      if (line) console.error(`[agent] ${line}`);
    }
  }

  async #watchExit() {
    const status = await this.#child.status;
    this.#closed = true;
    this.#failPending(
      new Error(`Agent exited with status ${status.code}${status.signal ? ` (${status.signal})` : ''}.`),
    );
  }

  #failPending(cause: unknown) {
    for (const pending of this.#pending.values()) pending.reject(cause);
    this.#pending.clear();
  }
}
