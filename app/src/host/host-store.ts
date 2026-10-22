import {
  type AcpTranscript,
  type AcpTranscriptEvent,
  createTranscript,
  queueOptimisticPrompt,
  reduceAcpEvent,
} from '@/chat/acp-transcript';
import type {
  AgentChoice,
  AgentUpdateNotice,
  AppActions,
  DirectoryListing,
  AppModel,
  HostStatus,
  PairedHost,
  PromptImage,
  QueuedPrompt,
  SessionSummary,
} from '@/app/app-controller';
import { sessionKey } from '@/app/app-controller';
import { SessionReadState } from '@/app/session-read-state';
import { type ClientTool, toolError } from './client-tools';
import { CONNECTION_CLOSED, ConnectError, type Connector, HostConnection, HostError, type HostEvent, type OpenedSession } from './connection';
import type { DeviceKey } from './device-key';
import { JournalFollower, originLabel, transcriptEvents } from './journal';
import {
  HOST_PROTOCOL,
  type AgentSummary,
  type AnswerPendingRequest,
  type ClientCapabilities,
  type ClientInfo,
  type ContentBlock,
  type PendingRequest,
  type PendingResolvedNotification,
  type SessionEventNotification,
  type SessionListing,
  type SessionState,
  type TurnOrigin,
} from './protocol';
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
  /** The client tools this device runs for agents, by name (`capabilities.clientTools`). */
  clientTools?: Record<string, ClientTool>;
  /**
   * When to tell subscribers the model changed. Changes made meanwhile are told once, so a
   * replay of thousands of events renders a frame at a time. Defaults to the next frame.
   */
  schedule?(notify: () => void): void;
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

/** A session this client follows: where its journal is up to, what it shows, and what waits to be sent. */
type Followed = {
  hostId: string;
  sessionId: string;
  follower: JournalFollower;
  transcript: AcpTranscript;
  /** The tag of the attach whose answer it waits for. */
  tag?: number;
  /** The session as attaching gave it, kept up to date: its agent, whether it's blank, its activity. */
  state?: SessionState;
  /** Messages for after the running turn, sent in order as turns end. */
  queued: QueuedPrompt[];
  /** Steers on their way, until the agent takes them or the Host says no turn runs. */
  steering: QueuedPrompt[];
  /** A newer version is out (`agents/updateAvailable`, or `SessionState.update`). */
  update?: Omit<AgentUpdateNotice, 'available'>;
  reopening: boolean;
  /** What waits in it now, as the Host says (`SessionState.pending`, then `pending/added` and `pending/resolved`). */
  pending: PendingRequest[];
  /**
   * Whether the transcript shows what's pending. Not while an attach replays history: a request
   * shows after what came before it.
   */
  pendingShown: boolean;
  /** Clients that prompted it, by client id, for naming who runs a client tool. */
  clients: Map<string, string>;
};

type PendingKind<K extends PendingRequest['kind']> = Extract<PendingRequest, { kind: K }>;

/** A `session/create` waiting for its answer. */
type Creating = { hostId: string; agentId: string; resolve(): void; reject(error: Error): void };

/** ACP's error for an agent that needs signing in, passed through by the Host. */
const AUTH_REQUIRED = -32000;

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

const failedWith = (error: unknown, code: number) => error instanceof HostError && error.code === code;

const nextFrame = (notify: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => notify());
  else setTimeout(notify, 16);
};

/** A message as a prompt's content: the text, then any photos. */
export const promptBlocks = (text: string, images: PromptImage[] = []): ContentBlock[] => [
  ...(text ? [{ type: 'text' as const, text }] : []),
  ...images.map(({ mimeType, data }) => ({ type: 'image' as const, mimeType, data })),
];

const meta = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined, value);

/**
 * The app's Hosts and the session on screen, kept up to date from their connections, for the
 * app's controller (`use-host-controller.ts`).
 */
export class HostStore {
  readonly #options: HostStoreOptions;
  readonly #hosts = new Map<string, HostEntry>();
  readonly #followed = new Map<string, Followed>();
  readonly #creating = new Map<number, Creating>();
  /** Client tool calls running on this device, by pending id. */
  readonly #running = new Set<string>();
  readonly #read = new SessionReadState();
  readonly #listeners = new Set<() => void>();
  #selectedKey?: string;
  #error?: string;
  #nextTag = 1;
  #nextLocal = 1;
  #snapshot?: AppModel;
  #notifying = false;
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

