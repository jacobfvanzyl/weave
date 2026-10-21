import {
  type AcpTranscript,
  type AcpTranscriptEvent,
  createTranscript,
  reduceAcpEvent,
} from '@/chat/acp-transcript';
import type { AgentChoice, AppActions, AppModel, HostStatus, PairedHost, SessionSummary } from '@/app/app-controller';
import { sessionKey } from '@/app/app-controller';
import { SessionReadState } from '@/app/session-read-state';
import { ConnectError, type Connector, HostConnection, type HostEvent, type OpenedSession } from './connection';
import type { DeviceKey } from './device-key';
import { JournalFollower, transcriptEvents } from './journal';
import { HOST_PROTOCOL, type AgentSummary, type ClientInfo, type SessionListing } from './protocol';
import { type HostStorage, type PairedHostRecord, websocketUrl } from './storage';

export type HostStoreOptions = {
  storage: HostStorage;
  /** The device key a paired Host knows this device by. */
  keyFor(keyId: string): DeviceKey;
  /** A new device key, for pairing with another Host. */
  newKey(): Promise<{ keyId: string; key: DeviceKey }>;
  connectorFor(url: string): Connector;
  client: ClientInfo;
  /** What a new pairing calls this device when the person names it nothing else. */
  deviceName: string;
  /** Delays between reconnecting tries, in milliseconds; the last repeats. */
  backoff?: number[];
};

type HostEntry = {
  record: PairedHostRecord;
  status: HostStatus;
  error?: string;
  connection?: HostConnection;
  sessions: SessionListing[];
  agents: AgentSummary[];
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
  /** No more tries: the device was revoked, or the Host refuses it. */
  stopped: boolean;
};

/** A session this client follows: where its journal is up to and what it shows. */
type Followed = {
  hostId: string;
  sessionId: string;
  follower: JournalFollower;
  transcript: AcpTranscript;
  /** The tag of the attach whose answer it waits for. */
  tag?: number;
};

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The app's Hosts and the session on screen, kept up to date from their connections, for the
 * app's controller (`use-host-controller.ts`). Until WVE-102 it shows sessions read-only.
 */
export class HostStore {
  readonly #options: HostStoreOptions;
  readonly #hosts = new Map<string, HostEntry>();
  readonly #followed = new Map<string, Followed>();
  readonly #read = new SessionReadState();
  readonly #listeners = new Set<() => void>();
  #selectedKey?: string;
  #error?: string;
  #nextTag = 1;
  #snapshot?: AppModel;
  #stopped = false;

  constructor(options: HostStoreOptions) {
    this.#options = options;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /** The model as it is now; a new object only when something changed. */
  snapshot = (): AppModel => {
    this.#snapshot ??= this.#model();
    return this.#snapshot;
  };

  /** Loads the paired Hosts and connects to each. */
  async start() {
    for (const record of await this.#options.storage.load()) {
      this.#hosts.set(record.hostId, this.#entry(record));
    }
    this.#changed();
    await Promise.all([...this.#hosts.values()].map((entry) => this.#connect(entry)));
  }

  /** Closes every connection. */
  stop() {
    this.#stopped = true;
    for (const entry of this.#hosts.values()) {
      clearTimeout(entry.retry);
      entry.connection?.close();
    }
  }

  /** Lists every connected Host's sessions again, and reconnects to the ones that dropped. */
  async refresh() {
    await Promise.all([...this.#hosts.values()].map(async (entry) => {
      if (entry.connection && !entry.connection.closed) await this.#list(entry);
      else if (!entry.stopped && entry.status !== 'connecting') await this.#connect(entry);
    }));
  }

  readonly actions: AppActions = {
    selectSession: (key) => this.#select(key),
    refresh: () => this.refresh(),
    pairHost: (input) => this.#pair(input),
    forgetHost: (hostId) => this.#forget(hostId),
    reconnectHost: async (hostId) => {
      const entry = this.#hosts.get(hostId);
      if (!entry) return;
      entry.stopped = false;
      entry.attempt = 0;
      await this.#connect(entry);
    },
    // Prompting, steering, answering and managing sessions come with WVE-102 and WVE-103; the
    // model is read-only until then, so the UI offers none of them.
    createSession: () => this.#readOnly(),
    closeSession: () => this.#readOnly(),
    deleteSession: () => this.#readOnly(),
    send: () => this.#readOnly(),
    removeQueued: () => {},
    cancelTurn: () => this.#readOnly(),
    respondToPermission: () => {},
    respondToElicitation: () => {},
    setMode: () => this.#readOnly(),
    setConfigOption: () => this.#readOnly(),
  };

  #readOnly(): never {
    throw new Error('This app shows sessions read-only for now.');
  }

  #entry(record: PairedHostRecord): HostEntry {
    return { record, status: 'connecting', sessions: [], agents: [], attempt: 0, stopped: false };
  }

