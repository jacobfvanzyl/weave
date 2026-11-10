import {
  type AcpTranscript,
  type AcpTranscriptEvent,
  createTranscript,
  queueOptimisticPrompt,
  reduceAcpEvent,
  reduceJournalEvent,
} from '@/chat/acp-transcript';
import type {
  AgentChoice,
  AgentUpdateNotice,
  AppActions,
  CreatedThread,
  DirectoryListing,
  AppModel,
  LayoutChange,
  OpenSession,
  OpenThread,
  ProjectSummary,
  ThreadActions,
  DispatcherStatus,
  HostStatus,
  HostSummary,
  PromptImage,
  QueuedPrompt,
  RepositoryListing,
  TerminalSummary,
  TerminalTicket,
  ThreadGit,
  ThreadSummary,
  WorktreeRemoval,
} from '@/app/app-controller';
import { sessionKey, sessionOfKey, threadKey } from '@/app/app-controller';
import { threadBlock } from '@/session/blocks';
import { threadDirectories } from '@/session/sessions';
import { ThreadReadState } from '@/app/thread-read-state';
import { type ClientTool, toolError } from './client-tools';
import { CONNECTION_CLOSED, ConnectError, HostConnection, HostError, type HostEvent, type OpenedThread } from './connection';
import type { DeviceKey } from './device-key';
import type { DispatcherConnection, SocketOpener } from './dispatcher';
import { JournalFollower, originLabel, transcriptEvents } from './journal';
import { type Routes, hostCredentials, webRoutes } from './routes';
import { HostSessions } from './sessions';
import {
  HOST_PROTOCOL,
  type AgentSummary,
  type AnswerPendingRequest,
  type ClientCapabilities,
  type ClientInfo,
  type ContentBlock,
  type DispatcherHost,
  type GitLocation,
  type HostTerminal,
  type PendingRequest,
  type PendingResolvedNotification,
  type QueuedPrompt as HostQueuedPrompt,
  type ThreadEventNotification,
  type ThreadListing,
  type ThreadState,
  type TurnOrigin,
} from './protocol';
import { type DispatcherRecord, type PairingStorage, websocketUrl } from './storage';

export type HostStoreOptions = {
  storage: PairingStorage;
  /** The device key the Dispatcher knows this device by, or an earlier version's for a Host. */
  keyFor(keyId: string): DeviceKey;
  /** A new device key, for pairing with the Dispatcher. */
  newKey(): Promise<{ keyId: string; key: DeviceKey }>;
  /** A WebSocket to the Dispatcher: its API, or a connection it carries to a Host. */
  socket?: SocketOpener;
  /**
   * How the device reaches the Dispatcher and the Hosts, in place of `socket`'s WebSockets: the
   * Mac's core (ADR 0032), which also reaches this Mac's own Host over its socket.
   */
  routes?: Routes;
  client: ClientInfo;
  /** What a new pairing calls this device when the person names it nothing else. */
  deviceName: string;
  /**
   * Delays between reconnecting tries, in milliseconds, and between listing the Hosts again
   * while one is away; the last repeats.
   */
  backoff?: number[];
  /** How long connecting and saying hello may take before it counts as a failed try. Defaults to 15 seconds. */
  connectTimeout?: number;
  /**
   * How long a connection has to answer when the app comes to the front or the network changes,
   * before it's taken for dead and replaced. Defaults to 5 seconds.
   */
  probeTimeout?: number;
  /** The client tools this device runs for agents, by name (`capabilities.clientTools`). */
  clientTools?: Record<string, ClientTool>;
  /**
   * When to tell subscribers the model changed. Changes made meanwhile are told once, so a
   * replay of thousands of events renders a frame at a time. Defaults to the next frame.
   */
  schedule?(notify: () => void): void;
};

/** The Dispatcher this device is paired with (ADR 0030), and the connection to its API. */
type DispatcherEntry = {
  record: DispatcherRecord;
  key: DeviceKey;
  status: DispatcherStatus;
  error?: string;
  connection?: DispatcherConnection;
  /** The try under way; a newer one abandons it. */
  connecting?: AbortController;
  /** Whether it connected before, so a try is reconnecting, as is any after the first. */
  connected: boolean;
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
  /** Listing the Hosts again, while one is away, and how many times since none was. */
  relist?: ReturnType<typeof setTimeout>;
  relists: number;
  /** No more tries until the person asks: it refused or revoked this device, or speaks another version. */
  stopped: boolean;
};

/** One of the person's Hosts, as the Dispatcher lists it, and its connection through the Dispatcher. */
type HostEntry = {
  hostId: string;
  name: string;
  /** How the Dispatcher last listed it; none before it has. */
  listed?: DispatcherHost;
  status: HostStatus;
  error?: string;
  connection?: HostConnection;
  /** The try under way; a newer one abandons it. */
  connecting?: AbortController;
  /** Whether it connected before, so a try is reconnecting, as is any after the first. */
  connected: boolean;
  /** Whether it has listed its threads, so what a Session first shows is known. */
  listedThreads?: boolean;
  threads: ThreadListing[];
  agents: AgentSummary[];
  /** An attach was cut off by the connection ending before its answer, as a replay that fell behind would be. */
  attachCut?: boolean;
  /** No more tries until the person asks: the Host refuses this device, or speaks another protocol. */
  stopped: boolean;
  /** This computer's own Host, reached over its socket rather than through the Dispatcher. */
  local?: boolean;
  /** Reconnecting to this computer's own Host, which the Dispatcher's listing doesn't drive. */
  retry?: ReturnType<typeof setTimeout>;
  attempt?: number;
};

/** A thread this client follows: where its journal is up to, what it shows, and what waits to be sent. */
type Followed = {
  hostId: string;
  threadId: string;
  follower: JournalFollower;
  transcript: AcpTranscript;
  /** The tag of the attach whose answer it waits for. */
  tag?: number;
  /** The thread as attaching gave it, kept up to date: its agent, whether it's blank, its activity. */
  state?: ThreadState;
  /** The Host's queue, which holds messages for after the running turn (feature `queue`). */
  held: QueuedPrompt[];
  /** The Host's queue waits for someone to start it again. */
  queuePaused: boolean;
  /** Messages for after the running turn, sent in order as turns end, for a Host without a queue. */
  queued: QueuedPrompt[];
  /** Steers on their way, until the agent takes them or the Host says no turn runs. */
  steering: QueuedPrompt[];
  /** A newer version is out (`agents/updateAvailable`, or `ThreadState.update`). */
  update?: Omit<AgentUpdateNotice, 'available'>;
  updating: boolean;
  reopening: boolean;
  /** What waits in it now, as the Host says (`ThreadState.pending`, then `pending/added` and `pending/resolved`). */
  pending: PendingRequest[];
  /**
   * Whether the transcript shows what's pending. Not while an attach replays history: a request
   * shows after what came before it.
   */
  pendingShown: boolean;
  /**
   * Opened with nothing of it shown yet, its history still replaying: the transcript shows once
   * the replay has caught up, all at once, rather than filling in a frame at a time.
   */
  loading: boolean;
  /** Clients that prompted it, by client id, for naming who runs a client tool. */
  clients: Map<string, string>;
};

/** The Session on screen, and its directory's terminals while it is (`terminals/watch`). */
type ShownSession = {
  hostId: string;
  directory: string;
  /** The key it was asked for by, when its Host names its directory otherwise. */
  movedFrom?: string;
  terminals?: { scope: string; list: HostTerminal[] };
};

type PendingKind<K extends PendingRequest['kind']> = Extract<PendingRequest, { kind: K }>;

/** A `thread/create` waiting for its answer. */
type Creating = { hostId: string; agentId: string; resolve(created: CreatedThread): void; reject(error: Error): void };

/** ACP's error for an agent that needs signing in, passed through by the Host. */
const AUTH_REQUIRED = -32000;

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

const failedWith = (error: unknown, code: number) => error instanceof HostError && error.code === code;

const terminalSummary = (terminal: HostTerminal): TerminalSummary => ({
  id: terminal.id,
  scope: terminal.scope,
  ...(terminal.label ? { label: terminal.label } : {}),
  ...(terminal.title ? { title: terminal.title } : {}),
  ...(terminal.pwd ? { pwd: terminal.pwd } : {}),
  ...(terminal.openedFrom ? { openedFrom: terminal.openedFrom } : {}),
  ...(terminal.process?.foreground?.name ? { process: terminal.process.foreground.name } : {}),
  size: terminal.size,
  ...(terminal.command
    ? {
        command: {
          running: terminal.command.running,
          ...(terminal.command.command ? { command: terminal.command.command } : {}),
          ...(terminal.command.exitCode !== undefined && terminal.command.exitCode !== null ? { exitCode: terminal.command.exitCode } : {}),
        },
      }
    : {}),
  ...(terminal.programStatus?.length ? { programStatus: terminal.programStatus } : {}),
  startedAt: terminal.startedAt,
});

const threadGit = (git: GitLocation): ThreadGit => ({
  repo: git.repo,
  worktree: git.worktree,
  ...(git.branch ? { branch: git.branch } : {}),
});

/** What failed, and why as the Host says it: its error's text, when it gave one, says more than its message. */
/** Why a worktree can't go: its threads at work, its terminals running commands, or both. */
const busyWorktree = (error: unknown) => {
  const data = error instanceof HostError ? error.data as { threads?: unknown[]; terminals?: unknown[] } | undefined : undefined;
  const threads = (data?.threads?.length ?? 0) > 0 || !data?.terminals?.length;
  const terminals = (data?.terminals?.length ?? 0) > 0;
  const busy = [
    ...(threads ? ['a thread in it is running a turn or waiting on you'] : []),
    ...(terminals ? ['a terminal in it is running a command'] : []),
  ].join(', and ');
  return `${busy.charAt(0).toUpperCase()}${busy.slice(1)}. Let ${threads && terminals ? 'them' : 'it'} finish, or stop ${threads && terminals ? 'them' : 'it'}, first.`;
};

const failed = (what: string, error: unknown) =>
  new Error(`${what}: ${error instanceof HostError && typeof error.data === 'string' ? error.data : describe(error)}`);

const nextFrame = (notify: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => notify());
  else setTimeout(notify, 16);
};

