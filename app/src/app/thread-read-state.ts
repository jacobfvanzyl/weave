import type { ThreadActivity } from './app-controller';

/**
 * Which threads finished a turn while the person wasn't looking at them, on this device. A
 * thread becomes unread when it goes from running or waiting to idle off screen, and read again
 * when it is opened.
 */
export class ThreadReadState {
  #focused?: string;
  readonly #activity = new Map<string, ThreadActivity | undefined>();
  readonly #unread = new Set<string>();

  /** The thread on screen, or none. Returns whether the unread set changed. */
  focus(key?: string): boolean {
    this.#focused = key;
    return key !== undefined && this.#unread.delete(key);
  }

  /** A thread's latest activity. Returns whether the unread set changed. */
  observe(key: string, activity: ThreadActivity | undefined): boolean {
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
