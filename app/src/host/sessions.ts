// The Sessions the Hosts keep (ADR 0031, WVE-202), for the store: each Host's list, kept up to
// date (`sessions/watch`), and the layouts this device shows and changes. A change is made here
// at once and saved to the Host under the revision it was made on (`sessions/set` with
// `ifRevision`); when another device saved first, the change is made again on what that one
// saved, so neither loses the other's. A Session its Host keeps no layout for shows an empty
// tab: nothing is placed for the person. What's in a Session is its Host's to say too
// (`sessions/add`): the threads and terminals Blocks were given, not all its directory holds.
import type { KnownSession, LayoutChange } from '@/app/app-controller';
import { sessionKey } from '@/app/app-controller';
import { emptyLayout, tidy } from '@/session/layout';
import { CONNECTION_CLOSED, type HostConnection, HostError } from './connection';
import { HOST_PROTOCOL, type HostSession, type SessionLayout } from './protocol';

/** How many times a change is made again on a newer revision before it's given up. */
const TRIES = 6;

type Kept = {
  hostId: string;
  directory: string;
  /** As the Host last said, when it has a Session there. */
  session?: HostSession;
  /** The Host's layout as the app keeps one; none while the Host keeps none. */
  saved?: SessionLayout;
  /** What it shows on a Host that keeps no Sessions: this device's alone. */
  draft?: SessionLayout;
  /** What it shows before any layout: an empty tab. */
  blank?: SessionLayout;
  /** What its Host was asked to count as its own, or wouldn't: not asked again. */
  asked: Set<string>;
  /** Changes not saved yet, the oldest first. */
  changes: LayoutChange[];
  /** What it shows: its saved layout or draft, with the changes on top. */
  shown?: SessionLayout;
  writing: boolean;
};

export type SessionsDeps = {
  /** The Host's connection, while it's connected. */
  connection(hostId: string): HostConnection | undefined;
  /** Something a Session shows changed. */
  changed(): void;
  /** A change couldn't be saved. */
  failed(message: string): void;
  /** A Session's Host calls its directory something else: what was `from` is `to`. */
  moved(from: string, to: string): void;
};

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const same = (left: SessionLayout, right: SessionLayout) => JSON.stringify(left) === JSON.stringify(right);

export class HostSessions {
  readonly #deps: SessionsDeps;
  readonly #kept = new Map<string, Kept>();

  constructor(deps: SessionsDeps) {
    this.#deps = deps;
  }

  /**
   * Lists a Host's Sessions and keeps the list up to date, once it's connected; a Host from
   * before Sessions keeps none. Changes that waited for it are saved.
   */
  async watch(hostId: string, connection: HostConnection) {
    if (!connection.supports(HOST_PROTOCOL.features.sessions)) return;
    let sessions: HostSession[];
    try {
      sessions = (await connection.request('sessions/watch', {})).sessions ?? [];
    } catch {
      // It lists none until it answers, as when it reconnects.
      return;
    }
    if (this.#deps.connection(hostId) !== connection) return;
    const listed = new Set(sessions.map(({ directory }) => sessionKey(hostId, directory)));
    for (const [key, kept] of this.#kept) {
      // One it no longer has ended while this device was away.
      if (kept.hostId === hostId && kept.session && !listed.has(key)) this.#end(key, kept);
    }
    for (const session of sessions) this.#took(hostId, session);
    this.#deps.changed();
    for (const kept of this.#kept.values()) if (kept.hostId === hostId && kept.changes.length > 0) void this.#save(kept);
  }

  /** `sessions/updated`: a Session was made, or its layout changed, on any device. */
  updated(hostId: string, session: HostSession) {
    this.#took(hostId, session);
    this.#deps.changed();
  }

  /** `sessions/ended`: its worktree went, or a client ended it. */
  ended(hostId: string, directory: string) {
    const key = sessionKey(hostId, directory);
    const kept = this.#kept.get(key);
    if (!kept) return;
    this.#end(key, kept);
    this.#deps.changed();
  }

  /** Forgets a Host's Sessions, as when the Dispatcher no longer lists it. */
  forget(hostId: string) {
    for (const [key, kept] of this.#kept) if (kept.hostId === hostId) this.#kept.delete(key);
  }

  /** The Sessions the Hosts list. */
  known(): KnownSession[] {
    return [...this.#kept.values()].flatMap(({ hostId, session }) => session
      ? [{
          hostId,
          directory: session.directory,
          ...(session.git ? { git: { repo: session.git.repo, ...(session.git.branch ? { branch: session.git.branch } : {}) } } : {}),
          threads: session.threads ?? [],
          terminals: session.terminals ?? [],
          ...(this.#deps.connection(hostId)?.supports(HOST_PROTOCOL.features.sessionsAdd) ? { keepsOwn: true } : {}),
          ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
        }]
      : []);
  }

  /**
   * What the Session shows, whether its Host keeps it, and what its Host counts as its own: none
   * on a Host from before it kept that, where everything in the directory is the Session's.
   */
  open(hostId: string, directory: string): { layout: SessionLayout; saved: boolean; own?: { threads: string[]; terminals: string[] } } {
    const kept = this.#entry(hostId, directory);
    const keeps = this.#deps.connection(hostId)?.supports(HOST_PROTOCOL.features.sessionsAdd);
    return {
      layout: this.#shown(kept),
      saved: kept.saved !== undefined && kept.changes.length === 0,
      ...(keeps ? { own: { threads: kept.session?.threads ?? [], terminals: kept.session?.terminals ?? [] } } : {}),
    };
  }

  /**
   * Has the Session's Host count `threads` and `terminals` as the Session's, which a Block shows:
   * one at a time, since one that's gone would fail the rest, and each asked once.
   */
  add(hostId: string, directory: string, added: { threads: string[]; terminals: string[] }) {
    const kept = this.#entry(hostId, directory);
    const connection = this.#deps.connection(hostId);
    if (!connection || connection.closed || !connection.supports(HOST_PROTOCOL.features.sessionsAdd)) return;
    const ask = async (name: string, params: { threads?: string[]; terminals?: string[] }) => {
      if (kept.asked.has(name)) return;
      kept.asked.add(name);
      try {
        const { session } = await connection.request('sessions/add', { directory: kept.directory, ...params });
        this.#saved(this.#kept.get(sessionKey(hostId, kept.directory)) ?? kept, session);
        this.#deps.changed();
      } catch (error) {
        // Away: asked again once it's back. One the Host turns down, as a thread that's gone, stays asked.
        if (error instanceof HostError && error.code === CONNECTION_CLOSED) kept.asked.delete(name);
      }
    };
    for (const id of added.threads) void ask(`thread ${id}`, { threads: [id] });
    for (const id of added.terminals) void ask(`terminal ${id}`, { terminals: [id] });
  }

  /** Makes `change` to the Session's layout, here at once and on its Host for every device. */
  update(hostId: string, directory: string, change: LayoutChange) {
    const kept = this.#entry(hostId, directory);
    const before = this.#shown(kept);
    const after = tidy(change(before));
    if (same(before, after)) return;
    kept.changes.push(change);
    kept.shown = after;
    this.#deps.changed();
    void this.#save(kept);
  }

  #entry(hostId: string, directory: string): Kept {
    const key = sessionKey(hostId, directory);
    let kept = this.#kept.get(key);
    if (!kept) {
      kept = { hostId, directory, changes: [], writing: false, asked: new Set() };
      this.#kept.set(key, kept);
    }
    return kept;
  }

  #base(kept: Kept): SessionLayout {
    return kept.saved ?? kept.draft ?? (kept.blank ??= emptyLayout());
  }

  #shown(kept: Kept): SessionLayout {
    const base = this.#base(kept);
    kept.shown ??= kept.changes.reduce((layout, change) => tidy(change(layout)), base);
    return kept.shown;
  }

  /** What the Host says of a Session, unless it's older than what's known. */
  #took(hostId: string, session: HostSession) {
    const kept = this.#entry(hostId, session.directory);
    if (kept.session && session.revision < kept.session.revision) return;
    const moved = !kept.session || session.revision !== kept.session.revision;
    kept.session = session;
    if (!moved) return;
    kept.saved = session.layout ? tidy(session.layout) : undefined;
    if (kept.saved) kept.draft = undefined;
    kept.shown = undefined;
  }