/** A message as a prompt's content: the text, then any photos. */
export const promptBlocks = (text: string, images: PromptImage[] = []): ContentBlock[] => [
  ...(text ? [{ type: 'text' as const, text }] : []),
  ...images.map(({ mimeType, data }) => ({ type: 'image' as const, mimeType, data })),
];

/** Why the Dispatcher isn't connected to a Host, as it lists it. */
const hostAway = (host: DispatcherHost) => {
  if (host.why) return host.why;
  switch (host.status) {
    case 'unchecked': return "It hasn't connected to the Dispatcher since the Dispatcher started.";
    case 'refused': return 'It left the Dispatcher: `weave hosts add` on its computer joins it again.';
    case 'unjoined': return 'It was paired before Hosts joined the Dispatcher: `weave hosts add` on its computer joins it.';
    default: return "The Dispatcher can't reach it now.";
  }
};

const meta = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined, value);

/**
 * The Dispatcher this device is paired with, the Hosts it lists, and the thread on screen, kept up
 * to date from their connections, for the app's controller (`use-host-controller.ts`). The app
 * pairs only with the Dispatcher and reaches every Host through it (ADR 0030): one connection to
 * its API lists the Hosts, and each Host has a connection of its own that the Dispatcher carries.
 */
export class HostStore {
  readonly #options: HostStoreOptions;
  readonly #routes: Routes;
  #dispatcher?: DispatcherEntry;
  /** This computer's own Host, which the device reaches over its socket: only on the Mac. */
  #local?: string;
  /** In the Dispatcher's order. */
  #hosts = new Map<string, HostEntry>();
  readonly #followed = new Map<string, Followed>();
  /** The threads on screen, which this client is attached to; `#selectedKey` is the one in front. */
  #shown = new Set<string>();
  /** Threads this device started that no layout has shown yet: they stay until one does. */
  readonly #fresh = new Set<string>();
  readonly #sessions: HostSessions;
  #session?: ShownSession;
  #projects: ProjectSummary[] = [];
  readonly #perThread = new Map<string, ThreadActions>();
  readonly #creating = new Map<number, Creating>();
  /** Client tool calls running on this device, by pending id. */
  readonly #running = new Set<string>();
  readonly #read = new ThreadReadState();
  readonly #listeners = new Set<() => void>();
  #selectedKey?: string;
  #error?: string;
  #nextTag = 1;
  #nextLocal = 1;
  #snapshot?: AppModel;
  #notifying = false;
  #stopped = false;
  #starting = true;

