import type { CreateElicitationResponse } from '@/host/protocol';
import type { AcpTranscript } from '@/chat/acp-transcript';

/**
 * A paired Host's connection. `disconnected` isn't tried again until the person asks, `revoked`
 * (the Host revoked this device, which forgot the pairing) has to pair again, and
 * `incompatible` shares no protocol version with this app.
 */
export type HostStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'revoked' | 'incompatible';

/** A Host this device has paired with. */
export type PairedHost = {
  /** The Host's own id (`host/hello` `host.id`). */
  id: string;
  /** The name the person confirmed when pairing: the URL's host name. */
  name: string;
  url: string;
  status: HostStatus;
  error?: string;
  /** Whether it lists its directories (`files/list`), for picking where a session runs. */
  canBrowse?: boolean;
  /** Whether it renames sessions (`session/rename`). */
  canRename?: boolean;
};

/** A directory on a Host's computer and the directories in it, as `files/list` gives them. */
export type DirectoryListing = {
  /** Absolute on the Host's computer. */
  path: string;
  /** None at the root. */
  parent?: string;
  /** The Host user's home directory, which paths under it show as `~`. */
  home: string;
  /** The names of the directories in it, in the Host's order. */
  directories: string[];
  /** The Host listed only so many of its entries. */
  truncated: boolean;
};

export type SessionActivity = 'idle' | 'running' | 'waiting';

/** One row of the session list: a session on one of the paired Hosts. */
export type SessionSummary = {
  /** Unique across Hosts: `${hostId}/${sessionId}`. */
  key: string;
  hostId: string;
  sessionId: string;
  title?: string;
  agentId: string;
  agentName: string;
  cwd: string;
  state: 'open' | 'suspended' | 'closed';
  /** Open sessions only. */
  activity?: SessionActivity;
  /** Clients attached now, this one included. */
  clients: number;
  headless: boolean;
  lastActivityAt?: number;
  /** What the session waits on, for the banner, while its activity is `waiting`. */
  waitingOn?: string;
};

export type AgentChoice = { id: string; name: string };

/** A photo for a prompt, downscaled and base64-encoded. */
export type PromptImage = { mimeType: string; data: string; name?: string };

/** A message waiting to go: queued behind the running turn, or with `steering` on its way into it. */
export type QueuedPrompt = { id: string; text: string; images?: PromptImage[]; steering?: boolean };

/** A newer version of a session's agent than the one it runs. */
export type AgentUpdateNotice = {
  agentId: string;
  /** What's updated, as people know it: the preset's package or the registry agent's name. */
  name: string;
  running: string;
  latest: string;
  /**
   * The version the Host's new sessions of the agent launch, when it isn't the one this session
   * runs: the agent was updated on the Host, and Move session takes the session there.
   */
  available?: string;
};

/** The session on screen. */
export type OpenSession = {
  key: string;
  transcript: AcpTranscript;
  /** Whether Send steers the running turn; otherwise it queues. */
  canSteer: boolean;
  queued: QueuedPrompt[];
  /** Whether the agent takes images in prompts. */
  canAttachImages?: boolean;
  /** A newer version of its agent is out; it is updated on the Host's computer. */
  update?: AgentUpdateNotice;
  /** `session/reopen` is moving it to the version its agent's new sessions launch. */
  reopening?: boolean;
};

export type AppModel = {
  hosts: PairedHost[];
  sessions: SessionSummary[];
  /** The agents each Host offers, by Host id. */
  agents: Record<string, AgentChoice[]>;
  selectedKey?: string;
  session?: OpenSession;
  /** Sessions whose turn ended since the person last looked at them, on this device. */
  unread: ReadonlySet<string>;
  error?: string;
};

export type AppActions = {
  /** Opens a session, or with no key goes back to the list. */
  selectSession(key?: string): void;
  createSession(input: { hostId: string; cwd: string; agentId: string }): Promise<void> | void;
  /**
   * The directories in `path` on a Host's computer, or in its user's home without one; rejects
   * saying why the Host couldn't list it.
   */
  listDirectory(input: { hostId: string; path?: string; hidden?: boolean }): Promise<DirectoryListing>;
  closeSession(key: string): Promise<void> | void;
  /** Gives an open session a title of the Host's, for every client; rejects saying why not. */
  renameSession(key: string, title: string): Promise<void> | void;
  deleteSession(key: string): Promise<void> | void;
  /** Pairs with the URL and code `weave pair` shows; `name` is what the Host calls this device. */
  pairHost(input: { url: string; code: string; name?: string }): Promise<void> | void;
  forgetHost(hostId: string): Promise<void> | void;
  /** Lists the sessions again, and reconnects at once to Hosts that dropped, as pulling the list down asks. */
  refresh?(): Promise<void> | void;
  reconnectHost(hostId: string): Promise<void> | void;
  /** Starts a turn, steers the running one, or queues the message, as `OpenSession` allows. */
  send(text: string, images?: PromptImage[]): Promise<void> | void;
  removeQueued(id: string): void;
  cancelTurn(): Promise<void> | void;
  /** Moves the open session to the version its agent's new sessions launch (`session/reopen`). */
  reopenSession(): Promise<void> | void;
  /** Answers a pending request of the open session, or one of its subagents'. */
  respondToPermission(requestId: string, optionId: string): Promise<void> | void;
  respondToElicitation(requestId: string, response: CreateElicitationResponse): Promise<void> | void;
  setMode(modeId: string): Promise<void> | void;
  setConfigOption(optionId: string, value: string | boolean): Promise<void> | void;
};

export type AppController = { model: AppModel; actions: AppActions };

export const sessionKey = (hostId: string, sessionId: string) => `${hostId}/${sessionId}`;
