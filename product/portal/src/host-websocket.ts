import type { ServerWebSocket } from 'bun';

// Per-connection lifecycle shared by the authentication, RPC and ACP handlers.
export class HostWebSocket {
  private socket?: ServerWebSocket<HostWebSocket>;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void | Promise<void>;
  onclose?: () => void;
  get bufferedAmount() { return this.socket?.getBufferedAmount() ?? 0; }
  open(socket: ServerWebSocket<HostWebSocket>) { this.socket = socket; this.readyState = 1; this.onopen?.(); }
  receive(data: string | Buffer) { void this.onmessage?.({ data: typeof data === 'string' ? data : data.toString() }); }
  closed() { this.readyState = 3; this.onclose?.(); }
  send(data: string) { return this.socket?.send(data); }
  terminate() { this.socket?.terminate(); }
  close(code = 1000, reason = '') { this.readyState = 2; this.socket?.close(code, reason); }
}
export type HostUpgrade = (request: Request) => { socket: HostWebSocket; response: undefined };
