import { PortalTerminalError } from '../terminals';
import type { TerminalExecution, TerminalExecutionEvent, TerminalExecutionRecord } from '../terminals.ts';
import { TerminalServiceClient } from './client.ts';
import type { ServiceHeader, ServiceRecord } from './contract.ts';

/** The Host's execution connection. Closing this object releases IPC, never PTYs. */
export class TerminalServiceConnection implements TerminalExecution {
  readonly client: TerminalServiceClient;
  #listeners = new Set<(event: TerminalExecutionEvent) => void>();
  constructor(options: { stateDirectory: string; executable?: string }) {
    this.client = new TerminalServiceClient(options.stateDirectory, options.executable);
    this.client.subscribe((header, payload) => {
      if (header.event === 'unavailable') {
        for (const listener of this.#listeners) listener({ terminalId: '', backendSequence: 0, type: 'unavailable' });
        return;
      }
      const common = { terminalId: header.terminalId as string, backendSequence: header.sequence as number };
      let event: TerminalExecutionEvent;
      switch (header.event) {
        case 'output': event = { ...common, type: 'output', data: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) }; break;
        case 'directory': event = { ...common, type: 'directory', currentDirectory: header.currentDirectory as string }; break;
        case 'title': event = { ...common, type: 'title', title: header.title as string, processName: header.processName as string }; break;
        case 'exit': event = { ...common, type: 'exit', exitCode: header.exitCode as number }; break;
        default: return;
      }
      for (const listener of this.#listeners) listener(event);
    });
  }
  async #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    try { return await operation(); }
    catch (error) { throw new PortalTerminalError('TERMINAL_SERVICE_UNAVAILABLE', error instanceof Error ? error.message : 'Terminal Service unavailable'); }
  }
  async list(): Promise<TerminalExecutionRecord[]> { return this.#call(() => this.client.list()); }
  async create(input: { terminalId: string; executionContextId: string; cwd: string; cols: number; rows: number; env: Record<string,string> }) {
    return (await this.#call(() => this.client.request({ method: 'create', ...input }))).terminal as ServiceRecord;
  }
  async capture(terminalId: string) {
    const result = await this.#call(() => this.client.request({ method: 'snapshot', terminalId }));
    const offsets = result.offsets as number[];
    const data = new Uint8Array(result.payload.buffer, result.payload.byteOffset, result.payload.byteLength);
    return { data: data.subarray(0, offsets[0]), history: offsets.slice(1).map((end, index) => data.subarray(offsets[index], end)), boundary: result.boundary as number };
  }
  async input(terminalId: string, data: Uint8Array) { await this.#call(() => this.client.request({ method: 'input', terminalId }, Buffer.from(data.buffer, data.byteOffset, data.byteLength))); }
  async resize(terminalId: string, cols: number, rows: number) { await this.#call(() => this.client.request({ method: 'resize', terminalId, cols, rows })); }
  async close(terminalId: string) { await this.#call(() => this.client.request({ method: 'close', terminalId })); }
  stopGracefully(terminalId: string) { return this.close(terminalId); }
  subscribe(listener: (event: TerminalExecutionEvent) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  dispose() { this.client.dispose(); }
}
