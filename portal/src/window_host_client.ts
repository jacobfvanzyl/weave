import { type ResolvedWindowStreamConfig, resolveWindowStreamConfig } from './window_config.ts';
import type { WindowHostEvent } from './window_protocol.ts';
import { isRecord, optionalString, toErrorMessage } from './window_protocol.ts';
import { resolveWindowHostRuntime, type WindowHostRuntime, windowHostRuntimeError } from './window_host_runtime.ts';

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultHelperRequestTimeoutMs = 15_000;

export class ProcessWindowHostClient {
  private readonly env: Record<string, string | undefined>;
  private readonly windowStream: ResolvedWindowStreamConfig;
  private readonly requestTimeoutMs: number;
  private process?: Deno.ChildProcess;
  private stdin?: WritableStreamDefaultWriter<Uint8Array>;
  private runtime?: WindowHostRuntime;
  private nextRequestId = 0;
  private buffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionListeners = new Map<string, Set<(event: WindowHostEvent) => void>>();

  constructor(options: {
    env?: Record<string, string | undefined>;
    windowStream?: ResolvedWindowStreamConfig;
    requestTimeoutMs?: number;
  } = {}) {
    this.env = options.env ?? Deno.env.toObject();
    this.windowStream = options.windowStream ?? resolveWindowStreamConfig(undefined, {}, this.env);
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultHelperRequestTimeoutMs;
  }

  async request(payload: Record<string, unknown>) {
    await this.ensureStarted();
    if (!this.stdin) throw new Error(`${this.runtime?.label ?? 'Window host'} is not writable.`);
    const id = `window_req_${++this.nextRequestId}`;
    const message = { id, ...payload };
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.runtime?.label ?? 'Window host'} timed out: ${String(payload.type)}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    await this.stdin.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
    return result;
  }

  onSessionEvent(sessionId: string, listener: (event: WindowHostEvent) => void) {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.runtime?.label ?? 'Window host'} stopped.`));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.stdin?.close().catch(() => undefined);
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.stdin = undefined;
  }

  private async ensureStarted() {
    if (this.process && this.stdin) return;
    this.runtime = await resolveWindowHostRuntime(this.env, this.windowStream);
    if (!this.runtime) throw new Error(windowHostRuntimeError(this.windowStream));

    const command = new Deno.Command(this.runtime.command, {
      args: this.runtime.args,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: this.runtime.env,
    });
    this.process = command.spawn();
    this.stdin = this.process.stdin.getWriter();
    void this.readStdout(this.process.stdout);
    void this.readStderr(this.process.stderr);
    void this.process.status.then((status) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} exited with code ${status.code}.`));
      this.process = undefined;
      this.stdin = undefined;
    }).catch((error) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} failed: ${toErrorMessage(error)}`));
      this.process = undefined;
      this.stdin = undefined;
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stdout) {
        this.buffer += textDecoder.decode(chunk, { stream: true });
        let newlineIndex = this.buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (line) this.handleLine(line);
          newlineIndex = this.buffer.indexOf('\n');
        }
      }
    } catch (error) {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} stdout failed: ${toErrorMessage(error)}`));
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stderr) {
        const text = textDecoder.decode(chunk).trim();
        if (text) console.error(`[window-host] ${text}`);
      }
    } catch {
      // Stderr is diagnostic only.
    }
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[window-host] invalid json: ${line}`);
      return;
    }

    if (typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok === false) {
        pending.reject(
          new Error(
            message.error === undefined
              ? `${this.runtime?.label ?? 'Window host'} request failed.`
              : toErrorMessage(message.error),
          ),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'session.event') {
      const event = isRecord(message.event) ? message.event as WindowHostEvent : undefined;
      const sessionId = optionalString(message.sessionId) ?? optionalString(event?.sessionId);
      if (!event || !sessionId) return;
      for (const listener of this.sessionListeners.get(sessionId) ?? []) listener(event);
    }
  }
}
