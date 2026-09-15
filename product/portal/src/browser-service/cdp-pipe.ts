import type { Readable, Writable } from 'node:stream';

export type CdpMessage = { id?: number; method?: string; params?: Record<string, any>; sessionId?: string; result?: any; error?: { code: number; message: string; data?: unknown } };
export const MAX_CDP_BYTES = 16 * 1024 * 1024;
type Pending = { resolve(value: CdpMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Chromium's standard null-delimited CDP pipe. The browser owns all protocol semantics. */
export class CdpPipe {
  #next = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(message: CdpMessage) => void>();
  #failure?: Error;
  constructor(private input: Writable, output: Readable) {
    let buffer = Buffer.alloc(0);
    output.on('data', (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        let end: number;
        while ((end = buffer.indexOf(0)) >= 0) {
          if (end > MAX_CDP_BYTES) throw new Error('CDP message exceeds capacity');
          const message: CdpMessage = JSON.parse(buffer.subarray(0, end).toString());
          buffer = buffer.subarray(end + 1);
          if (typeof message.id === 'number') {
            const pending = this.#pending.get(message.id);
            if (pending) { clearTimeout(pending.timer); this.#pending.delete(message.id); pending.resolve(message); }
          } else for (const listener of this.#listeners) listener(message);
        }
        if (buffer.length > MAX_CDP_BYTES) throw new Error('CDP message exceeds capacity');
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
    output.on('end', () => this.close(new Error('Browser CDP pipe closed')));
    output.on('error', error => this.close(error));
    input.on('error', error => this.close(error));
  }
  assertAvailable() { if (this.#failure) throw this.#failure; }
  subscribe(listener: (message: CdpMessage) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  send(method: string, params: object = {}, sessionId?: string, receive?: (message: CdpMessage) => void): Promise<CdpMessage> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pending.size >= 128 || this.input.writableLength > MAX_CDP_BYTES) return Promise.reject(new Error('CDP command capacity exceeded'));
    const id = ++this.#next;
    const message = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0';
    if (Buffer.byteLength(message) > MAX_CDP_BYTES) return Promise.reject(new Error('CDP request exceeds capacity'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP ${method} timed out; operation may have executed`)); }, 30_000);
      this.#pending.set(id, { resolve: message => { receive?.(message); resolve(message); }, reject, timer });
      this.input.write(message, error => { if (error) this.close(error); });
    });
  }
  async call<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const reply = await this.send(method, params, sessionId);
    if (reply.error) throw new Error(`CDP ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }
  close(error = new Error('CDP connection closed')) {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
}

/** Independent browser sessions on one owned pipe; no event stealing between agents. */
export class CdpPipeSession {
  readonly sessions = new Set<string>();
  #events: CdpMessage[] = [];
  #bytes = 0;
  #failure?: Error;
  #unsubscribe: () => void;
  private constructor(private pipe: CdpPipe, readonly root: string) {
    this.sessions.add(root);
    this.#unsubscribe = pipe.subscribe(message => {
      if (!message.sessionId || !this.sessions.has(message.sessionId) || this.#failure) return;
      if (message.method === 'Target.attachedToTarget') this.sessions.add(message.params!.sessionId);
      if (message.method === 'Target.detachedFromTarget') this.sessions.delete(message.params!.sessionId);
      const event = { ...message }; if (event.sessionId === root) delete event.sessionId;
      this.#enqueue(event);
    });
  }
  static async open(pipe: CdpPipe) { const { sessionId } = await pipe.call<{ sessionId: string }>('Target.attachToBrowserTarget'); return new CdpPipeSession(pipe, sessionId); }
  #enqueue(message: CdpMessage) {
    if (this.#failure) return;
    this.#bytes += Buffer.byteLength(JSON.stringify(message));
    if (this.#bytes > MAX_CDP_BYTES || this.#events.length >= 4096) { void this.close(new Error('CDP event consumer fell behind; reconnect required')); return; }
    this.#events.push(message);
  }
  /** Responses and events share one queue so discovery events precede their command reply. */
  dispatch(message: CdpMessage) {
    void this.send(message, reply => this.#enqueue(reply)).catch(error => this.#enqueue({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: String(error) } }));
  }
  async send(message: CdpMessage, receive?: (message: CdpMessage) => void): Promise<CdpMessage> {
    if (this.#failure) throw this.#failure;
    if (message.sessionId && !this.sessions.has(message.sessionId)) throw new Error('CDP session is unavailable');
    const format = (response: CdpMessage): CdpMessage => ({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...(response.error ? { error: response.error } : { result: response.result }) });
    const response = await this.pipe.send(message.method!, message.params ?? {}, message.sessionId ?? this.root, receive ? reply => receive(format(reply)) : undefined);
    return format(response);
  }
  events() { this.pipe.assertAvailable(); if (this.#failure) throw this.#failure; const events = this.#events; this.#events = []; this.#bytes = 0; return events; }
  async close(error = new Error('CDP session closed')) {
    if (this.#failure) return;
    this.#failure = error; this.#unsubscribe(); this.#events = []; this.#bytes = 0;
    await this.pipe.call('Target.detachFromTarget', { sessionId: this.root }).catch(() => {});
  }
}
