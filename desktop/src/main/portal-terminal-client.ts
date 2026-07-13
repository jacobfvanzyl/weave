import { randomBytes } from 'node:crypto';
import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalWindowRecord,
} from '../shared/terminal';
import type { PortalSupervisor } from './portal-supervisor';

export type TerminalWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, event: TerminalHostEvent) => void;
};

type LocalTerminalConnection = {
  clientId: string;
  socket: WebSocket;
  terminalId: string;
  subscribers: Map<number, TerminalWebContents>;
  pendingStart?: {
    resolve: (value: TerminalStartResult) => void;
    reject: (error: Error) => void;
  };
  pendingRequests: Map<
    string,
    {
      resolve: (value: TerminalWindowRecord[] | TerminalWindowRecord) => void;
      reject: (error: Error) => void;
    }
  >;
};

const terminalEventChannel = 'terminal:event';

export class PortalTerminalClient {
  private readonly supervisor: PortalSupervisor;
  private readonly connections = new Map<string, LocalTerminalConnection>();
  private readonly connectionsInFlight = new Map<string, Promise<LocalTerminalConnection>>();
  private requestCounter = 0;
  private disposed = false;

  constructor(supervisor: PortalSupervisor) {
    this.supervisor = supervisor;
  }

  async snapshot(): Promise<TerminalWindowRecord[]> {
    const connection = await this.getConnection('snapshot');
    const requestId = this.nextRequestId();
    return new Promise<TerminalWindowRecord[]>((resolve, reject) => {
      connection.pendingRequests.set(requestId, {
        resolve: value => resolve(value as TerminalWindowRecord[]),
        reject,
      });
      this.send(connection, { type: 'snapshot', requestId });
    });
  }

  async list(input: TerminalTargetInput): Promise<TerminalWindowRecord[]> {
    const connection = await this.getConnection(this.getTargetConnectionId(input));
    const requestId = this.nextRequestId();
    return new Promise<TerminalWindowRecord[]>((resolve, reject) => {
      connection.pendingRequests.set(requestId, {
        resolve: value => resolve(value as TerminalWindowRecord[]),
        reject,
      });
      this.send(connection, { type: 'list', requestId, ...input });
    });
  }

  async create(input: TerminalTargetInput): Promise<TerminalWindowRecord> {
    const connection = await this.getConnection(this.getTargetConnectionId(input));
    const requestId = this.nextRequestId();
    return new Promise<TerminalWindowRecord>((resolve, reject) => {
      connection.pendingRequests.set(requestId, {
        resolve: value => resolve(value as TerminalWindowRecord),
        reject,
      });
      this.send(connection, { type: 'create', requestId, ...input });
    });
  }

  async start(input: TerminalStartInput, webContents: TerminalWebContents): Promise<TerminalStartResult> {
    const connection = await this.getConnection(input.terminalId);
    connection.subscribers.set(webContents.id, webContents);
    return new Promise<TerminalStartResult>((resolve, reject) => {
      connection.pendingStart = { resolve, reject };
      this.send(connection, { type: 'start', ...input });
    });
  }

