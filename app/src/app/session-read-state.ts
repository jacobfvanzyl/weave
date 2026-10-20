import type { SessionActivity } from './app-controller';

/**
 * Which sessions finished a turn while the person wasn't looking at them, on this device. A
 * session becomes unread when it goes from running or waiting to idle off screen, and read again
 * when it is opened.
 */
export class SessionReadState {
  #focused?: string;
  readonly #activity = new Map<string, SessionActivity | undefined>();
  readonly #unread = new Set<string>();

  /** The session on screen, or none. Returns whether the unread set changed. */
  focus(key?: string): boolean {
    this.#focused = key;
    return key !== undefined && this.#unread.delete(key);
  }

  /** A session's latest activity. Returns whether the unread set changed. */
  observe(key: string, activity: SessionActivity | undefined): boolean {
    const previous = this.#activity.get(key);
    this.#activity.set(key, activity);
    const finished = (previous === 'running' || previous === 'waiting') && activity === 'idle';
    if (!finished || key === this.#focused || this.#unread.has(key)) return false;
    this.#unread.add(key);
    return true;
  }

  forget(key: string) {
    this.#activity.delete(key);
    this.#unread.delete(key);
  }

  unread(): ReadonlySet<string> {
    return new Set(this.#unread);
  }
}