  #changed() {
    this.#snapshot = undefined;
    for (const listener of this.#listeners) listener();
  }

  async #connect(entry: HostEntry) {
    if (this.#stopped) return;
    clearTimeout(entry.retry);
    entry.status = entry.attempt === 0 ? 'connecting' : 'reconnecting';
    this.#changed();
    const { record } = entry;
    try {
      const connection = await HostConnection.connect({
        connector: this.#options.connectorFor(record.url),
        client: this.#options.client,
        credentials: { method: 'device', deviceId: record.deviceId, key: this.#options.keyFor(record.keyId), hostId: record.hostId },
        onEvent: (event) => this.#event(entry, connection, event),
      });
      if (this.#hosts.get(record.hostId) !== entry || this.#stopped) {
        connection.close();
        return;
      }
      await this.#connected(entry, connection);
    } catch (error) {
      if (this.#hosts.get(record.hostId) !== entry) return;
      this.#connectFailed(entry, error);
    }
  }

  async #connected(entry: HostEntry, connection: HostConnection) {
    entry.connection = connection;
    entry.status = 'connected';
    entry.error = undefined;
    entry.attempt = 0;
    this.#changed();
    try {
      entry.agents = (await connection.request('agents/list', {})).agents;
    } catch {
      entry.agents = [];
    }
    await this.#list(entry);
    // Catch up on the session on screen, after the last event this client handled.
    const selected = this.#selectedKey ? this.#followed.get(this.#selectedKey) : undefined;
    if (selected && selected.hostId === entry.record.hostId) this.#attach(selected);
  }

  #connectFailed(entry: HostEntry, error: unknown) {
    entry.connection = undefined;
    const kind = error instanceof ConnectError ? error.kind : 'connection';
    if (kind === 'refused' || kind === 'incompatible' || kind === 'wrongHost') {
      entry.status = 'disconnected';
      entry.stopped = true;
      entry.error = kind === 'refused'
        ? `The Host refused this device (${describe(error)}). Pair it again.`
        : describe(error);
      this.#changed();
      return;
    }
    entry.error = describe(error);
    this.#retry(entry);
  }

  #retry(entry: HostEntry) {
    const backoff = this.#options.backoff ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    const delay = backoff[Math.min(entry.attempt, backoff.length - 1)];
    entry.attempt += 1;
    entry.status = 'reconnecting';
    entry.retry = setTimeout(() => void this.#connect(entry), delay);
    this.#changed();
  }

