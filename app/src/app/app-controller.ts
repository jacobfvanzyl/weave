import type { CreateElicitationResponse, McpServerStatus, ProgramStatus } from '@/host/protocol';
import type { AcpTranscript } from '@/chat/acp-transcript';

/**
 * The connection to the Dispatcher's API, through which the app lists the person's Hosts and
 * reaches each (ADR 0030). `reconnecting` can't reach it now and keeps trying; `refused` (it
 * refused this device) and `revoked` (it revoked this device, which forgot the pairing) have to
 * pair again; `incompatible` shares no version of its API with this app.
 */
export type DispatcherStatus = 'connecting' | 'connected' | 'reconnecting' | 'refused' | 'revoked' | 'incompatible';

/** The Dispatcher this device is paired with: its only pairing. */
export type DispatcherSummary = {
  /** Its own id (`dispatcher/hello` `id`). */
  id: string;
  /** What it calls itself: its computer's name. */
  name: string;
  url: string;
  status: DispatcherStatus;
  error?: string;
};

/**
 * A Host's connection, which the Dispatcher carries. `unreachable` is a Host the Dispatcher
 * can't reach now, its error saying why, which comes back once the Dispatcher lists it
 * connected; `disconnected` isn't tried again until the person asks; `incompatible` shares no
 * protocol version with this app.
 */
export type HostStatus = 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'disconnected' | 'incompatible';

/** One of the person's Hosts, as the Dispatcher lists it. */
export type HostSummary = {
  /** The Host's own id (`host/hello` `host.id`). */
  id: string;
  /** What the Dispatcher calls it: its computer's name, as it joined. */
  name: string;
  status: HostStatus;
  /** Why it isn't connected. */
  error?: string;
  /** Whether it lists its directories (`files/list`), for picking where a thread runs. */
  canBrowse?: boolean;
  /** Whether it renames threads (`thread/rename`). */
  canRename?: boolean;
  /** Whether it lists, makes and removes git worktrees (`worktrees`). */
  canWorktree?: boolean;
  /** Whether it has terminals to show beside a thread (`terminals`). */
  canTerminals?: boolean;
};

/** Where in a git repository a thread's directory is. */
export type ThreadGit = {
  /** The repository, by its primary worktree. */
  repo: string;
  /** The worktree the directory is in: the primary one or another. */
  worktree: string;
  /** None when its HEAD is detached. */
  branch?: string;
};

/** One of a repository's worktrees, as `worktrees/list` gives it. */
export type WorktreeSummary = {
  path: string;
  /** None when its HEAD is detached. */
  branch?: string;
  /** The repository's own checkout, which can't be removed. */
  primary: boolean;
  /** Staged, unstaged or untracked changes. */
  changes: boolean;
  /** The ids of the threads the Host has in it. */
  threads: string[];
};

/** A git repository on a Host's computer and its worktrees. */
export type RepositoryListing = {
  /** Its primary worktree. */
  repo: string;
  /** The branch new worktrees start from unless told otherwise. */
  defaultBranch?: string;
  /** The primary worktree first. */
  worktrees: WorktreeSummary[];
};

/** What removing a worktree did: removed it, or left it because it has changes only `force` discards. */
export type WorktreeRemoval =
  | { outcome: 'removed'; branch?: string; branchDeleted: boolean }
  | { outcome: 'hasChanges' };

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

export type ThreadActivity = 'idle' | 'running' | 'waiting';

/** One row of the thread list: a thread on one of the person's Hosts. */
export type ThreadSummary = {
  /** Unique across Hosts: `${hostId}/${threadId}`. */
  key: string;
  hostId: string;
  threadId: string;
  title?: string;
  agentId: string;
  agentName: string;
  cwd: string;
  /** Where in a git repository `cwd` is; none outside one. */
  git?: ThreadGit;
  state: 'open' | 'suspended' | 'closed';
  /** Open threads only. */
  activity?: ThreadActivity;
  /** Clients attached now, this one included. */
  clients: number;
  headless: boolean;
  lastActivityAt?: number;
  /** What the thread waits on, for the banner, while its activity is `waiting`. */
  waitingOn?: string;
  /** The thread whose agent started it: its key, when this device lists it, and how to name it. */
  startedBy?: { key: string; label: string };
  /** The thread its work goes on in, its successor (WVE-168): its key, and how to name it. */
  continuedIn?: { key: string; label: string };
};