  constructor(options: HostStoreOptions) {
    this.#options = options;
    if (options.routes) this.#routes = options.routes;
    else if (options.socket) this.#routes = webRoutes(options.socket);
    else throw new Error('The store needs a way to reach the Dispatcher: `socket` or `routes`.');
    this.#sessions = new HostSessions({
      connection: (hostId) => this.#hosts.get(hostId)?.connection,
      first: (hostId, directory) => {
        const entry = this.#hosts.get(hostId);
        if (!entry?.listedThreads) return undefined;
        // Placed as the list of Sessions places them, so a Session first shows the threads listed in it.
        const located = entry.threads.map((listing) => ({
          key: threadKey(hostId, listing.info.sessionId),
          hostId,
          cwd: listing.info.cwd,
          ...(listing.git ? { git: threadGit(listing.git) } : {}),
        }));
        const directories = threadDirectories(located, this.#sessions.known());
        // A thread on screen the list doesn't have yet, as one just started and not yet prompted,
        // comes first: its Session may be new too, and shows it without anything being saved.
        const fresh = [...this.#shown].flatMap((key) => {
          const state = key.startsWith(`${hostId}/`) ? this.#followed.get(key)?.state : undefined;
          if (!state || entry.threads.some(({ info }) => info.sessionId === state.threadId)) return [];
          return sessionKey(hostId, state.git?.worktree ?? state.cwd) === sessionKey(hostId, directory) ? [threadBlock(state.threadId)] : [];
        });
        return [...fresh, ...entry.threads
          .filter((listing) => listing.state !== 'closed' && directories.get(threadKey(hostId, listing.info.sessionId)) === directory)
          .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
          .map((listing) => threadBlock(listing.info.sessionId))];
      },
      changed: () => this.#changed(),
      failed: (message) => {
        this.#error = message;
        this.#changed();
      },
      moved: (from, to) => {
        const shown = this.#session;
        if (!shown || sessionKey(shown.hostId, shown.directory) !== from) return;
        shown.directory = sessionOfKey(to).directory;
        shown.movedFrom = from;
      },
    });
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

  /**
   * Loads the pairing and connects to the Dispatcher, which lists the Hosts to connect to. Once
   * paired with it, the app no longer keeps the Hosts an earlier version paired with one by one.
   */
  async start() {
    const record = await this.#options.storage.load();
    this.#starting = false;
    if (!record || this.#stopped) {
      this.#changed();
      return;
    }
    this.#adopt(record);
    this.#changed();
    await this.#forgetOldHosts();
    await this.#findLocal();
    await this.#connectDispatcher();
  }

  /**
   * This computer's own Host, if one answers on its socket: listed with the others, but reached
   * over its socket, with or without the Dispatcher (ADR 0030's local clients).
   */
  async #findLocal() {
    const local = this.#routes.local;
    if (!local || this.#stopped) return;
    const hostId = await local.find().catch(() => undefined);
    if (!hostId || this.#stopped) return;
    this.#local = hostId;
    this.#adoptLocal();
  }

  /** Lists this computer's own Host and connects to it, once it's known. */
  #adoptLocal() {
    const hostId = this.#local;
    if (!hostId || !this.#dispatcher) return;
    let entry = this.#hosts.get(hostId);
    if (!entry) {
      entry = this.#entry(hostId, 'This Mac');
      this.#hosts.set(hostId, entry);
    }
    entry.local = true;
    this.#changed();
    if (!entry.connection && !entry.connecting) void this.#connect(entry);
  }

  /** Closes every connection. */
  stop() {
    this.#stopped = true;
    if (this.#dispatcher) this.#letGo(this.#dispatcher);
    for (const entry of this.#hosts.values()) this.#closeHost(entry);
  }

  /**
   * Lists the Hosts and every Host's threads again, and reconnects at once to what dropped, or
   * doesn't answer within `probeTimeout`: the app came to the front, the network changed, or the
   * list was pulled down. A Host that keeps the list live (`threads/watch`) is asked to start
   * over, so nothing older than what it last said comes after it.
   */
  async refresh() {
    const dispatcher = this.#dispatcher;
    if (!dispatcher || this.#stopped) return;
    // This computer's own Host answers without the Dispatcher.
    if (dispatcher.stopped) {
      await Promise.all([...this.#hosts.values()].filter((entry) => entry.local).map((entry) => this.#wake(entry)));
      return;
    }
    dispatcher.relists = 0;
    void this.#listProjects(dispatcher);
    await Promise.all([this.#wakeDispatcher(dispatcher), ...[...this.#hosts.values()].map((entry) => this.#wake(entry))]);
  }

  /** Lists the Hosts again, or replaces the Dispatcher's connection when it doesn't answer within `probeTimeout`. */
  async #wakeDispatcher(dispatcher: DispatcherEntry) {
    const connection = dispatcher.connection;
    if (connection && !connection.closed) {
      const listing = connection.request('hosts/list', {});
      if (await this.#within(listing.then(() => !connection.closed, () => false))) {
        await this.#hostsListed(dispatcher, (await listing).hosts);
        return;
      }
      // Likely on a network that's gone: the Dispatcher will see it go, and this device needn't wait.
      if (dispatcher.connection === connection) {
        dispatcher.connection = undefined;
        connection.close();
      }
    }
    if (this.#dispatcher !== dispatcher || dispatcher.stopped || dispatcher.connection) return;
    dispatcher.attempt = 0;
    await this.#connectDispatcher();
  }

  async #wake(entry: HostEntry) {
    if (entry.stopped) return;
    const connection = entry.connection;
    if (connection && !connection.closed) {
      if (await this.#answers(entry, connection)) return;
      // Likely on a network that's gone: the Host will see it go, and this device needn't wait.
      if (entry.connection === connection) this.#drop(entry);
    }
    if (entry.connection || entry.connecting || entry.stopped || this.#hosts.get(entry.hostId) !== entry) return;
    // One the Dispatcher can't reach comes back when it lists it connected.
    if (!entry.local && entry.listed && !entry.listed.connected) return;
    await this.#connect(entry);
  }

  /** Whether a connection still answers: it lists the threads again within `probeTimeout`. */
  #answers(entry: HostEntry, connection: HostConnection): Promise<boolean> {
    return this.#within(this.#list(entry).then(() => !connection.closed));
  }

  /** Whether `answered` says yes within `probeTimeout`. */
  async #within(answered: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#options.probeTimeout ?? 5_000);
    });
    try {
      return await Promise.race([answered, silent]);
    } finally {
      clearTimeout(timer);
    }
  }

  readonly actions: AppActions = {
    selectThread: (key) => this.#select(key),
    selectSession: (key) => this.#selectSession(key),
    showThreads: (keys, front) => this.#show(keys, front, false),
    forThread: (key) => {
      let actions = this.#perThread.get(key);
      if (!actions) {
        actions = this.#threadActions(() => this.#followed.get(key));
        this.#perThread.set(key, actions);
      }
      return actions;
    },
    updateLayout: (key, change) => this.#updateLayout(key, change),
    endSession: (key) => this.#endSession(key),
    refresh: () => this.refresh(),
    pairDispatcher: (input) => this.#pair(input),
    forgetDispatcher: () => this.#forget(),
    reconnectDispatcher: async () => {
      const dispatcher = this.#dispatcher;
      // A revoked device has no pairing left to connect with.
      if (!dispatcher || dispatcher.status === 'revoked') return;
      dispatcher.stopped = false;
      dispatcher.attempt = 0;
      await this.#connectDispatcher();
    },
    reconnectHost: async (hostId) => {
      const entry = this.#hosts.get(hostId);
      if (!entry || this.#dispatcher?.stopped) return;
      entry.stopped = false;
      await this.#connect(entry);
    },
    createThread: (input) => this.#create(input),
    listDirectory: (input) => this.#listDirectory(input),
    listWorktrees: (input) => this.#listWorktrees(input),
    createWorktree: (input) => this.#createWorktree(input),
    removeWorktree: (input) => this.#removeWorktree(input),
    closeThread: (key) => this.#report(() => this.#close(key)),
    renameThread: (key, title) => this.#rename(key, title),
    deleteThread: (key) => this.#report(() => this.#delete(key)),
    ...this.#threadActions(() => this.#selected()),
    newTerminal: () => this.#newTerminal(),
    closeTerminal: async (id) => {
      const { connection } = this.#sessionHost();
      try {
        await connection.request('terminals/close', { id });
      } catch (error) {
        throw failed("Couldn't close the terminal", error);
      }
    },
    renameTerminal: async (id, label) => {
      const { shown, connection } = this.#sessionHost();
      try {
        const { terminal } = await connection.request('terminals/setLabel', { id, ...(label?.trim() ? { label: label.trim() } : {}) });
        this.#terminalUpdated(shown.hostId, terminal);
      } catch (error) {
        throw failed("Couldn't rename the terminal", error);
      }
    },
    attachTerminal: (id) => this.#attachTerminal(id),
  };

  /** What's done in one thread, in the one `pick` gives when it's done. */
  #threadActions(pick: () => Followed | undefined): ThreadActions {
    return {
      send: (text, images) => this.#send(text, images, pick()),
      removeQueued: (id) => {
        const followed = pick();
        if (!followed) return;
        if (followed.held.some((prompt) => prompt.id === id)) {
          // It leaves when the Host's `unqueued` event says so.
          void this.#report(async () => {
            await this.#connection(followed).request('queue/remove', { threadId: followed.threadId, queuedId: id });
          });
          return;
        }
        followed.queued = followed.queued.filter((prompt) => prompt.id !== id);
        this.#changed();
      },
      resumeQueue: () => this.#report(async () => {
        const followed = pick();
        if (!followed) return;
        await this.#connection(followed).request('queue/resume', { threadId: followed.threadId });
      }),
      cancelTurn: () => this.#report(async () => {
        const followed = pick();
        if (!followed) return;
        await this.#connection(followed).request('turn/cancel', { threadId: followed.threadId });
      }),
      reopenThread: () => this.#report(() => this.#reopen(pick())),
      updateAgent: () => this.#report(() => this.#updateAgent(pick())),
      respondToPermission: (requestId, optionId) => this.#answer(
        requestId,
        { permission: { outcome: { outcome: 'selected', optionId } } },
        { type: 'permission/resolved', requestId, optionId },
        pick(),
      ),
      respondToElicitation: (requestId, response) => this.#answer(
        requestId,
        { elicitation: response },
        { type: 'elicitation/resolved', requestId, response },
        pick(),
      ),
      setMode: (modeId) => this.#report(async () => {
        const followed = pick();
        if (!followed) return;
        await this.#connection(followed).request('thread/setMode', { threadId: followed.threadId, modeId });
      }),
      setConfigOption: (configId, value) => this.#report(async () => {
        const followed = pick();
        if (!followed) return;
        // The change reaches every client, this one too, through the journal.
        await this.#connection(followed).request('thread/setConfigOption', typeof value === 'boolean'
          ? { threadId: followed.threadId, configId, type: 'boolean', value }
          : { threadId: followed.threadId, configId, value });
      }),
    };
  }

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

  #entry(hostId: string, name: string): HostEntry {
    return { hostId, name, status: 'connecting', connected: false, threads: [], agents: [], stopped: false };
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

  #backoff(attempt: number) {
    const backoff = this.#options.backoff ?? [1_000, 2_000, 5_000, 10_000, 30_000];
    return backoff[Math.min(attempt, backoff.length - 1)];
  }

  /** `record` is the pairing from now on, with the Hosts it last listed. */
  #adopt(record: DispatcherRecord): DispatcherEntry {
    const dispatcher: DispatcherEntry = {
      record,
      key: this.#options.keyFor(record.keyId),
      status: 'connecting',
      connected: false,
      attempt: 0,
      relists: 0,
      stopped: false,
    };
    this.#dispatcher = dispatcher;
    this.#hosts = new Map((record.hosts ?? []).map(({ id, name }) => [id, this.#entry(id, name)]));
    return dispatcher;
  }

  /** Deletes the keys of the Hosts an earlier version of the app paired with, and their records. */
  async #forgetOldHosts() {
    const keys = await this.#options.storage.oldHostKeys().catch(() => []);
    if (keys.length === 0) return;
    await Promise.all(keys.map((keyId) => this.#options.keyFor(keyId).forget().catch(() => {})));
    await this.#options.storage.forgetOldHosts().catch(() => {});
  }

  /**
   * Proves the device to the Dispatcher again, then lists the Hosts and connects to each it's
   * connected to. A try still under way, as on a network that has since changed, is abandoned.
   */
  async #connectDispatcher() {
    const dispatcher = this.#dispatcher;
    if (this.#stopped || !dispatcher || dispatcher.stopped) return;
    clearTimeout(dispatcher.retry);
    dispatcher.retry = undefined;
    const previous = dispatcher.connection;
    dispatcher.connection = undefined;
    previous?.close();
    dispatcher.connecting?.abort();
    const connecting = new AbortController();
    dispatcher.connecting = connecting;
    const timeout = this.#options.connectTimeout ?? 15_000;
    const timer = setTimeout(() => connecting.abort(new Error(`The Dispatcher didn't answer within ${timeout / 1_000} seconds.`)), timeout);
    dispatcher.status = dispatcher.connected || dispatcher.attempt > 0 ? 'reconnecting' : 'connecting';
    this.#changed();
    const { record, key } = dispatcher;
    const current = () => this.#dispatcher === dispatcher && dispatcher.connecting === connecting && !this.#stopped;
    let connection: DispatcherConnection | undefined;
    try {
      connection = await this.#routes.dispatcher({
        pairing: { url: record.url, dispatcherId: record.dispatcherId, deviceId: record.deviceId, key },
        client: this.#options.client,
        onClosed: (close) => { if (connection) this.#dispatcherClosed(dispatcher, connection, close); },
        signal: connecting.signal,
      });
    } catch (error) {
      if (!current()) return;
      dispatcher.connecting = undefined;
      this.#dispatcherFailed(dispatcher, error);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!current()) {
      connection.close();
      return;
    }
    dispatcher.connecting = undefined;
    await this.#dispatcherConnected(dispatcher, connection);
  }

  async #dispatcherConnected(dispatcher: DispatcherEntry, connection: DispatcherConnection) {
    dispatcher.connection = connection;
    dispatcher.connected = true;
    dispatcher.status = 'connected';
    dispatcher.error = undefined;
    dispatcher.attempt = 0;
    dispatcher.relists = 0;
    this.#changed();
    void this.#listProjects(dispatcher);
    await this.#listHosts();
  }

  /** The person's Projects, from a Dispatcher that keeps them (WVE-189): they group the Sessions. */
  async #listProjects(dispatcher: DispatcherEntry) {
    const connection = dispatcher.connection;
    if (!connection || connection.closed || !connection.hello.features?.includes(HOST_PROTOCOL.dispatcher.features.projects)) return;
    try {
      const { projects } = await connection.request('projects/list', {});
      if (this.#dispatcher !== dispatcher) return;
      this.#projects = projects.map(({ id, name, locations }) => ({
        id,
        name,
        locations: (locations ?? []).map(({ hostId, path }) => ({ hostId, path })),
      }));
      this.#changed();
    } catch {
      // The Sessions show under their Hosts, as without Projects.
    }
  }

  #dispatcherFailed(dispatcher: DispatcherEntry, error: unknown) {
    const kind = error instanceof ConnectError ? error.kind : 'connection';
    switch (kind) {
      case 'unpaired':
        this.#haltDispatcher(dispatcher, 'refused', describe(error));
        return;
      case 'incompatible':
        this.#haltDispatcher(dispatcher, 'incompatible', describe(error));
        return;
      default:
        dispatcher.error = describe(error);
        this.#retryDispatcher(dispatcher);
    }
  }

  #dispatcherClosed(dispatcher: DispatcherEntry, connection: DispatcherConnection, close: { code?: number; reason?: string }) {
    if (dispatcher.connection !== connection) return;
    dispatcher.connection = undefined;
    switch (close.code) {
      case HOST_PROTOCOL.websocket.closeRevoked:
        void this.#revoked();
        return;
      case HOST_PROTOCOL.websocket.closeUnauthenticated:
        this.#haltDispatcher(dispatcher, 'refused', `The Dispatcher closed the connection: ${close.reason || "this device isn't authenticated"}. Pair it again.`);
        return;
      default:
        // A dropped network or a Dispatcher restart: try again, backing off.
        dispatcher.error = close.reason || 'Its connection dropped.';
        this.#retryDispatcher(dispatcher);
    }
  }

  #retryDispatcher(dispatcher: DispatcherEntry) {
    clearTimeout(dispatcher.relist);
    dispatcher.relist = undefined;
    const delay = this.#backoff(dispatcher.attempt);
    dispatcher.attempt += 1;
    dispatcher.status = 'reconnecting';
    dispatcher.retry = setTimeout(() => void this.#connectDispatcher(), delay);
    this.#changed();
  }

  /** Lets go of the Dispatcher's connection and stops its timers. */
  #letGo(dispatcher: DispatcherEntry) {
    clearTimeout(dispatcher.retry);
    clearTimeout(dispatcher.relist);
    dispatcher.retry = undefined;
    dispatcher.relist = undefined;
    dispatcher.connecting?.abort();
    dispatcher.connecting = undefined;
    const connection = dispatcher.connection;
    dispatcher.connection = undefined;
    connection?.close();
  }

  /**
   * Stops trying until the person asks, saying why. No Host is reached without the Dispatcher, so
   * their connections close too, and they stay listed as it last listed them.
   */
  #haltDispatcher(dispatcher: DispatcherEntry, status: DispatcherStatus, error: string) {
    this.#letGo(dispatcher);
    dispatcher.status = status;
    dispatcher.stopped = true;
    dispatcher.error = error;
    // This computer's own Host is reached without it.
    for (const entry of this.#hosts.values()) if (!entry.local) this.#closeHost(entry);
    this.#changed();
  }

  /**
   * The Dispatcher revoked this device (4000), on any of its connections, so its pairing is gone:
   * the app deletes its key and record, forgets the Hosts it listed, and says to pair again.
   */
  async #revoked() {
    const dispatcher = this.#dispatcher;
    if (!dispatcher || dispatcher.status === 'revoked') return;
    this.#haltDispatcher(dispatcher, 'revoked', 'The Dispatcher revoked this device, which has forgotten the pairing. Pair it again to reach your Hosts.');
    for (const entry of this.#hosts.values()) this.#closeHost(entry);
    this.#hosts = new Map();
    this.#forgetShown();
    this.#changed();
    await dispatcher.key.forget().catch(() => {});
    if (this.#dispatcher === dispatcher) await this.#options.storage.save(undefined);
  }

  /**
   * The Hosts the Dispatcher lists now, how each stands, and a connection to each it's connected
   * to. While one is away, it lists them again, backing off, so a Host that comes back is
   * connected once the Dispatcher is: it says nothing of its own when one does.
   */
  async #listHosts() {
    const dispatcher = this.#dispatcher;
    const connection = dispatcher?.connection;
    if (!dispatcher || !connection || connection.closed) return;
    clearTimeout(dispatcher.relist);
    dispatcher.relist = undefined;
    let hosts: DispatcherHost[];
    try {
      ({ hosts } = await connection.request('hosts/list', {}));
    } catch (error) {
      // A connection that ended shows in the Dispatcher's status.
      if (failedWith(error, CONNECTION_CLOSED)) return;
      this.#error = describe(error);
      this.#changed();
      return;
    }
    await this.#hostsListed(dispatcher, hosts);
  }

  /** The Hosts the Dispatcher listed: kept in its order, and connected to once it is. */
  async #hostsListed(dispatcher: DispatcherEntry, hosts: DispatcherHost[]) {
    if (this.#dispatcher !== dispatcher || dispatcher.stopped) return;
    clearTimeout(dispatcher.relist);
    dispatcher.relist = undefined;
    const before = this.#hosts;
    // A Host it no longer has is gone, with its threads; this computer's own stays.
    for (const [hostId, entry] of before) {
      if (entry.local || hosts.some((host) => host.hostId === hostId)) continue;
      this.#closeHost(entry);
      this.#unfollow(hostId);
    }
    this.#hosts = new Map(hosts.map((host) => {
      const entry = before.get(host.hostId) ?? this.#entry(host.hostId, host.name);
      entry.name = host.name;
      entry.listed = host;
      return [host.hostId, entry];
    }));
    const local = this.#local ? before.get(this.#local) : undefined;
    if (local && !this.#hosts.has(local.hostId)) this.#hosts.set(local.hostId, local);
    const connecting: Promise<void>[] = [];
    for (const entry of this.#hosts.values()) {
      if (entry.connection || entry.connecting || entry.stopped) continue;
      if (entry.local) {
        // Its socket, whatever the Dispatcher says; a retry under way tries again itself.
        if (!entry.retry) connecting.push(this.#connect(entry));
      } else if (entry.listed?.connected) {
        connecting.push(this.#connect(entry));
      } else if (entry.listed) {
        entry.status = 'unreachable';
        entry.error = hostAway(entry.listed);
      }
    }
    this.#changed();
    await this.#keepHosts(dispatcher);
    await Promise.all(connecting);
    if (this.#dispatcher !== dispatcher) return;
    if ([...this.#hosts.values()].some((entry) => !entry.local && !entry.connection && !entry.connecting && !entry.stopped)) this.#relist(dispatcher);
    else dispatcher.relists = 0;
  }

  /** Lists the Hosts again later, backing off, while one is away. */
  #relist(dispatcher: DispatcherEntry) {
    if (dispatcher.relist || !dispatcher.connection || dispatcher.stopped || this.#stopped) return;
    const delay = this.#backoff(dispatcher.relists);
    dispatcher.relists += 1;
    dispatcher.relist = setTimeout(() => {
      dispatcher.relist = undefined;
      void this.#listHosts();
    }, delay);
  }

  /** Keeps the Hosts it listed with the pairing, for when it can't be reached. */
  async #keepHosts(dispatcher: DispatcherEntry) {
    const hosts = [...this.#hosts.values()].map(({ hostId, name }) => ({ id: hostId, name }));
    if (JSON.stringify(hosts) === JSON.stringify(dispatcher.record.hosts ?? [])) return;
    dispatcher.record = { ...dispatcher.record, hosts };
    await this.#options.storage.save(dispatcher.record).catch(() => {});
  }

  /**
   * Has the Dispatcher carry a connection to the Host, says hello there, and once connected
   * attaches after the last position of the thread on screen. A try still under way, as on a
   * network that has since changed, is abandoned.
   */
  async #connect(entry: HostEntry) {
    const dispatcher = this.#dispatcher;
    const local = entry.local ? this.#routes.local : undefined;
    // This computer's own Host is reached without the Dispatcher; every other only through it.
    if (this.#stopped || !dispatcher || (!local && dispatcher.stopped)) return;
    clearTimeout(entry.retry);
    entry.retry = undefined;
    this.#drop(entry);
    entry.connecting?.abort();
    const connecting = new AbortController();
    entry.connecting = connecting;
    const timeout = this.#options.connectTimeout ?? 15_000;
    const how = local ? 'on its socket' : 'through the Dispatcher';
    const timer = setTimeout(() => connecting.abort(new Error(`${entry.name} didn't answer ${how} within ${timeout / 1_000} seconds.`)), timeout);
    // Any try after the first is reconnecting.
    entry.status = entry.connected || entry.status !== 'connecting' ? 'reconnecting' : 'connecting';
    this.#changed();
    const { record, key } = dispatcher;
    const pairing = { url: record.url, dispatcherId: record.dispatcherId, deviceId: record.deviceId, key };
    const current = () => this.#hosts.get(entry.hostId) === entry && entry.connecting === connecting && this.#dispatcher === dispatcher && !this.#stopped;
    let connection: HostConnection | undefined;
    try {
      connection = await HostConnection.connect({
        connector: local?.connector ?? this.#routes.host({ pairing, hostId: entry.hostId, client: this.#options.client }),
        client: this.#options.client,
        capabilities: this.#capabilities(),
        credentials: hostCredentials(Boolean(local)),
        // What it sends during hello, its close included, is answered by `connect` failing.
        onEvent: (event) => { if (connection) this.#event(entry, connection, event); },
        signal: connecting.signal,
      });
    } catch (error) {
      if (!current()) return;
      entry.connecting = undefined;
      this.#connectFailed(entry, error);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!current()) {
      connection.close();
      return;
    }
    entry.connecting = undefined;
    await this.#connected(entry, connection);
  }

  async #connected(entry: HostEntry, connection: HostConnection) {
    entry.connection = connection;
    entry.connected = true;
    entry.attempt = 0;
    entry.status = 'connected';
    entry.error = undefined;
    this.#changed();
    await this.#loadAgents(entry);
    await this.#list(entry);
    if (entry.connection !== connection) return;
    void this.#sessions.watch(entry.hostId, connection);
    if (this.#session?.hostId === entry.hostId) void this.#watchTerminals(this.#session);
    // Catch up on the threads on screen, after the last event this client handled.
    for (const key of this.#shown) {
      const followed = this.#followed.get(key);
      if (followed?.hostId === entry.hostId) this.#attach(followed);
    }
  }

  #connectFailed(entry: HostEntry, error: unknown) {
    const kind = error instanceof ConnectError ? error.kind : 'connection';
    switch (kind) {
      case 'connection':
        entry.status = 'reconnecting';
        entry.error = describe(error);
        this.#away(entry);
        return;
      case 'unavailable':
        entry.status = 'unreachable';
        entry.error = describe(error);
        this.#away(entry);
        return;
      case 'unpaired':
        if (this.#dispatcher) this.#haltDispatcher(this.#dispatcher, 'refused', describe(error));
        return;
      case 'refused':
        // 4002 follows the error: trying again would only be refused again.
        this.#halt(entry, 'disconnected', `The Host refused this device (${describe(error)}).`);
        return;
      case 'incompatible':
        this.#halt(entry, 'incompatible', describe(error));
        return;
    }
  }

  /**
   * A Host's connection failed or dropped: the Dispatcher lists the Hosts again before long, and
   * says whether it still reaches it. This computer's own Host is tried again on its socket,
   * backing off.
   */
  #away(entry: HostEntry) {
    this.#changed();
    if (this.#hosts.get(entry.hostId) !== entry) return;
    if (entry.local) {
      if (entry.retry || this.#stopped) return;
      const delay = this.#backoff(entry.attempt ?? 0);
      entry.attempt = (entry.attempt ?? 0) + 1;
      entry.retry = setTimeout(() => {
        entry.retry = undefined;
        void this.#connect(entry);
      }, delay);
      return;
    }
    if (this.#dispatcher) this.#relist(this.#dispatcher);
  }

  /** Stops trying until the person asks, saying why. */
  #halt(entry: HostEntry, status: HostStatus, error: string) {
    entry.status = status;
    entry.stopped = true;
    entry.error = error;
    this.#changed();
  }

  /** Lets go of a Host's connection without waiting for it to end, as when it may be on a network that's gone. */
  #drop(entry: HostEntry) {
    const connection = entry.connection;
    if (!connection) return;
    this.#lost(entry);
    connection.close();
  }

  /** Lets go of a Host's connection and any try under way. */
  #closeHost(entry: HostEntry) {
    clearTimeout(entry.retry);
    entry.retry = undefined;
    entry.connecting?.abort();
    entry.connecting = undefined;
    this.#drop(entry);
  }

  /** The Host's connection ended: steers on their way failed with it, and their senders say so. */
  #lost(entry: HostEntry) {
    entry.connection = undefined;
    for (const followed of this.#followed.values()) {
      if (followed.hostId === entry.hostId) followed.steering = [];
    }
    this.#changed();
  }

  /** Forgets what the app followed in a Host's threads, and leaves the one on screen. */
  #unfollow(hostId: string) {
    for (const [key, followed] of this.#followed) {
      if (followed.hostId === hostId) this.#followed.delete(key);
    }
    if (this.#selectedKey?.startsWith(`${hostId}/`)) this.#selectedKey = undefined;
    this.#shown = new Set([...this.#shown].filter((key) => !key.startsWith(`${hostId}/`)));
    this.#sessions.forget(hostId);
    if (this.#session?.hostId === hostId) this.#session = undefined;
  }

  /** The Host's agents, and the version each one's new threads launch. */
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
   * The Host's threads: watched, so they stay up to date (`threads/watch`), or listed once
   * (`threads/list`) from a Host that can't.
   */
  async #list(entry: HostEntry) {
    const connection = entry.connection;
    if (!connection) return;
    try {
      entry.threads = connection.supports(HOST_PROTOCOL.features.watch)
        ? (await connection.request('threads/watch', {})).threads
        : (await connection.request('threads/list', {})).threads;
      for (const listing of entry.threads) {
        this.#read.observe(threadKey(entry.hostId, listing.info.sessionId), listing.activity ?? undefined);
      }
      entry.listedThreads = true;
      this.#changed();
    } catch (error) {
      // A connection that ended shows in the Host's status.
      if (failedWith(error, CONNECTION_CLOSED)) return;
      this.#error = describe(error);
      this.#changed();
    }
  }

  /** A watched thread appeared or changed. */
  #listed(entry: HostEntry, listing: ThreadListing) {
    const index = entry.threads.findIndex(({ info }) => info.sessionId === listing.info.sessionId);
    if (index === -1) {
      entry.threads = [...entry.threads, listing];
    } else {
      // The Host keeps no title for a thread it no longer holds; the one it had still names it.
      const title = listing.info.title ?? entry.threads[index].info.title;
      entry.threads = entry.threads.map((current, at) => at === index ? { ...listing, info: { ...listing.info, ...(title ? { title } : {}) } } : current);
    }
    this.#read.observe(threadKey(entry.hostId, listing.info.sessionId), listing.activity ?? undefined);
    this.#changed();
  }

  #event(entry: HostEntry, connection: HostConnection, event: HostEvent) {
    if (entry.connection !== connection && event.type !== 'disconnected') return;
    switch (event.type) {
      case 'opened':
      case 'openFailed':
        this.#openAnswered(entry, event);
        return;
      case 'disconnected': {
        if (entry.connection !== connection) return;
        const attachCut = entry.attachCut;
        entry.attachCut = false;
        this.#lost(entry);
        switch (event.code) {
          case HOST_PROTOCOL.websocket.closeRevoked:
            // The Dispatcher revoked this device, which closes everything it carried.
            void this.#revoked();
            return;
          case HOST_PROTOCOL.websocket.closeUnauthenticated:
            this.#halt(entry, 'disconnected', `The Host closed the connection: ${event.reason || "this device isn't authenticated"}.`);
            return;
          case HOST_PROTOCOL.websocket.closeBehind:
            // Fell behind: catch up after the position, at once, unless an attach fell behind
            // before its answer came, whose position didn't move: then trying again at once
            // would ask for the same replay, so back off.
            entry.status = 'reconnecting';
            if (attachCut) this.#away(entry);
            else void this.#connect(entry);
            return;
          default:
            // A dropped network, a Host restart, or the Dispatcher's: the Dispatcher says
            // whether it still reaches the Host, backing off.
            entry.status = 'reconnecting';
            this.#away(entry);
            return;
        }
      }
      case 'notification':
        switch (event.method) {
          case 'thread/event':
            this.#journalEvent(entry, event.params);
            return;
          case 'thread/changed': {
            const { threadId, activity, clients, title, blank, mcpServers } = event.params;
            const followed = this.#followed.get(threadKey(entry.hostId, threadId));
            if (followed?.state) {
              followed.state = {
                ...followed.state,
                ...(activity ? { activity } : {}),
                ...(clients !== undefined && clients !== null ? { clients } : {}),
                ...(title ? { title } : {}),
                ...(blank !== undefined && blank !== null ? { blank } : {}),
                ...(mcpServers ? { mcpServers } : {}),
              };
            }
            const listing = entry.threads.find(({ info }) => info.sessionId === threadId);
            if (listing) {
              if (activity) listing.activity = activity;
              if (clients !== undefined && clients !== null) listing.clients = clients;
              if (title) listing.info = { ...listing.info, title };
              listing.lastActivityAt = Date.now();
            } else if (followed?.state && !followed.state.blank && !connection.supports(HOST_PROTOCOL.features.watch)) {
              // A new thread's first prompt lists it; a watched list hears of it anyway.
              void this.#list(entry);
            }
            this.#read.observe(threadKey(entry.hostId, threadId), activity ?? listing?.activity ?? undefined);
            this.#changed();
            return;
          }
          case 'threads/updated':
            this.#listed(entry, event.params.thread);
            return;
          case 'threads/removed': {
            const { threadId } = event.params;
            entry.threads = entry.threads.filter(({ info }) => info.sessionId !== threadId);
            this.#changed();
            return;
          }
          case 'pending/added': {
            const followed = this.#followed.get(threadKey(entry.hostId, event.params.threadId));
            if (followed) this.#pendingAdded(followed, connection, event.params.pending);
            return;
          }
          case 'pending/resolved': {
            const followed = this.#followed.get(threadKey(entry.hostId, event.params.threadId));
            if (followed) this.#pendingResolved(followed, connection, event.params);
            return;
          }
          case 'thread/elicitationCompleted': {
            const followed = this.#followed.get(threadKey(entry.hostId, event.params.threadId));
            if (followed) this.#apply(followed, [{ type: 'elicitation/completed', notification: event.params.notification }]);
            return;
          }
          case 'terminals/updated':
            this.#terminalUpdated(entry.hostId, event.params.terminal);
            return;
          case 'terminals/removed': {
            const { id, scope } = event.params;
            const shown = this.#session;
            if (shown?.hostId === entry.hostId && shown.terminals?.scope === scope) {
              shown.terminals = { scope, list: shown.terminals.list.filter((terminal) => terminal.id !== id) };
              this.#changed();
            }
            return;
          }
          case 'sessions/updated':
            this.#sessions.updated(entry.hostId, event.params.session);
            return;
          case 'sessions/ended':
            this.#sessions.ended(entry.hostId, event.params.directory);
            return;
          case 'agents/updateAvailable': {
            const { threadId, agentId, name, running, latest } = event.params;
            const followed = this.#followed.get(threadKey(entry.hostId, threadId));
            if (!followed) return;
            followed.update = { agentId, name, running, latest };
            this.#changed();
            // The Host tells open threads again once the agent is updated on it: what its new
            // threads launch may have changed.
            void this.#loadAgents(entry);
            return;
          }
          default:
            return;
        }
    }
  }

  #journalEvent(entry: HostEntry, notification: ThreadEventNotification) {
    const followed = this.#followed.get(threadKey(entry.hostId, notification.threadId));
    if (!followed || !followed.follower.accept(notification)) return;
    const history = followed.follower.isHistory(notification);
    const { event } = notification;
    if ((event.kind === 'turnStarted' || event.kind === 'turnSteered') && 'client' in event.origin) {
      followed.clients.set(event.origin.client.id, originLabel(event.origin));
    }
    this.#apply(followed, transcriptEvents(notification, { history, own: (origin) => this.#own(entry, origin) }), notification.at);
    if (followed.loading && !followed.follower.replaying) followed.loading = false;
    // What waits shows once the history before it has.
    if (!followed.pendingShown && !followed.follower.replaying) this.#showPending(followed);
    if (history) return;
    // The Host's queue, which a thread's state gave up to the journal's head.
    if (event.kind === 'queued') {
      followed.held.push(this.#heldPrompt(entry, { id: event.queuedId, prompt: event.prompt, origin: event.origin, queuedAt: notification.at }));
      this.#changed();
    } else if (event.kind === 'unqueued' || (event.kind === 'turnStarted' && event.queuedId)) {
      const id = event.queuedId;
      followed.held = followed.held.filter((prompt) => prompt.id !== id);
      if (followed.held.length === 0) followed.queuePaused = false;
      this.#changed();
    } else if (event.kind === 'queuePaused' || event.kind === 'queueResumed') {
      followed.queuePaused = event.kind === 'queuePaused';
      this.#changed();
    }
    if (event.kind === 'agentReopened') {
      // The new process says what prompts may carry now, and whether it steers.
      if (followed.state) followed.state = { ...followed.state, agent: event.agent };
      const version = event.agent.release?.version;
      if (followed.update && version) {
        followed.update = version === followed.update.latest ? undefined : { ...followed.update, running: version };
      }
    } else if (event.kind === 'turnEnded' && event.threadId === notification.threadId) {
      void this.#sendQueued(followed);
    }
  }

  /** A prompt in the Host's queue, as the composer shows it. */
  #heldPrompt(entry: HostEntry | undefined, queued: HostQueuedPrompt): QueuedPrompt {
    const text = queued.prompt.flatMap((block) => block.type === 'text' ? [block.text] : []).join(' ');
    const images = queued.prompt.flatMap((block) => block.type === 'image' ? [{ mimeType: block.mimeType, data: block.data }] : []);
    const own = entry ? this.#own(entry, queued.origin) : false;
    return {
      id: queued.id,
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(own ? {} : { origin: originLabel(queued.origin) }),
    };
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

  /** The connection to a followed thread's Host, or why there isn't one. */
  #connection(followed: Followed): HostConnection {
    const entry = this.#hosts.get(followed.hostId);
    const connection = entry?.connection;
    if (!connection || connection.closed) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    return connection;
  }

  /** Shows one thread alone, in front, attaching to it again if it was. */
  #select(key?: string) {
    this.#show(key ? [key] : [], key, true);
  }

  /**
   * The threads on screen from now on, and the one in front. Those no longer on screen are left,
   * and the new ones attached. `exactly`: these and no other, the one in front attached again;
   * otherwise a thread this device just started stays until a layout has shown it once.
   */
  #show(keys: string[], front: string | undefined, exactly: boolean) {
    const wanted = new Set(keys);
    if (front) wanted.add(front);
    for (const key of this.#fresh) {
      if (exactly || wanted.has(key)) this.#fresh.delete(key);
      else wanted.add(key);
    }
    const before = this.#shown;
    const same = wanted.size === before.size && [...wanted].every((key) => before.has(key));
    if (same && front === this.#selectedKey && !exactly) return;
    this.#shown = wanted;
    for (const key of before) {
      const followed = wanted.has(key) ? undefined : this.#followed.get(key);
      if (followed) this.#leave(followed);
    }
    this.#selectedKey = front;
    this.#read.focus(front);
    this.#error = undefined;
    for (const key of wanted) {
      const again = exactly && key === front;
      if (before.has(key) && !again) continue;
      const [hostId, ...rest] = key.split('/');
      let followed = this.#followed.get(key);
      if (!followed) {
        followed = this.#follow(hostId, rest.join('/'));
        this.#followed.set(key, followed);
      }
      this.#attach(followed);
    }
    this.#changed();
  }

  #follow(hostId: string, threadId: string): Followed {
    return {
      hostId,
      threadId,
      follower: new JournalFollower(),
      transcript: createTranscript(threadId),
      held: [],
      queuePaused: false,
      queued: [],
      steering: [],
      updating: false,
      reopening: false,
      pending: [],
      pendingShown: false,
      loading: false,
      clients: new Map(),
    };
  }

  /** Stops receiving a thread. One nobody has prompted closes, as the TUI leaves it. */
  #leave(followed: Followed) {
    const connection = this.#hosts.get(followed.hostId)?.connection;
    const blank = followed.state?.blank ?? false;
    void connection?.request('thread/detach', { threadId: followed.threadId, close: blank ? 'ifUnused' : 'never' }).catch(() => {});
    if (blank) this.#followed.delete(threadKey(followed.hostId, followed.threadId));
  }

  #attach(followed: Followed) {
    const entry = this.#hosts.get(followed.hostId);
    const connection = entry?.connection;
    if (!entry || !connection) return;
    const listing = entry.threads.find(({ info }) => info.sessionId === followed.threadId);
    followed.tag = this.#nextTag++;
    connection.open({
      attach: {
        threadId: followed.threadId,
        ...(followed.follower.position ? { after: followed.follower.position } : {}),
        // A thread the Host has no record of is named by its agent and directory.
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
      creating.resolve(this.#created(entry, event.thread));
      return;
    }
    const followed = [...this.#followed.values()].find(({ hostId, tag }) => hostId === entry.hostId && tag === event.tag);
    if (!followed) return;
    followed.tag = undefined;
    if (event.type === 'openFailed' && failedWith(event.error, CONNECTION_CLOSED)) {
      // Reconnecting attaches again; the connection's state says it ended.
      entry.attachCut = true;
      return;
    }
    if (event.type === 'openFailed') {
      const agentId = entry.threads.find(({ info }) => info.sessionId === followed.threadId)?.agentId;
      this.#error = `Couldn't open the thread: ${this.#explain(event.error, entry, agentId).message}`;
      this.#changed();
      return;
    }
    this.#opened(followed, event.thread);
  }

  #opened(followed: Followed, thread: OpenedThread) {
    const { reset } = followed.follower.opened(thread);
    const { state } = thread;
    const base = reset ? createTranscript(state.threadId) : followed.transcript;
    // A thread on screen that catches up after a reconnect keeps showing; one that opens, or
    // whose opening replay a reconnect cut short, waits for its history.
    followed.loading = followed.follower.replaying && (followed.loading || base.entries.length === 0);
    const events: AcpTranscriptEvent[] = [{ type: 'thread/loaded', modes: state.modes, configOptions: state.configOptions }];
    // Replayed history changes no turn state: what runs now is the thread's.
    const running = (state.turns ?? []).some(({ threadId }) => threadId === state.threadId);
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
    const entry = this.#hosts.get(followed.hostId);
    followed.held = (state.queue ?? []).map((queued) => this.#heldPrompt(entry, queued));
    followed.queuePaused = Boolean(state.queuePaused) && followed.held.length > 0;
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

  /** Shows a Session: its directory's terminals are listed and kept up to date while it's on screen. */
  #selectSession(key?: string) {
    const previous = this.#session;
    const next = key ? sessionOfKey(key) : undefined;
    if (previous && next && previous.hostId === next.hostId && previous.directory === next.directory) return;
    if (previous?.terminals) {
      void this.#hosts.get(previous.hostId)?.connection?.request('terminals/unwatch', { scope: previous.terminals.scope }).catch(() => {});
    }
    this.#session = next ? { ...next } : undefined;
    if (this.#session) void this.#watchTerminals(this.#session);
    this.#changed();
  }

  /**
   * Ends a Session for good: its Host closes its threads, ends its terminals and forgets it, and
   * tells every device (`sessions/ended`).
   */
  async #endSession(key: string) {
    const { hostId, directory } = sessionOfKey(key);
    const connection = this.#requestable(hostId);
    try {
      await connection.request('sessions/end', { directory });
    } catch (error) {
      if (failedWith(error, HOST_PROTOCOL.errors.sessionBusy)) throw new Error(busyWorktree(error));
      throw failed("Couldn't end the Session", error);
    }
    // Before the Host's own word of it arrives: it's gone here too.
    this.#sessions.ended(hostId, directory);
    if (this.#session?.hostId === hostId && this.#session.directory === directory) this.#selectSession(undefined);
  }

  #updateLayout(key: string, change: LayoutChange) {
    const { hostId, directory } = sessionOfKey(key);
    this.#sessions.update(hostId, directory, change);
  }

  /** Lists the Session on screen's terminals, and keeps the list up to date while it's there. */
  async #watchTerminals(shown: ShownSession) {
    const connection = this.#hosts.get(shown.hostId)?.connection;
    if (!connection || !connection.supports(HOST_PROTOCOL.features.terminals)) return;
    try {
      const { scope, terminals } = await connection.request('terminals/watch', { directory: shown.directory });
      if (this.#session !== shown || this.#hosts.get(shown.hostId)?.connection !== connection) {
        // Unless the Session on screen now is of the same scope, and watches it too.
        if (this.#session?.hostId !== shown.hostId || this.#session.terminals?.scope !== scope) {
          void connection.request('terminals/unwatch', { scope }).catch(() => {});
        }
        return;
      }
      shown.terminals = { scope, list: terminals };
      this.#changed();
    } catch {
      // The Session shows without its terminals.
    }
  }

  #terminalUpdated(hostId: string, terminal: HostTerminal) {
    const shown = this.#session;
    if (!shown || shown.hostId !== hostId) return;
    // One this device just started, before the list answered, starts the list.
    if (shown.terminals && shown.terminals.scope !== terminal.scope) return;
    const list = shown.terminals?.list ?? [];
    const index = list.findIndex(({ id }) => id === terminal.id);
    shown.terminals = {
      scope: terminal.scope,
      list: index === -1 ? [...list, terminal] : list.map((current, at) => at === index ? terminal : current),
    };
    this.#changed();
  }

  /** The Session on screen and its Host's connection, for a request about its terminals, or why there's none. */
  #sessionHost(): { shown: ShownSession; connection: HostConnection } {
    const shown = this.#session;
    if (!shown) throw new Error('No Session is open.');
    const entry = this.#hosts.get(shown.hostId);
    const connection = entry?.connection;
    if (!connection || connection.closed) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    return { shown, connection };
  }

  async #newTerminal(): Promise<string> {
    const { shown, connection } = this.#sessionHost();
    const front = this.#selected();
    try {
      const { terminal } = await connection.request('terminals/new', {
        directory: shown.directory,
        ...(front?.hostId === shown.hostId ? { openedFrom: front.threadId } : {}),
      });
      this.#terminalUpdated(shown.hostId, terminal);
      return terminal.id;
    } catch (error) {
      throw failed("Couldn't start a terminal", error);
    }
  }

  async #attachTerminal(id: string): Promise<TerminalTicket> {
    const { shown, connection } = this.#sessionHost();
    const { ticket } = await connection.request('terminals/attach', { id });
    const record = this.#dispatcher?.record;
    if (!record) throw new Error('This device isn\'t paired with the Dispatcher.');
    // The Dispatcher carries the stream too, as this device: its ticket is this device's.
    return {
      url: record.url,
      ticket,
      carry: { dispatcherId: record.dispatcherId, deviceId: record.deviceId, keyId: record.keyId, host: shown.hostId },
    };
  }

  /** Shows what waits in a thread, once its replay is done. */
  #showPending(followed: Followed) {
    followed.pendingShown = true;
    const connection = this.#hosts.get(followed.hostId)?.connection;
    this.#apply(followed, followed.pending.flatMap((pending) => this.#pendingEvents(followed, pending, connection)));
  }

  /** A pending request as the transcript shows it; a client tool call this device runs shows only as the agent's tool call. */
  #pendingEvents(followed: Followed, pending: PendingRequest, connection?: HostConnection): AcpTranscriptEvent[] {
    const threadId = pending.threadId ?? undefined;
    switch (pending.kind) {
      case 'permission':
        return [{ type: 'permission/requested', requestId: pending.id, request: pending.request, threadId }];
      case 'elicitation':
        return [{ type: 'elicitation/requested', requestId: pending.id, request: pending.request, threadId }];
      case 'clientTool':
        if (pending.target === connection?.clientId) return [];
        return [{ type: 'clientTool/requested', requestId: pending.id, tool: pending.tool, runner: followed.clients.get(pending.target) ?? 'another client', threadId }];
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
   * Answers a pending request of the thread on screen, showing the answer at once. Another
   * client's answer, the turn ending or the agent withdrawing it may have come first: the Host
   * says so with `pending/resolved`, which the card shows, and the answer isn't tried again.
   */
  async #answer(requestId: string, answer: Pick<AnswerPendingRequest, 'permission' | 'elicitation'>, shown: AcpTranscriptEvent, followed: Followed | undefined) {
    const pending = followed?.pending.find(({ id }) => id === requestId);
    // One no longer waiting says why already.
    if (!followed || !pending) return;
    this.#error = undefined;
    this.#apply(followed, [shown]);
    try {
      await this.#connection(followed).request('pending/answer', { threadId: followed.threadId, pendingId: requestId, ...answer });
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
        await connection.request('pending/answer', { threadId: followed.threadId, pendingId: pending.id, clientTool: result });
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

  /** Applies events to a followed thread's transcript; a journal event's `at` dates the entries it touches. */
  #apply(followed: Followed, events: AcpTranscriptEvent[], at?: number) {
    if (events.length === 0) return;
    followed.transcript = events.reduce(
      (transcript, event) => at === undefined ? reduceAcpEvent(transcript, event) : reduceJournalEvent(transcript, event, at),
      followed.transcript,
    );
    this.#changed();
  }

  async #listDirectory({ hostId, path, hidden }: { hostId: string; path?: string; hidden?: boolean }): Promise<DirectoryListing> {
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
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

  /** A Host's connection for a request the person waits on, or why there's none. */
  #requestable(hostId: string): HostConnection {
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    return connection;
  }

  async #listWorktrees({ hostId, path }: { hostId: string; path: string }): Promise<RepositoryListing | undefined> {
    const connection = this.#requestable(hostId);
    try {
      const listed = await connection.request('worktrees/list', { repo: path });
      return {
        repo: listed.repo,
        ...(listed.defaultBranch ? { defaultBranch: listed.defaultBranch } : {}),
        worktrees: listed.worktrees.map((worktree) => ({
          path: worktree.path,
          ...(worktree.branch ? { branch: worktree.branch } : {}),
          primary: worktree.primary ?? false,
          changes: worktree.changes ?? false,
          threads: worktree.threads ?? [],
        })),
      };
    } catch (error) {
      if (failedWith(error, HOST_PROTOCOL.errors.notARepository)) return undefined;
      throw failed("Couldn't list the repository's worktrees", error);
    }
  }

  async #createWorktree({ hostId, repo, branch, base }: { hostId: string; repo: string; branch: string; base?: string }): Promise<string> {
    const connection = this.#requestable(hostId);
    try {
      const created = await connection.request('worktrees/create', { repo, branch, ...(base ? { base } : {}) });
      return created.path;
    } catch (error) {
      throw failed("Couldn't make the worktree", error);
    }
  }

  async #removeWorktree({ hostId, path, force }: { hostId: string; path: string; force?: boolean }): Promise<WorktreeRemoval> {
    const connection = this.#requestable(hostId);
    try {
      const removed = await connection.request('worktrees/remove', { path, ...(force ? { force } : {}) });
      return { outcome: 'removed', ...(removed.branch ? { branch: removed.branch } : {}), branchDeleted: removed.branchDeleted ?? false };
    } catch (error) {
      if (failedWith(error, HOST_PROTOCOL.errors.uncommittedChanges)) return { outcome: 'hasChanges' };
      if (failedWith(error, HOST_PROTOCOL.errors.worktreeBusy)) throw new Error(busyWorktree(error));
      throw failed("Couldn't remove the worktree", error);
    }
  }

  /** Starts a thread and opens it; it rejects saying why the Host couldn't. */
  #create(input: { hostId: string; cwd: string; agentId: string }): Promise<CreatedThread> {
    const entry = this.#hosts.get(input.hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) {
      return Promise.reject(new Error(`${entry?.name ?? 'The Host'} isn't connected.`));
    }
    const tag = this.#nextTag++;
    return new Promise((resolve, reject) => {
      this.#creating.set(tag, { hostId: input.hostId, agentId: input.agentId, resolve, reject });
      connection.open({ create: { agentId: input.agentId, cwd: input.cwd } }, tag);
    });
  }

  #created(entry: HostEntry, thread: OpenedThread): CreatedThread {
    const key = threadKey(entry.hostId, thread.state.threadId);
    const followed = this.#follow(entry.hostId, thread.state.threadId);
    this.#followed.set(key, followed);
    // On screen from now, beside the others: the layout it's placed in says which stay.
    this.#shown.add(key);
    this.#fresh.add(key);
    this.#selectedKey = key;
    this.#read.focus(key);
    this.#error = undefined;
    this.#opened(followed, thread);
    const { cwd, git } = thread.state;
    return { key, sessionKey: sessionKey(entry.hostId, git?.worktree ?? cwd) };
  }

  async #send(text: string, images: PromptImage[] = [], followed: Followed | undefined) {
    this.#error = undefined;
    if (!followed) return;
    const prompt: QueuedPrompt = { id: `prompt-${this.#nextLocal++}`, text, ...(images.length > 0 ? { images } : {}) };
    try {
      const connection = this.#connection(followed);
      if (followed.transcript.turn.status === 'running') {
        if (!this.#canSteer(followed, connection)) {
          await this.#enqueue(followed, connection, prompt);
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
      const answer = await connection.request('turn/steer', { threadId: followed.threadId, prompt: promptBlocks(prompt.text, prompt.images) });
      // A steer the agent took shows where it joined the turn, from the journal.
      return answer.outcome === 'steered';
    } finally {
      followed.steering = followed.steering.filter(({ id }) => id !== prompt.id);
      this.#changed();
    }
  }

  /** Starts a turn with the prompt, shown at once; one already running (another client's) queues it. */
  async #start(followed: Followed, connection: HostConnection, prompt: QueuedPrompt) {
    const localId = `${followed.threadId}:local:${prompt.id}`;
    const blocks = promptBlocks(prompt.text, prompt.images);
    const before = followed.transcript.turn;
    followed.transcript = reduceAcpEvent(queueOptimisticPrompt(followed.transcript, localId, blocks), { type: 'turn/started' });
    this.#changed();
    try {
      await connection.request('turn/start', { threadId: followed.threadId, prompt: blocks });
    } catch (error) {
      const entries = followed.transcript.entries.filter(({ id }) => id !== localId);
      if (error instanceof HostError && error.code === HOST_PROTOCOL.errors.turnRunning) {
        followed.transcript = { ...followed.transcript, entries, turn: { status: 'running' } };
        this.#changed();
        await this.#enqueue(followed, connection, prompt, true);
        return;
      }
      followed.transcript = { ...followed.transcript, entries, turn: before };
      this.#changed();
      throw error;
    }
  }

  /**
   * Queues a message for after the running turn: in the Host's queue, where every client sees it
   * and the Host starts it, or here for a Host without one, `first` putting it at the front.
   */
  async #enqueue(followed: Followed, connection: HostConnection, prompt: QueuedPrompt, first = false) {
    if (connection.supports(HOST_PROTOCOL.features.queue)) {
      // It shows when the Host's `queued` event says so.
      await connection.request('queue/add', { threadId: followed.threadId, prompt: promptBlocks(prompt.text, prompt.images) });
      return;
    }
    if (first) followed.queued.unshift(prompt);
    else followed.queued.push(prompt);
    this.#changed();
  }

  /** Sends the next message queued here, once no turn runs. */
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

  /** A newer version is out; it's `available` once the Host's new threads launch another version than the thread runs. */
  #updateNotice(update: NonNullable<Followed['update']>, entry?: HostEntry): AgentUpdateNotice {
    const launches = entry?.agents.find(({ id }) => id === update.agentId)?.version;
    return launches && launches !== update.running ? { ...update, available: launches } : update;
  }

  /** Whether Send steers: the Host takes steers and the thread's agent advertises them. */
  #canSteer(followed: Followed, connection = this.#hosts.get(followed.hostId)?.connection): boolean {
    if (!connection?.supports(HOST_PROTOCOL.features.steer)) return false;
    return meta(followed.state?.agent.initialize, '_meta', 'steering', 'supported') === true;
  }

  async #reopen(followed: Followed | undefined) {
    if (!followed) return;
    const connection = this.#connection(followed);
    followed.reopening = true;
    this.#changed();
    try {
      await connection.request('thread/reopen', { threadId: followed.threadId });
    } finally {
      followed.reopening = false;
      this.#changed();
    }
  }

  /**
   * The Host takes the thread's agent to its newest version, then the thread moves there, unless
   * it runs that version already. The thread moves even if the person has gone to another.
   */
  async #updateAgent(followed: Followed | undefined) {
    const agentId = followed?.update?.agentId;
    if (!followed || !agentId) return;
    const connection = this.#connection(followed);
    followed.updating = true;
    this.#changed();
    let version: string;
    try {
      ({ version } = await connection.request('agents/update', { agentId }));
    } catch (error) {
      throw this.#explain(error, this.#hosts.get(followed.hostId), agentId);
    } finally {
      followed.updating = false;
    }
    if (version === followed.update?.running) {
      followed.update = undefined;
      this.#changed();
      return;
    }
    await this.#reopen(followed);
  }

  async #rename(key: string, title: string) {
    const [hostId, ...rest] = key.split('/');
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection || connection.closed) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    try {
      // The new title comes back to every client: in the journal, and as the thread's change.
      await connection.request('thread/rename', { threadId: rest.join('/'), title });
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
    if (!entry || !connection) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    await connection.request('thread/close', { threadId: rest.join('/') }).catch((error: unknown) => {
      throw failed("Couldn't close the thread", error);
    });
    if (followed) this.#followed.delete(key);
    this.#shown.delete(key);
    this.#fresh.delete(key);
    if (this.#selectedKey === key) this.#selectedKey = undefined;
    await this.#list(entry);
  }

  async #delete(key: string) {
    const [hostId, ...rest] = key.split('/');
    const threadId = rest.join('/');
    const entry = this.#hosts.get(hostId);
    const connection = entry?.connection;
    if (!entry || !connection) throw new Error(`${entry?.name ?? 'The Host'} isn't connected.`);
    const agentId = entry.threads.find(({ info }) => info.sessionId === threadId)?.agentId ?? this.#followed.get(key)?.state?.agent.id;
    await connection.request('thread/delete', { threadId, ...(agentId ? { agentId } : {}) }).catch((error: unknown) => {
      throw failed("Couldn't delete the thread", error);
    });
    this.#followed.delete(key);
    this.#shown.delete(key);
    this.#fresh.delete(key);
    this.#read.forget(key);
    if (this.#selectedKey === key) this.#selectedKey = undefined;
    entry.threads = entry.threads.filter(({ info }) => info.sessionId !== threadId);
    this.#changed();
    await this.#list(entry);
  }

  /** An error as the person should read it: an agent that needs signing in says how. */
  #explain(error: unknown, entry?: HostEntry, agentId?: string): Error {
    if (error instanceof HostError && error.code === AUTH_REQUIRED) {
      const agent = entry?.agents.find(({ id }) => id === agentId);
      const name = agent?.name ?? agentId ?? 'The agent';
      return new Error(`${name} needs signing in. Run \`weave agents login --agent ${agentId ?? '<agent>'}\` on the Host's computer, then try again.`);
    }
    if (error instanceof HostError && error.code === HOST_PROTOCOL.errors.forbidden) {
      return new Error(`${error.message}. That's done on the Host's computer.`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Pairs with the Dispatcher with a code `weave pair` showed, in place of any pairing
   * before, then lists its Hosts. The Hosts an earlier version paired with go.
   */
  async #pair(input: { url: string; code: string; name?: string }) {
    const url = websocketUrl(input.url);
    const { keyId, key } = await this.#options.newKey();
    let connection: DispatcherConnection | undefined;
    let adopted: DispatcherEntry | undefined;
    try {
      connection = await this.#routes.pair({
        url,
        code: input.code.replaceAll(/[\s-]/g, ''),
        name: input.name?.trim() || this.#options.deviceName,
        key,
        client: this.#options.client,
        onClosed: (close) => { if (adopted && connection) this.#dispatcherClosed(adopted, connection, close); },
      });
    } catch (error) {
      await key.forget().catch(() => {});
      throw error instanceof ConnectError ? new Error(error.message) : error;
    }
    const { id, device } = connection.hello;
    if (!id || !device) {
      connection.close();
      await key.forget().catch(() => {});
      throw new Error('The Dispatcher paired no device. Is it a weave Dispatcher?');
    }
    let name = new URL(url).hostname;
    try {
      name = (await connection.request('dispatcher/status', {})).name || name;
    } catch {
      // Its address names it well enough.
    }
    await this.#unpair();
    const record: DispatcherRecord = { dispatcherId: id, name, url, deviceId: device.id, keyId };
    await this.#options.storage.save(record);
    adopted = this.#adopt(record);
    this.#error = undefined;
    await this.#forgetOldHosts();
    if (this.#local) this.#adoptLocal();
    else await this.#findLocal();
    await this.#dispatcherConnected(adopted, connection);
  }

  /** Lets go of the Dispatcher, its Hosts and their threads, and deletes its key. */
  async #unpair() {
    const dispatcher = this.#dispatcher;
    if (!dispatcher) return;
    this.#letGo(dispatcher);
    for (const entry of this.#hosts.values()) this.#closeHost(entry);
    for (const hostId of this.#hosts.keys()) this.#sessions.forget(hostId);
    this.#hosts = new Map();
    this.#forgetShown();
    this.#dispatcher = undefined;
    // A revoked device's key went already.
    if (dispatcher.status !== 'revoked') await dispatcher.key.forget().catch(() => {});
  }

  /** Lets go of every thread and Session on screen, and the Projects, as the pairing goes. */
  #forgetShown() {
    this.#followed.clear();
    this.#shown = new Set();
    this.#fresh.clear();
    this.#selectedKey = undefined;
    this.#session = undefined;
    this.#projects = [];
  }

  /** Forgets the pairing: the Dispatcher lists this device until it's revoked there. */
  async #forget() {
    await this.#unpair();
    await this.#options.storage.save(undefined);
    this.#changed();
  }

  #openThread(key: string, followed: Followed): OpenThread {
    return {
      key,
      transcript: followed.transcript,
      canSteer: this.#canSteer(followed),
      queued: [...followed.steering, ...followed.held, ...followed.queued],
      ...(followed.queuePaused && followed.held.length > 0 ? { queuePaused: true } : {}),
      canAttachImages: followed.state?.agent.initialize.agentCapabilities?.promptCapabilities?.image === true,
      ...(followed.update ? { update: this.#updateNotice(followed.update, this.#hosts.get(followed.hostId)) } : {}),
      ...(followed.updating ? { updating: true } : {}),
      ...(followed.reopening ? { reopening: true } : {}),
      ...(followed.loading ? { loading: true } : {}),
      ...(this.#hosts.get(followed.hostId)?.connection?.supports(HOST_PROTOCOL.features.mcpServers)
        ? { mcpServers: followed.state?.mcpServers ?? [] }
        : {}),
    };
  }

  /**
   * The Session on screen, once its Host has listed its threads: before anyone arranged it, it
   * shows its open threads in one pane, the most recently active in front.
   */
  #openSession(): { session?: OpenSession } {
    const shown = this.#session;
    const entry = shown ? this.#hosts.get(shown.hostId) : undefined;
    if (!shown || !entry?.listedThreads) return {};
    const { hostId, directory } = shown;
    const { layout, saved } = this.#sessions.open(hostId, directory);
    return {
      session: {
        key: sessionKey(hostId, directory),
        hostId,
        directory,
        layout,
        saved,
        ...(shown.movedFrom ? { movedFrom: shown.movedFrom } : {}),
        ...(shown.terminals ? { terminals: shown.terminals.list.map(terminalSummary) } : {}),
      },
    };
  }

  #model(): AppModel {
    const hosts: HostSummary[] = [];
    const threads: ThreadSummary[] = [];
    const agents: Record<string, AgentChoice[]> = {};
    const selected = this.#selected();
    const dispatcher = this.#dispatcher;
    for (const entry of this.#hosts.values()) {
      const { hostId } = entry;
      hosts.push({
        id: hostId,
        name: entry.name,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.listFiles) ? { canBrowse: true } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.rename) ? { canRename: true } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.worktrees) ? { canWorktree: true } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.terminals) ? { canTerminals: true } : {}),
        ...(entry.connection?.supports(HOST_PROTOCOL.features.sessionsEnd) ? { canEndSessions: true } : {}),
      });
      agents[hostId] = entry.agents.map(({ id, name }) => ({ id, name }));
      const agentName = (agentId: string) => entry.agents.find(({ id }) => id === agentId)?.name ?? agentId;
      for (const listing of entry.threads) {
        threads.push({
          key: threadKey(hostId, listing.info.sessionId),
          hostId: hostId,
          threadId: listing.info.sessionId,
          ...(listing.info.title ? { title: listing.info.title } : {}),
          agentId: listing.agentId,
          agentName: agentName(listing.agentId),
          cwd: listing.info.cwd,
          ...(listing.git ? { git: threadGit(listing.git) } : {}),
          state: listing.state,
          ...(listing.activity ? { activity: listing.activity } : {}),
          clients: listing.clients ?? 0,
          headless: listing.headless ?? false,
          lastActivityAt: listing.lastActivityAt ?? (listing.info.updatedAt ? Date.parse(listing.info.updatedAt) : undefined),
          ...(listing.startedBy ? { startedBy: { key: threadKey(listing.startedByHost ?? hostId, listing.startedBy), label: '' } } : {}),
          ...(listing.continuedIn ? { continuedIn: { key: threadKey(hostId, listing.continuedIn), label: '' } } : {}),
        });
      }
      // Threads on screen the list doesn't have yet, such as a new one nobody has prompted.
      for (const key of this.#shown) {
        const state = key.startsWith(`${hostId}/`) ? this.#followed.get(key)?.state : undefined;
        if (!state || entry.threads.some(({ info }) => info.sessionId === state.threadId)) continue;
        threads.push({
          key: threadKey(hostId, state.threadId),
          hostId: hostId,
          threadId: state.threadId,
          ...(state.title ? { title: state.title } : {}),
          agentId: state.agent.id,
          agentName: state.agent.name,
          cwd: state.cwd,
          ...(state.git ? { git: threadGit(state.git) } : {}),
          state: 'open',
          activity: state.activity,
          clients: state.clients,
          headless: false,
          lastActivityAt: Date.now(),
        });
      }
    }
    labelStarters(threads, hosts);
    const open: Record<string, OpenThread> = {};
    for (const key of this.#shown) {
      const followed = this.#followed.get(key);
      if (followed) open[key] = this.#openThread(key, followed);
    }
    return {
      ...(this.#starting ? { starting: true } : {}),
      ...(dispatcher
        ? {
            dispatcher: {
              id: dispatcher.record.dispatcherId,
              name: dispatcher.record.name,
              url: dispatcher.record.url,
              status: dispatcher.status,
              ...(dispatcher.error ? { error: dispatcher.error } : {}),
            },
          }
        : {}),
      hosts,
      threads,
      agents,
      ...(this.#projects.length > 0 ? { projects: this.#projects } : {}),
      known: this.#sessions.known(),
      ...this.#openSession(),
      open,
      selectedKey: this.#selectedKey,
      thread: selected && this.#selectedKey ? open[this.#selectedKey] ?? this.#openThread(this.#selectedKey, selected) : undefined,
      unread: this.#read.unread(),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }
}

/**
 * Name the thread that started each delegated one: its title, and its Host when that's another,
 * as for a thread another Host's agent started through the Dispatcher (ADR 0029). The starter
 * may be on a Host the Dispatcher no longer lists, or gone, and is named as well as it can be
 * then. A thread's successor is named by its title too (WVE-168).
 */
export function labelStarters(threads: ThreadSummary[], hosts: readonly HostSummary[]) {
  const byKey = new Map(threads.map((thread) => [thread.key, thread]));
  for (const thread of threads) {
    if (thread.continuedIn) {
      const successor = byKey.get(thread.continuedIn.key);
      const label = successor?.title ? `“${successor.title}”` : 'another thread';
      thread.continuedIn = { key: thread.continuedIn.key, label };
    }
    if (!thread.startedBy) continue;
    const { key } = thread.startedBy;
    const hostId = key.slice(0, key.indexOf('/'));
    const starter = byKey.get(key);
    const starterName = starter?.title ? `“${starter.title}”` : 'another thread';
    const host = hostId === thread.hostId ? '' : ` on ${hosts.find(({ id }) => id === hostId)?.name ?? 'another Host'}`;
    thread.startedBy = { key, label: `from ${starterName}${host}` };
  }
}