  async #list(entry: HostEntry) {
    const connection = entry.connection;
    if (!connection) return;
    try {
      entry.sessions = (await connection.request('sessions/list', {})).sessions;
      for (const listing of entry.sessions) {
        this.#read.observe(sessionKey(entry.record.hostId, listing.info.sessionId), listing.activity ?? undefined);
      }
      this.#changed();
    } catch (error) {
      this.#error = describe(error);
      this.#changed();
    }
  }

  #event(entry: HostEntry, connection: HostConnection, event: HostEvent) {
    if (entry.connection !== connection && event.type !== 'disconnected') return;
    switch (event.type) {
      case 'opened':
      case 'openFailed':
        this.#openAnswered(entry, event);
        return;
      case 'disconnected':
        if (entry.connection !== connection) return;
        entry.connection = undefined;
        if (event.code === HOST_PROTOCOL.websocket.closeRevoked) {
          entry.status = 'disconnected';
          entry.stopped = true;
          entry.error = 'This device was revoked on the Host. Pair it again.';
          this.#changed();
          return;
        }
        // Fell behind (4001), a dropped network or a Host restart: catch up after the position.
        entry.attempt = event.code === HOST_PROTOCOL.websocket.closeBehind ? 0 : entry.attempt;
        this.#retry(entry);
        return;
      case 'notification':
        if (event.method === 'session/event') {
          const followed = this.#followed.get(sessionKey(entry.record.hostId, event.params.sessionId));
          if (!followed || !followed.follower.accept(event.params)) return;
          this.#apply(followed, transcriptEvents(event.params));
        } else if (event.method === 'session/changed') {
          const { sessionId, activity, clients, title } = event.params;
          const listing = entry.sessions.find(({ info }) => info.sessionId === sessionId);
          if (!listing) return;
          if (activity) listing.activity = activity;
          if (clients !== undefined && clients !== null) listing.clients = clients;
          if (title) listing.info = { ...listing.info, title };
          listing.lastActivityAt = Date.now();
          this.#read.observe(sessionKey(entry.record.hostId, sessionId), listing.activity ?? undefined);
          this.#changed();
        }
        return;
    }
  }

  #select(key?: string) {
    const previous = this.#selectedKey ? this.#followed.get(this.#selectedKey) : undefined;
    if (previous && previous !== (key ? this.#followed.get(key) : undefined)) {
      const connection = this.#hosts.get(previous.hostId)?.connection;
      void connection?.request('session/detach', { sessionId: previous.sessionId }).catch(() => {});
    }
    this.#selectedKey = key;
    this.#read.focus(key);
    this.#error = undefined;
    if (key) {
      const [hostId, ...rest] = key.split('/');
      const sessionId = rest.join('/');
      let followed = this.#followed.get(key);
      if (!followed) {
        followed = { hostId, sessionId, follower: new JournalFollower(), transcript: createTranscript(sessionId) };
        this.#followed.set(key, followed);
      }
      this.#attach(followed);
    }
    this.#changed();
  }

  #attach(followed: Followed) {
    const entry = this.#hosts.get(followed.hostId);
    const connection = entry?.connection;
    if (!entry || !connection) return;
    const listing = entry.sessions.find(({ info }) => info.sessionId === followed.sessionId);
    followed.tag = this.#nextTag++;
    connection.open({
      attach: {
        sessionId: followed.sessionId,
        ...(followed.follower.position ? { after: followed.follower.position } : {}),
        // A session the Host has no record of is named by its agent and directory.
        ...(listing ? { agentId: listing.agentId, cwd: listing.info.cwd } : {}),
      },
    }, followed.tag);
  }

  #openAnswered(entry: HostEntry, event: Extract<HostEvent, { type: 'opened' | 'openFailed' }>) {
    const followed = [...this.#followed.values()].find(({ hostId, tag }) => hostId === entry.record.hostId && tag === event.tag);
    if (!followed) return;
    followed.tag = undefined;
    if (event.type === 'openFailed') {
      this.#error = `Couldn't open the session: ${event.error.message}`;
      this.#changed();
      return;
    }
    this.#opened(followed, event.session);
  }

  #opened(followed: Followed, session: OpenedSession) {
    const { reset } = followed.follower.opened(session);
    const { state } = session;
    const base = reset ? createTranscript(state.sessionId) : followed.transcript;
    const events: AcpTranscriptEvent[] = [{ type: 'session/loaded', modes: state.modes, configOptions: state.configOptions }];
    followed.transcript = { ...events.reduce(reduceAcpEvent, base), title: state.title ?? base.title };
    this.#changed();
  }

  #apply(followed: Followed, events: AcpTranscriptEvent[]) {
    if (events.length === 0) return;
    followed.transcript = events.reduce(reduceAcpEvent, followed.transcript);
    this.#changed();
  }

  async #pair(input: { url: string; code: string; name?: string }) {
    const url = websocketUrl(input.url);
    const name = new URL(input.url.trim()).hostname;
    const { keyId, key } = await this.#options.newKey();
    let connection: HostConnection;
    let entry: HostEntry | undefined;
    try {
      connection = await HostConnection.connect({
        connector: this.#options.connectorFor(url),
        client: this.#options.client,
        credentials: { method: 'pair', code: input.code.replaceAll(/[\s-]/g, ''), name: input.name?.trim() || this.#options.deviceName, key },
        onEvent: (event) => { if (entry) this.#event(entry, connection, event); },
      });
    } catch (error) {
      await key.forget().catch(() => {});
      throw error instanceof ConnectError ? new Error(error.message) : error;
    }
    const { host, device } = connection.hello;
    if (!host.id || !device) {
      connection.close();
      await key.forget().catch(() => {});
      throw new Error('The Host paired no device. Is it a weave Host?');
    }
    const previous = this.#hosts.get(host.id);
    if (previous) await this.#forget(host.id);
    entry = this.#entry({ hostId: host.id, name, url, deviceId: device.id, keyId });
    this.#hosts.set(host.id, entry);
    await this.#save();
    await this.#connected(entry, connection);
  }

  async #forget(hostId: string) {
    const entry = this.#hosts.get(hostId);
    if (!entry) return;
    clearTimeout(entry.retry);
    entry.connection?.close();
    this.#hosts.delete(hostId);
    for (const [key, followed] of this.#followed) {
      if (followed.hostId === hostId) this.#followed.delete(key);
    }
    if (this.#selectedKey?.startsWith(`${hostId}/`)) this.#selectedKey = undefined;
    await this.#options.keyFor(entry.record.keyId).forget().catch(() => {});
    await this.#save();
    this.#changed();
  }

  #save() {
    return this.#options.storage.save([...this.#hosts.values()].map(({ record }) => record));
  }

  #model(): AppModel {
    const hosts: PairedHost[] = [];
    const sessions: SessionSummary[] = [];
    const agents: Record<string, AgentChoice[]> = {};
    for (const entry of this.#hosts.values()) {
      const { record } = entry;
      hosts.push({ id: record.hostId, name: record.name, url: record.url, status: entry.status, ...(entry.error ? { error: entry.error } : {}) });
      agents[record.hostId] = entry.agents.map(({ id, name }) => ({ id, name }));
      for (const listing of entry.sessions) {
        const agentName = entry.agents.find(({ id }) => id === listing.agentId)?.name ?? listing.agentId;
        sessions.push({
          key: sessionKey(record.hostId, listing.info.sessionId),
          hostId: record.hostId,
          sessionId: listing.info.sessionId,
          ...(listing.info.title ? { title: listing.info.title } : {}),
          agentId: listing.agentId,
          agentName,
          cwd: listing.info.cwd,
          state: listing.state,
          ...(listing.activity ? { activity: listing.activity } : {}),
          clients: listing.clients ?? 0,
          headless: listing.headless ?? false,
          lastActivityAt: listing.lastActivityAt ?? (listing.info.updatedAt ? Date.parse(listing.info.updatedAt) : undefined),
        });
      }
    }
    const followed = this.#selectedKey ? this.#followed.get(this.#selectedKey) : undefined;
    return {
      hosts,
      sessions,
      agents,
      selectedKey: this.#selectedKey,
      session: followed && this.#selectedKey
        ? { key: this.#selectedKey, transcript: followed.transcript, canSteer: false, queued: [] }
        : undefined,
      unread: this.#read.unread(),
      readOnly: true,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
}