  #end(key: string, kept: Kept) {
    // Gone for good: one made there later starts with nothing of it.
    this.#kept.delete(key);
    kept.changes = [];
  }

  /** Saves the changes that wait, one write at a time, making them again on a newer revision. */
  async #save(kept: Kept) {
    if (kept.writing) return;
    kept.writing = true;
    try {
      for (let tries = 0; kept.changes.length > 0; tries++) {
        const connection = this.#deps.connection(kept.hostId);
        // Away: they wait for it. A Host that keeps no Sessions never takes them.
        if (!connection || connection.closed) return;
        const base = this.#base(kept);
        const changes = [...kept.changes];
        const next = changes.reduce((layout, change) => tidy(change(layout)), base);
        const settle = () => {
          kept.changes = kept.changes.slice(changes.length);
          kept.shown = undefined;
        };
        if (!connection.supports(HOST_PROTOCOL.features.sessions)) {
          kept.draft = next;
          settle();
          continue;
        }
        if (same(next, base) && kept.saved) {
          settle();
          continue;
        }
        if (tries >= TRIES) {
          settle();
          this.#deps.failed("Couldn't save the layout: another device kept changing it.");
          return;
        }
        try {
          const { session } = await connection.request('sessions/set', {
            directory: kept.directory,
            layout: next,
            ifRevision: kept.session?.revision ?? 0,
          });
          settle();
          kept = this.#saved(kept, session);
        } catch (error) {
          if (error instanceof HostError && error.code === HOST_PROTOCOL.errors.revisionConflict) {
            // Another device saved first: its layout, then these changes again.
            try {
              const { session } = await connection.request('sessions/get', { directory: kept.directory });
              this.#took(kept.hostId, session);
            } catch (inner) {
              if (inner instanceof HostError && inner.code === CONNECTION_CLOSED) return;
              // Ended meanwhile: there's no revision to build on but the first.
              kept.session = undefined;
              kept.saved = undefined;
              kept.shown = undefined;
            }
            continue;
          }
          if (error instanceof HostError && error.code === CONNECTION_CLOSED) return;
          settle();
          this.#deps.failed(`Couldn't save the layout: ${describe(error)}`);
          return;
        }
      }
    } finally {
      kept.writing = false;
      this.#deps.changed();
    }
  }

  /** The Host kept a layout: under the directory it names the Session by, which may not be the one asked with. */
  #saved(kept: Kept, session: HostSession): Kept {
    if (session.directory === kept.directory) {
      this.#took(kept.hostId, session);
      return kept;
    }
    const from = sessionKey(kept.hostId, kept.directory);
    const to = sessionKey(kept.hostId, session.directory);
    this.#kept.delete(from);
    const target = this.#entry(kept.hostId, session.directory);
    target.changes.push(...kept.changes);
    target.writing = kept.writing;
    for (const name of kept.asked) target.asked.add(name);
    kept.changes = [];
    kept.writing = false;
    this.#took(kept.hostId, session);
    this.#deps.moved(from, to);
    return target;
  }
}