  async input(terminalId: string, data: string) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'input', terminalId, data });
  }

  async resize(terminalId: string, cols: number, rows: number) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'resize', terminalId, cols, rows });
  }

  async close(terminalId: string, input?: TerminalTargetInput) {
    const connection = input
      ? await this.getConnection(this.getTargetConnectionId(input))
      : this.connections.get(terminalId);
    if (!connection) return;
    this.send(connection, { type: 'close', terminalId });
    const terminalConnection = this.connections.get(terminalId);
    if (terminalConnection && terminalConnection !== connection) terminalConnection.socket.close();
    if (terminalConnection) this.connections.delete(terminalId);
  }

  async detach(terminalId: string, webContents: TerminalWebContents) {
    const connection = this.connections.get(terminalId);
    if (!connection) return;
    connection.subscribers.delete(webContents.id);
    if (connection.subscribers.size > 0) return;
    this.send(connection, { type: 'detach', terminalId });
    connection.socket.close();
    this.connections.delete(terminalId);
  }

  detachWebContents(webContentsId: number) {
    for (const [terminalId, connection] of this.connections) {
      connection.subscribers.delete(webContentsId);
      if (connection.subscribers.size === 0) {
        this.send(connection, { type: 'detach', terminalId });
        connection.socket.close();
        this.connections.delete(terminalId);
      }
    }
  }

  dispose() {
    this.disposed = true;
    for (const connection of this.connections.values()) {
      connection.socket.close();
    }
    this.connections.clear();
  }

  getPerfSnapshot() {
    const connections = [...this.connections.values()];
    return {
      connectionCount: connections.length,
      subscriberCount: connections.reduce((count, connection) => count + connection.subscribers.size, 0),
      pendingRequestCount: connections.reduce((count, connection) => count + connection.pendingRequests.size, 0),
      pendingStartCount: connections.filter(connection => Boolean(connection.pendingStart)).length,
      connections: connections.map(connection => ({
        terminalId: connection.terminalId,
        readyState: connection.socket.readyState,
        bufferedAmount: connection.socket.bufferedAmount,
        subscriberCount: connection.subscribers.size,
        pendingRequestCount: connection.pendingRequests.size,
        pendingStart: Boolean(connection.pendingStart),
      })),
    };
  }

  private async getConnection(terminalId: string) {
    if (this.disposed) throw new Error('Portal terminal client was disposed during runtime reconciliation.');
    const existing = this.connections.get(terminalId);
    if (existing && existing.socket.readyState === WebSocket.OPEN) return existing;

    const inFlight = this.connectionsInFlight.get(terminalId);
    if (inFlight) return await inFlight;

    const creating = this.createConnection(terminalId);
    this.connectionsInFlight.set(terminalId, creating);
    try {
      return await creating;
    } finally {
      if (this.connectionsInFlight.get(terminalId) === creating) this.connectionsInFlight.delete(terminalId);
    }
  }

  private async createConnection(terminalId: string) {
    const control = await this.supervisor.ensureStarted();
    const socket = new WebSocket(control.url);
    const connection: LocalTerminalConnection = {
      clientId: `desktop:${randomBytes(12).toString('hex')}`,
      terminalId,
      socket,
      subscribers: new Map(),
      pendingRequests: new Map(),
    };

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Portal local terminal WebSocket failed.'));
      socket.onclose = () => {
        connection.pendingStart?.reject(new Error('Portal local terminal WebSocket closed.'));
        connection.pendingStart = undefined;
        for (const pending of connection.pendingRequests.values()) {
          pending.reject(new Error('Portal local terminal WebSocket closed.'));
        }
        connection.pendingRequests.clear();
        this.connections.delete(terminalId);
      };
      socket.onmessage = event => {
        const envelope = JSON.parse(String(event.data)) as { type?: string; event?: TerminalHostEvent };
        if (envelope.type !== 'terminal.event' || !envelope.event) return;
        this.handleEvent(connection, envelope.event);
      };
    });

    if (this.disposed) {
      socket.close();
      throw new Error('Portal terminal client was disposed during runtime reconciliation.');
    }

    this.connections.set(terminalId, connection);
    return connection;
  }

  private send(connection: LocalTerminalConnection, message: { type: string; [key: string]: unknown }) {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Portal local terminal WebSocket is not open.');
    }
    connection.socket.send(JSON.stringify({ type: 'terminal.client', clientId: connection.clientId, message }));
  }

  private handleEvent(connection: LocalTerminalConnection, event: TerminalHostEvent) {
    if (event.type === 'windows' && event.requestId) {
      connection.pendingRequests.get(event.requestId)?.resolve(event.windows);
      connection.pendingRequests.delete(event.requestId);
      return;
    }

    if (event.type === 'created' && event.requestId) {
      connection.pendingRequests.get(event.requestId)?.resolve(event.window);
      connection.pendingRequests.delete(event.requestId);
      return;
    }

    if (event.type === 'error' && event.requestId) {
      connection.pendingRequests.get(event.requestId)?.reject(new Error(event.error));
      connection.pendingRequests.delete(event.requestId);
      return;
    }

    if (event.type === 'started') {
      connection.pendingStart?.resolve({ sessionId: event.sessionId, cwd: event.cwd });
      connection.pendingStart = undefined;
    } else if (event.type === 'error' && connection.pendingStart && event.terminalId === connection.terminalId) {
      connection.pendingStart.reject(new Error(event.error));
      connection.pendingStart = undefined;
    }

    for (const [id, webContents] of connection.subscribers) {
      if (webContents.isDestroyed()) {
        connection.subscribers.delete(id);
        continue;
      }
      webContents.send(terminalEventChannel, event);
    }
  }

  private getTargetConnectionId(input: TerminalTargetInput) {
    return [
      input.kind,
      input.portalId ?? '',
      input.rootId ?? '',
      input.projectId ?? '',
      input.workspaceId ?? '',
      input.workspacePath ?? '',
      input.cwd ?? '',
    ].join(':');
  }

  private nextRequestId() {
    this.requestCounter += 1;
    return `desktop-terminal-${this.requestCounter.toString(36)}`;
  }
}