export type AgentChoice = { id: string; name: string };

/** A photo for a prompt, downscaled and base64-encoded. */
export type PromptImage = { mimeType: string; data: string; name?: string };

/**
 * A message waiting to go: queued behind the running turn, or with `steering` on its way into it.
 * `origin` names the client that queued it, when it isn't this device.
 */
export type QueuedPrompt = { id: string; text: string; images?: PromptImage[]; steering?: boolean; origin?: string };

/** A newer version of a thread's agent than the one it runs. */
export type AgentUpdateNotice = {
  agentId: string;
  /** What's updated, as people know it: the preset's package or the registry agent's name. */
  name: string;
  running: string;
  latest: string;
  /**
   * The version the Host's new threads of the agent launch, when it isn't the one this thread
   * runs: the agent was updated on the Host, and Move takes the thread there.
   */
  available?: string;
};

/**
 * A terminal on a Host's computer (ADR 0022). It belongs to a worktree, or to a directory outside
 * a repository, rather than to a thread, and lasts until its shell exits. `openedFrom`, `command`
 * and `programStatus` are weave's, which another owner (a Rex block) may not report.
 */
export type TerminalSummary = {
  id: string;
  /** The worktree it belongs to, or its directory outside a repository. */
  scope: string;
  /** The person's name for it. */
  label?: string;
  /** What the program titled it. */
  title?: string;
  /** The directory the shell last reported. */
  pwd?: string;
  /** The thread it was opened from, by id, which puts it in front by default. */
  openedFrom?: string;
  /** The foreground process: the shell, or the command it runs. */
  process?: string;
  size: { cols: number; rows: number };
  /** Whether a command runs, which, and how the last one ended. */
  command?: { running: boolean; command?: string; exitCode?: number };
  /** The program's status (OSC 7501), the root record first. */
  programStatus?: ProgramStatus[];
  startedAt: number;
};

/**
 * Where a terminal's stream is, and a ticket for it, good once and for a little while. The
 * Dispatcher carries the stream as it carries the Host's connection (ADR 0030): the native
 * terminal proves the device with the key `keyId` names and names the Host, then opens the stream
 * with the ticket, which is this device's.
 */
export type TerminalTicket = {
  /** The Dispatcher's WebSocket. */
  url: string;
  ticket: string;
  carry: { dispatcherId: string; deviceId: string; keyId: string; host: string };
};

/** The thread on screen. */
export type OpenThread = {
  key: string;
  transcript: AcpTranscript;
  /** Whether Send steers the running turn; otherwise it queues. */
  canSteer: boolean;
  queued: QueuedPrompt[];
  /**
   * The Host's queue waits rather than start the next turn: after a cancelled or failed turn, or
   * a Host restart. Sending a message, or `resumeQueue`, starts it again.
   */
  queuePaused?: boolean;
  /** Whether the agent takes images in prompts. */
  canAttachImages?: boolean;
  /** A newer version of its agent is out. */
  update?: AgentUpdateNotice;
  /** `updateAgent` is checking that the newest version starts, before the thread moves there. */
  updating?: boolean;
  /** `thread/reopen` is moving it to the version its agent's new threads launch. */
  reopening?: boolean;
  /** Its history is still replaying as it opens; the transcript shows once it's in. */
  loading?: boolean;
  /**
   * The terminals of its worktree, or of its directory outside one, kept up to date: a tab each,
   * in every thread of the worktree. None until its Host lists them, or on a Host without them.
   */
  terminals?: TerminalSummary[];
  /**
   * The MCP servers its agent was given, as the Host reports them (`mcpServers`): weave's own
   * first, then the Host's config's. None from a Host that doesn't report them.
   */
  mcpServers?: McpServerStatus[];
};

export type AppModel = {
  /** Loading the pairing, before anything is known. */
  starting?: boolean;
  /** None until this device pairs with the Dispatcher, which the app asks for first. */
  dispatcher?: DispatcherSummary;
  /** In the Dispatcher's order; the last it listed while it can't be reached. */
  hosts: HostSummary[];
  threads: ThreadSummary[];
  /** The agents each Host offers, by Host id. */
  agents: Record<string, AgentChoice[]>;
  selectedKey?: string;
  thread?: OpenThread;
  /** Threads whose turn ended since the person last looked at them, on this device. */
  unread: ReadonlySet<string>;
  error?: string;
};