  /**
   * Lists every connected Host's sessions again, and reconnects to the ones that dropped. A Host
   * that keeps the list live (`sessions/watch`) is asked to start over, so nothing older than
   * what it last said comes after it.
   */
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
    createSession: (input) => this.#create(input),
    listDirectory: (input) => this.#listDirectory(input),
    closeSession: (key) => this.#report(() => this.#close(key)),
    renameSession: (key, title) => this.#rename(key, title),
    deleteSession: (key) => this.#report(() => this.#delete(key)),
    send: (text, images) => this.#send(text, images),
    removeQueued: (id) => {
      const followed = this.#selected();
      if (!followed) return;
      followed.queued = followed.queued.filter((prompt) => prompt.id !== id);
      this.#changed();
    },
    cancelTurn: () => this.#report(async () => {
      const followed = this.#selected();
      if (!followed) return;
      await this.#connection(followed).request('turn/cancel', { sessionId: followed.sessionId });
    }),
    reopenSession: () => this.#report(() => this.#reopen()),
    respondToPermission: (requestId, optionId) => this.#answer(
      requestId,
      { permission: { outcome: { outcome: 'selected', optionId } } },
      { type: 'permission/resolved', requestId, optionId },
    ),
    respondToElicitation: (requestId, response) => this.#answer(
      requestId,
      { elicitation: response },
      { type: 'elicitation/resolved', requestId, response },
    ),
    setMode: (modeId) => this.#report(async () => {
      const followed = this.#selected();
      if (!followed) return;
      await this.#connection(followed).request('session/setMode', { sessionId: followed.sessionId, modeId });
    }),
    setConfigOption: (configId, value) => this.#report(async () => {
      const followed = this.#selected();
      if (!followed) return;
      // The change reaches every client, this one too, through the journal.
      await this.#connection(followed).request('session/setConfigOption', typeof value === 'boolean'
        ? { sessionId: followed.sessionId, configId, type: 'boolean', value }
        : { sessionId: followed.sessionId, configId, value });
    }),
  };

  /** Runs an action whose failure the person reads in the model's error, not from a caller. */
  async #report(action: () => Promise<void>) {
    this.#error = undefined;
    try {
      await action();
    } catch (error) {
      this.#error = describe(error);
      this.#changed();
    }
  }

  #capabilities(): ClientCapabilities {
    return { clientTools: Object.keys(this.#options.clientTools ?? {}) };
  }

  #entry(record: PairedHostRecord): HostEntry {
    return { record, status: 'connecting', sessions: [], agents: [], attempt: 0, stopped: false };
  }

  #changed() {
    this.#snapshot = undefined;
    if (this.#notifying) return;
    this.#notifying = true;
    (this.#options.schedule ?? nextFrame)(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener();
    });
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
        capabilities: this.#capabilities(),
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
    await this.#loadAgents(entry);
    await this.#list(entry);
    // Catch up on the session on screen, after the last event this client handled.
    const selected = this.#selected();
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

  /** The Host's agents, and the version each one's new sessions launch. */
  async #loadAgents(entry: HostEntry) {
    const connection = entry.connection;
    if (!connection) return;
    try {
      entry.agents = (await connection.request('agents/list', {})).agents;
    } catch {
      entry.agents = [];
    }
    this.#changed();
  }

  /**
   * The Host's sessions: watched, so they stay up to date (`sessions/watch`), or listed once
   * (`sessions/list`) from a Host that can't.
   */
  async #list(entry: HostEntry) {
    const connection = entry.connection;
    if (!connection) return;
    try {
      entry.sessions = connection.supports(HOST_PROTOCOL.features.watch)
        ? (await connection.request('sessions/watch', {})).sessions
        : (await connection.request('sessions/list', {})).sessions;
      for (const listing of entry.sessions) {
        this.#read.observe(sessionKey(entry.record.hostId, listing.info.sessionId), listing.activity ?? undefined);
      }
      this.#changed();
    } catch (error) {
      this.#error = describe(error);
      this.#changed();
    }
  }

  /** A watched session appeared or changed. */
  #listed(entry: HostEntry, listing: SessionListing) {
    const index = entry.sessions.findIndex(({ info }) => info.sessionId === listing.info.sessionId);
    if (index === -1) {
      entry.sessions = [...entry.sessions, listing];
    } else {
      // The Host keeps no title for a session it no longer holds; the one it had still names it.
      const title = listing.info.title ?? entry.sessions[index].info.title;
      entry.sessions = entry.sessions.map((current, at) => at === index ? { ...listing, info: { ...listing.info, ...(title ? { title } : {}) } } : current);
    }
    this.#read.observe(sessionKey(entry.record.hostId, listing.info.sessionId), listing.activity ?? undefined);
    this.#changed();
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
        // Steers on their way failed with the connection; their senders say so.
        for (const followed of this.#followed.values()) followed.steering = [];
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
        switch (event.method) {
          case 'session/event':
            this.#journalEvent(entry, event.params);
            return;
          case 'session/changed': {
            const { sessionId, activity, clients, title, blank } = event.params;
            const followed = this.#followed.get(sessionKey(entry.record.hostId, sessionId));
            if (followed?.state) {
              followed.state = {
                ...followed.state,
                ...(activity ? { activity } : {}),
                ...(clients !== undefined && clients !== null ? { clients } : {}),
                ...(title ? { title } : {}),
                ...(blank !== undefined && blank !== null ? { blank } : {}),
              };
            }
            const listing = entry.sessions.find(({ info }) => info.sessionId === sessionId);
            if (listing) {
              if (activity) listing.activity = activity;
              if (clients !== undefined && clients !== null) listing.clients = clients;
              if (title) listing.info = { ...listing.info, title };
              listing.lastActivityAt = Date.now();
            } else if (followed?.state && !followed.state.blank && !connection.supports(HOST_PROTOCOL.features.watch)) {
              // A new session's first prompt lists it; a watched list hears of it anyway.
              void this.#list(entry);
            }
            this.#read.observe(sessionKey(entry.record.hostId, sessionId), activity ?? listing?.activity ?? undefined);
            this.#changed();
            return;
          }
          case 'sessions/updated':
            this.#listed(entry, event.params.session);
            return;
          case 'sessions/removed': {
            const { sessionId } = event.params;
            entry.sessions = entry.sessions.filter(({ info }) => info.sessionId !== sessionId);
            this.#changed();
            return;
          }
          case 'pending/added': {
            const followed = this.#followed.get(sessionKey(entry.record.hostId, event.params.sessionId));
            if (followed) this.#pendingAdded(followed, connection, event.params.pending);
            return;
          }
          case 'pending/resolved': {
            const followed = this.#followed.get(sessionKey(entry.record.hostId, event.params.sessionId));
            if (followed) this.#pendingResolved(followed, connection, event.params);
            return;
          }
          case 'session/elicitationCompleted': {
            const followed = this.#followed.get(sessionKey(entry.record.hostId, event.params.sessionId));
            if (followed) this.#apply(followed, [{ type: 'elicitation/completed', notification: event.params.notification }]);
            return;
          }
          case 'agents/updateAvailable': {
            const { sessionId, agentId, name, running, latest } = event.params;
            const followed = this.#followed.get(sessionKey(entry.record.hostId, sessionId));
            if (!followed) return;
            followed.update = { agentId, name, running, latest };
            this.#changed();
            // The Host tells open sessions again once the agent is updated on it: what its new
            // sessions launch may have changed.
            void this.#loadAgents(entry);
            return;
          }
          default:
            return;
        }
    }
  }

  #journalEvent(entry: HostEntry, notification: SessionEventNotification) {
    const followed = this.#followed.get(sessionKey(entry.record.hostId, notification.sessionId));
    if (!followed || !followed.follower.accept(notification)) return;
    const history = followed.follower.isHistory(notification);
    const { event } = notification;
    if ((event.kind === 'turnStarted' || event.kind === 'turnSteered') && 'client' in event.origin) {
      followed.clients.set(event.origin.client.id, originLabel(event.origin));
    }
    this.#apply(followed, transcriptEvents(notification, { history, own: (origin) => this.#own(entry, origin) }));
    // What waits shows once the history before it has.
    if (!followed.pendingShown && !followed.follower.replaying) this.#showPending(followed);
    if (history) return;
    if (event.kind === 'agentReopened') {
      // The new process says what prompts may carry now, and whether it steers.
      if (followed.state) followed.state = { ...followed.state, agent: event.agent };
      const version = event.agent.release?.version;
      if (followed.update && version) {
        followed.update = version === followed.update.latest ? undefined : { ...followed.update, running: version };
      }
    } else if (event.kind === 'turnEnded' && event.sessionId === notification.sessionId) {
      void this.#sendQueued(followed);
    }
  }

  /** Whether a prompt came from this device: this connection, or an earlier one of it. */
  #own(entry: HostEntry, origin: TurnOrigin) {
    if (!('client' in origin)) return false;
    const connection = entry.connection;
    if (origin.client.id === connection?.clientId) return true;
    const device = connection?.hello.device?.name;
    return Boolean(device) && origin.client.device === device;
  }

  #selected(): Followed | undefined {
    return this.#selectedKey ? this.#followed.get(this.#selectedKey) : undefined;
  }

  /** The connection to a followed session's Host, or why there isn't one. */
  #connection(followed: Followed): HostConnection {
    const entry = this.#hosts.get(followed.hostId);
    const connection = entry?.connection;
    if (!connection || connection.closed) throw new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`);
    return connection;
  }

  #select(key?: string) {
    const previous = this.#selected();
    if (previous && previous !== (key ? this.#followed.get(key) : undefined)) this.#leave(previous);
    this.#selectedKey = key;
    this.#read.focus(key);
    this.#error = undefined;
    if (key) {
      const [hostId, ...rest] = key.split('/');
      const sessionId = rest.join('/');
      let followed = this.#followed.get(key);
      if (!followed) {
        followed = this.#follow(hostId, sessionId);
        this.#followed.set(key, followed);
      }
      this.#attach(followed);
    }
    this.#changed();
  }

  #follow(hostId: string, sessionId: string): Followed {
    return {
      hostId,
      sessionId,
      follower: new JournalFollower(),
      transcript: createTranscript(sessionId),
      queued: [],
      steering: [],
      reopening: false,
      pending: [],
      pendingShown: false,
      clients: new Map(),
    };
  }

  /** Stops receiving a session. One nobody has prompted closes, as the TUI leaves it. */
  #leave(followed: Followed) {
    const connection = this.#hosts.get(followed.hostId)?.connection;
    const blank = followed.state?.blank ?? false;
    void connection?.request('session/detach', { sessionId: followed.sessionId, close: blank ? 'ifUnused' : 'never' }).catch(() => {});
    if (blank) this.#followed.delete(sessionKey(followed.hostId, followed.sessionId));
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
    const creating = this.#creating.get(event.tag);
    if (creating) {
      this.#creating.delete(event.tag);
      if (event.type === 'openFailed') {
        creating.reject(this.#explain(event.error, entry, creating.agentId));
        return;
      }
      this.#created(entry, event.session);
      creating.resolve();
      return;
    }
    const followed = [...this.#followed.values()].find(({ hostId, tag }) => hostId === entry.record.hostId && tag === event.tag);
    if (!followed) return;
    followed.tag = undefined;
    if (event.type === 'openFailed') {
      const agentId = entry.sessions.find(({ info }) => info.sessionId === followed.sessionId)?.agentId;
      this.#error = `Couldn't open the session: ${this.#explain(event.error, entry, agentId).message}`;
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
    // Replayed history changes no turn state: what runs now is the session's.
    const running = (state.turns ?? []).some(({ sessionId }) => sessionId === state.sessionId);
    const loaded = events.reduce(reduceAcpEvent, base);
    followed.transcript = {
      ...loaded,
      title: state.title ?? base.title,
      turn: running ? { status: 'running' } : loaded.turn.status === 'running' ? { status: 'idle' } : loaded.turn,
    };
    followed.state = state;
    followed.update = state.update
      ? { agentId: state.update.agentId, name: state.update.name, running: state.update.running, latest: state.update.latest }
      : undefined;
    followed.pending = state.pending ?? [];
    // Requests shown before that no longer wait stopped while this device wasn't attached.
    if (!reset) followed.transcript = reduceAcpEvent(followed.transcript, { type: 'requests/settled', waiting: followed.pending.map(({ id }) => id) });
    followed.pendingShown = false;
    if (!followed.follower.replaying) this.#showPending(followed);
    for (const pending of followed.pending) {
      if (pending.kind === 'clientTool') this.#runIfMine(followed, pending);
    }
    this.#changed();
    if (!running) void this.#sendQueued(followed);
  }

  /** Shows what waits in a session, once its replay is done. */
  #showPending(followed: Followed) {
    followed.pendingShown = true;
    const connection = this.#hosts.get(followed.hostId)?.connection;
    this.#apply(followed, followed.pending.flatMap((pending) => this.#pendingEvents(followed, pending, connection)));
  }

  /** A pending request as the transcript shows it; a client tool call this device runs shows only as the agent's tool call. */
  #pendingEvents(followed: Followed, pending: PendingRequest, connection?: HostConnection): AcpTranscriptEvent[] {
    const sessionId = pending.sessionId ?? undefined;
    switch (pending.kind) {
      case 'permission':
        return [{ type: 'permission/requested', requestId: pending.id, request: pending.request, sessionId }];
      case 'elicitation':
        return [{ type: 'elicitation/requested', requestId: pending.id, request: pending.request, sessionId }];
      case 'clientTool':
        if (pending.target === connection?.clientId) return [];
        return [{ type: 'clientTool/requested', requestId: pending.id, tool: pending.tool, runner: followed.clients.get(pending.target) ?? 'another client', sessionId }];
      default:
        return [];
    }
  }

  #pendingAdded(followed: Followed, connection: HostConnection, pending: PendingRequest) {
    followed.pending = [...followed.pending.filter(({ id }) => id !== pending.id), pending];
    if (pending.kind === 'clientTool') this.#runIfMine(followed, pending, connection);
    if (followed.pendingShown) this.#apply(followed, this.#pendingEvents(followed, pending, connection));
    this.#changed();
  }

  #pendingResolved(followed: Followed, connection: HostConnection, resolved: PendingResolvedNotification) {
    followed.pending = followed.pending.filter(({ id }) => id !== resolved.pendingId);
    const status = resolved.outcome === 'answered'
      ? resolved.by === connection.clientId ? 'answered' : 'elsewhere'
      : resolved.outcome;
    this.#apply(followed, [{ type: 'request/resolved', requestId: resolved.pendingId, status }]);
    this.#changed();
  }

  /**
   * Answers a pending request of the session on screen, showing the answer at once. Another
   * client's answer, the turn ending or the agent withdrawing it may have come first: the Host
   * says so with `pending/resolved`, which the card shows, and the answer isn't tried again.
   */
  async #answer(requestId: string, answer: Pick<AnswerPendingRequest, 'permission' | 'elicitation'>, shown: AcpTranscriptEvent) {
    const followed = this.#selected();
    const pending = followed?.pending.find(({ id }) => id === requestId);
    // One no longer waiting says why already.
    if (!followed || !pending) return;
    this.#error = undefined;
    this.#apply(followed, [shown]);
    try {
      await this.#connection(followed).request('pending/answer', { sessionId: followed.sessionId, pendingId: requestId, ...answer });
    } catch (error) {
      const waiting = followed.pending.some(({ id }) => id === requestId);
      if (failedWith(error, HOST_PROTOCOL.errors.alreadyResolved)) {
        // Resolved without this device hearing how: it no longer waits, whoever answered.
        if (waiting) {
          followed.pending = followed.pending.filter(({ id }) => id !== requestId);
          this.#apply(followed, [{ type: 'request/resolved', requestId, status: 'ended' }]);
        }
        return;
      }
      // An answer lost with the connection shows again on attaching, if the request still waits.
      if (failedWith(error, CONNECTION_CLOSED)) return;
      if (waiting) this.#apply(followed, this.#pendingEvents(followed, pending));
      this.#error = failedWith(error, HOST_PROTOCOL.errors.notTarget)
        ? 'That request is for another client.'
        : `Couldn't answer: ${describe(error)}`;
      this.#changed();
    }
  }

  /** Runs a client tool call aimed at this connection, and answers it with what it gave. */
  #runIfMine(followed: Followed, pending: PendingKind<'clientTool'>, connection = this.#hosts.get(followed.hostId)?.connection) {
    if (!connection || pending.target !== connection.clientId || this.#running.has(pending.id)) return;
    this.#running.add(pending.id);
    void (async () => {
      const tool = this.#options.clientTools?.[pending.tool];
      const result = tool
        ? await tool(pending.arguments).catch((error: unknown) => toolError(describe(error)))
        : toolError(`This client doesn't run ${pending.tool}.`);
      try {
        await connection.request('pending/answer', { sessionId: followed.sessionId, pendingId: pending.id, clientTool: result });
      } catch (error) {
        // Cancelled meanwhile, or the connection ended, which cancels it too.
        if (!failedWith(error, HOST_PROTOCOL.errors.alreadyResolved) && !failedWith(error, CONNECTION_CLOSED)) {
          this.#error = `Couldn't answer the agent's ${pending.tool} call: ${describe(error)}`;
          this.#changed();
        }
      } finally {
        this.#running.delete(pending.id);
      }
    })();
  }

  #apply(followed: Followed, events: AcpTranscriptEvent[]) {
    if (events.length === 0) return;
    followed.transcript = events.reduce(reduceAcpEvent, followed.transcript);
    this.#changed();
  }

  async #listDirectory({ hostId, path, hidden }: { hostId: string; path?: string; hidden?: boolean }): Promise<DirectoryListing> {
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) throw new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`);
    try {
      const listed = await connection.request('files/list', { ...(path ? { path } : {}), ...(hidden ? { hidden } : {}) });
      return {
        path: listed.path,
        ...(listed.parent ? { parent: listed.parent } : {}),
        home: listed.home,
        directories: listed.entries.filter(({ kind }) => kind === 'directory').map(({ name }) => name),
        truncated: listed.truncated ?? false,
      };
    } catch (error) {
      // The Host says why in the error's data: "/x doesn't exist".
      if (error instanceof HostError && typeof error.data === 'string') throw new Error(error.data);
      throw error;
    }
  }

  /** Starts a session and opens it; it rejects saying why the Host couldn't. */
  #create(input: { hostId: string; cwd: string; agentId: string }): Promise<void> {
    const entry = this.#hosts.get(input.hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) {
      return Promise.reject(new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`));
    }
    const tag = this.#nextTag++;
    return new Promise((resolve, reject) => {
      this.#creating.set(tag, { hostId: input.hostId, agentId: input.agentId, resolve, reject });
      connection.open({ create: { agentId: input.agentId, cwd: input.cwd } }, tag);
    });
  }

  #created(entry: HostEntry, session: OpenedSession) {
    const key = sessionKey(entry.record.hostId, session.state.sessionId);
    const previous = this.#selected();
    if (previous) this.#leave(previous);
    const followed = this.#follow(entry.record.hostId, session.state.sessionId);
    this.#followed.set(key, followed);
    this.#selectedKey = key;
    this.#read.focus(key);
    this.#error = undefined;
    this.#opened(followed, session);
  }

  async #send(text: string, images: PromptImage[] = []) {
    this.#error = undefined;
    const followed = this.#selected();
    if (!followed) return;
    const prompt: QueuedPrompt = { id: `prompt-${this.#nextLocal++}`, text, ...(images.length > 0 ? { images } : {}) };
    try {
      const connection = this.#connection(followed);
      if (followed.transcript.turn.status === 'running') {
        if (!this.#canSteer(followed, connection)) {
          followed.queued.push(prompt);
          this.#changed();
          return;
        }
        if (await this.#steer(followed, connection, prompt)) return;
      }
      await this.#start(followed, connection, prompt);
    } catch (error) {
      const explained = this.#explain(error, this.#hosts.get(followed.hostId), followed.state?.agent.id);
      this.#error = explained.message;
      this.#changed();
      throw explained;
    }
  }

  /** Sends a steer; false when no turn was running, so it should start one instead. */
  async #steer(followed: Followed, connection: HostConnection, prompt: QueuedPrompt): Promise<boolean> {
    followed.steering.push({ ...prompt, steering: true });
    this.#changed();
    try {
      const answer = await connection.request('turn/steer', { sessionId: followed.sessionId, prompt: promptBlocks(prompt.text, prompt.images) });
      // A steer the agent took shows where it joined the turn, from the journal.
      return answer.outcome === 'steered';
    } finally {
      followed.steering = followed.steering.filter(({ id }) => id !== prompt.id);
      this.#changed();
    }
  }

  /** Starts a turn with the prompt, shown at once; one already running (another client's) queues it. */
  async #start(followed: Followed, connection: HostConnection, prompt: QueuedPrompt) {
    const localId = `${followed.sessionId}:local:${prompt.id}`;
    const blocks = promptBlocks(prompt.text, prompt.images);
    const before = followed.transcript.turn;
    followed.transcript = reduceAcpEvent(queueOptimisticPrompt(followed.transcript, localId, blocks), { type: 'turn/started' });
    this.#changed();
    try {
      await connection.request('turn/start', { sessionId: followed.sessionId, prompt: blocks });
    } catch (error) {
      const entries = followed.transcript.entries.filter(({ id }) => id !== localId);
      if (error instanceof HostError && error.code === HOST_PROTOCOL.errors.turnRunning) {
        followed.transcript = { ...followed.transcript, entries, turn: { status: 'running' } };
        followed.queued.unshift(prompt);
        this.#changed();
        return;
      }
      followed.transcript = { ...followed.transcript, entries, turn: before };
      this.#changed();
      throw error;
    }
  }

  /** Sends the next queued message, once no turn runs. */
  async #sendQueued(followed: Followed) {
    if (followed.transcript.turn.status === 'running') return;
    const next = followed.queued.shift();
    if (!next) return;
    this.#changed();
    try {
      await this.#start(followed, this.#connection(followed), next);
    } catch (error) {
      followed.queued.unshift(next);
      this.#error = `Couldn't send the queued message: ${this.#explain(error, this.#hosts.get(followed.hostId), followed.state?.agent.id).message}`;
      this.#changed();
    }
  }

  /** A newer version is out; it's `available` once the Host's new sessions launch another version than the session runs. */
  #updateNotice(update: NonNullable<Followed['update']>, entry?: HostEntry): AgentUpdateNotice {
    const launches = entry?.agents.find(({ id }) => id === update.agentId)?.version;
    return launches && launches !== update.running ? { ...update, available: launches } : update;
  }

  /** Whether Send steers: the Host takes steers and the session's agent advertises them. */
  #canSteer(followed: Followed, connection = this.#hosts.get(followed.hostId)?.connection): boolean {
    if (!connection?.supports(HOST_PROTOCOL.features.steer)) return false;
    return meta(followed.state?.agent.initialize, '_meta', 'steering', 'supported') === true;
  }

  async #reopen() {
    const followed = this.#selected();
    if (!followed) return;
    const connection = this.#connection(followed);
    followed.reopening = true;
    this.#changed();
    try {
      await connection.request('session/reopen', { sessionId: followed.sessionId });
    } finally {
      followed.reopening = false;
      this.#changed();
    }
  }

  async #rename(key: string, title: string) {
    const [hostId, ...rest] = key.split('/');
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) throw new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`);
    try {
      // The new title comes back to every client: in the journal, and as the session's change.
      await connection.request('session/rename', { sessionId: rest.join('/'), title });
    } catch (error) {
      if (error instanceof HostError && typeof error.data === 'string') throw new Error(`Couldn't rename it: ${error.data}.`);
      throw error;
    }
  }

  async #close(key: string) {
    const followed = this.#followed.get(key);
    const [hostId, ...rest] = key.split('/');
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection) throw new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`);
    await connection.request('session/close', { sessionId: rest.join('/') });
    if (followed) this.#followed.delete(key);
    if (this.#selectedKey === key) this.#selectedKey = undefined;
    await this.#list(entry);
  }

  async #delete(key: string) {
    const [hostId, ...rest] = key.split('/');
    const sessionId = rest.join('/');
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection) throw new Error(`${entry?.record.name ?? 'The Host'} isn't connected.`);
    const agentId = entry.sessions.find(({ info }) => info.sessionId === sessionId)?.agentId ?? this.#followed.get(key)?.state?.agent.id;
    await connection.request('session/delete', { sessionId, ...(agentId ? { agentId } : {}) });
    this.#followed.delete(key);
    this.#read.forget(key);
    if (this.#selectedKey === key) this.#selectedKey = undefined;
    entry.sessions = entry.sessions.filter(({ info }) => info.sessionId !== sessionId);
    this.#changed();
    await this.#list(entry);
  }

  /** An error as the person should read it: an agent that needs signing in says how. */
  #explain(error: unknown, entry?: HostEntry, agentId?: string): Error {
    if (error instanceof HostError && error.code === AUTH_REQUIRED) {
      const agent = entry?.agents.find(({ id }) => id === agentId);
      const name = agent?.name ?? agentId ?? 'The agent';
      return new Error(`${name} needs signing in. Run \`weave login --agent ${agentId ?? '<agent>'}\` on the Host's computer, then try again.`);
    }
    if (error instanceof HostError && error.code === HOST_PROTOCOL.errors.forbidden) {
      return new Error(`${error.message}. That's done on the Host's computer.`);
    }
    return error instanceof Error ? error : new Error(String(error));
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
        capabilities: this.#capabilities(),
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
    const selected = this.#selected();
    for (const entry of this.#hosts.values()) {
      const { record } = entry;
      hosts.push({
        id: record.hostId,
        name: record.name,
        url: record.url,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.listFiles) ? { canBrowse: true } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.rename) ? { canRename: true } : {}),
      });
      agents[record.hostId] = entry.agents.map(({ id, name }) => ({ id, name }));
      const agentName = (agentId: string) => entry.agents.find(({ id }) => id === agentId)?.name ?? agentId;
      for (const listing of entry.sessions) {
        sessions.push({
          key: sessionKey(record.hostId, listing.info.sessionId),
          hostId: record.hostId,
          sessionId: listing.info.sessionId,
          ...(listing.info.title ? { title: listing.info.title } : {}),
          agentId: listing.agentId,
          agentName: agentName(listing.agentId),
          cwd: listing.info.cwd,
          state: listing.state,
          ...(listing.activity ? { activity: listing.activity } : {}),
          clients: listing.clients ?? 0,
          headless: listing.headless ?? false,
          lastActivityAt: listing.lastActivityAt ?? (listing.info.updatedAt ? Date.parse(listing.info.updatedAt) : undefined),
        });
      }
      // A session on screen the list doesn't have yet, such as a new one nobody has prompted.
      const state = selected?.hostId === record.hostId ? selected.state : undefined;
      if (state && !entry.sessions.some(({ info }) => info.sessionId === state.sessionId)) {
        sessions.push({
          key: sessionKey(record.hostId, state.sessionId),
          hostId: record.hostId,
          sessionId: state.sessionId,
          ...(state.title ? { title: state.title } : {}),
          agentId: state.agent.id,
          agentName: state.agent.name,
          cwd: state.cwd,
          state: 'open',
          activity: state.activity,
          clients: state.clients,
          headless: false,
          lastActivityAt: Date.now(),
        });
      }
    }
    return {
      hosts,
      sessions,
      agents,
      selectedKey: this.#selectedKey,
      session: selected && this.#selectedKey
        ? {
            key: this.#selectedKey,
            transcript: selected.transcript,
            canSteer: this.#canSteer(selected),
            queued: [...selected.steering, ...selected.queued],
            canAttachImages: selected.state?.agent.initialize.agentCapabilities?.promptCapabilities?.image === true,
            ...(selected.update ? { update: this.#updateNotice(selected.update, this.#hosts.get(selected.hostId)) } : {}),
            ...(selected.reopening ? { reopening: true } : {}),
          }
        : undefined,
      unread: this.#read.unread(),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
}