export type AppActions = {
  /** Opens a thread, or with no key goes back to the list. */
  selectThread(key?: string): void;
  createThread(input: { hostId: string; cwd: string; agentId: string }): Promise<void> | void;
  /**
   * The directories in `path` on a Host's computer, or in its user's home without one; rejects
   * saying why the Host couldn't list it.
   */
  listDirectory(input: { hostId: string; path?: string; hidden?: boolean }): Promise<DirectoryListing>;
  /**
   * The repository `path` is in on a Host's computer, with its worktrees; none outside one. Rejects
   * saying why the Host couldn't list them.
   */
  listWorktrees(input: { hostId: string; path: string }): Promise<RepositoryListing | undefined>;
  /**
   * Makes a worktree of the repository `repo` is in, beside it, for `branch`: a new branch from
   * `base` (else the default branch) when it doesn't exist. Resolves to the worktree's path, for a
   * thread to start in; rejects saying why not.
   */
  createWorktree(input: { hostId: string; repo: string; branch: string; base?: string }): Promise<string>;
  /**
   * Removes a worktree other than the primary one, closing its threads, and its branch when that's
   * merged. Rejects saying why not, as when a thread in it runs a turn or waits on the person.
   */
  removeWorktree(input: { hostId: string; path: string; force?: boolean }): Promise<WorktreeRemoval>;
  closeThread(key: string): Promise<void> | void;
  /** Gives an open thread a title of the Host's, for every client; rejects saying why not. */
  renameThread(key: string, title: string): Promise<void> | void;
  deleteThread(key: string): Promise<void> | void;
  /**
   * Pairs with the Dispatcher at the URL and code `weave pair` shows, in place of any
   * pairing before; `name` is what the Dispatcher calls this device. Rejects saying why not.
   */
  pairDispatcher(input: { url: string; code: string; name?: string }): Promise<void> | void;
  /** Forgets the pairing and deletes its key; the Dispatcher lists the device until it's revoked there. */
  forgetDispatcher(): Promise<void> | void;
  /** Tries the Dispatcher again at once. */
  reconnectDispatcher(): Promise<void> | void;
  /** Lists the Hosts and their threads again, and reconnects at once to what dropped, as pulling the list down asks. */
  refresh?(): Promise<void> | void;
  reconnectHost(hostId: string): Promise<void> | void;
  /** Starts a turn, steers the running one, or queues the message, as `OpenThread` allows. */
  send(text: string, images?: PromptImage[]): Promise<void> | void;
  removeQueued(id: string): void;
  /** Starts the open thread's paused queue again (`queue/resume`). */
  resumeQueue(): Promise<void> | void;
  cancelTurn(): Promise<void> | void;
  /** Moves the open thread to the version its agent's new threads launch (`thread/reopen`). */
  reopenThread(): Promise<void> | void;
  /**
   * Updates the open thread's agent on its Host to the newest version (`agents/update`), then
   * moves the thread there, as the TUI's `/update` does.
   */
  updateAgent(): Promise<void> | void;
  /** Answers a pending request of the open thread, or one of its subagents'. */
  respondToPermission(requestId: string, optionId: string): Promise<void> | void;
  respondToElicitation(requestId: string, response: CreateElicitationResponse): Promise<void> | void;
  setMode(modeId: string): Promise<void> | void;
  setConfigOption(optionId: string, value: string | boolean): Promise<void> | void;
  /** Starts a terminal in the open thread's directory, opened from it; resolves to its id. */
  newTerminal(): Promise<string>;
  /** Hangs a terminal's program up, which ends it on every device. */
  closeTerminal(id: string): Promise<void>;
  /** Names a terminal on every device, or without a label clears its name. */
  renameTerminal(id: string, label?: string): Promise<void>;
  /** A ticket for a terminal of the open thread's Host, and where its stream is. */
  attachTerminal(id: string): Promise<TerminalTicket>;
};

export type AppController = { model: AppModel; actions: AppActions };

export const threadKey = (hostId: string, threadId: string) => `${hostId}/${threadId}`;
