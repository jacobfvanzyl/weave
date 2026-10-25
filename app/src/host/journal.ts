import type { AcpTranscriptEvent } from '@/chat/acp-transcript';
import type { OpenedSession } from './connection';
import type { AgentRelease, JournalPosition, SessionEventNotification, TurnOrigin } from './protocol';

/**
 * Where this client is in one attached session's journal. A client attaches after the last
 * position it handled, so it gets only what it missed; events up to the journal's head when it
 * attached are history, replayed, and the rest live.
 */
export class JournalFollower {
  #journal?: string;
  #seq = 0;
  #historyUntil = 0;

  /** The position to attach after, once the client has handled anything. */
  get position(): JournalPosition | undefined {
    return this.#journal === undefined ? undefined : { journal: this.#journal, seq: this.#seq };
  }

  /**
   * An attach's answer, ahead of its replay. Returns whether the transcript starts over: the
   * Host replays everything when the client named another journal, or none.
   */
  opened(session: OpenedSession): { reset: boolean } {
    const { journal } = session.state;
    const reset = session.replay?.reset ?? this.#journal !== journal.id;
    if (reset) this.#seq = 0;
    this.#journal = journal.id;
    this.#historyUntil = journal.head;
    return { reset };
  }

  /** Whether to handle an event: false for one already handled, as after a reconnect. */
  accept(notification: SessionEventNotification): boolean {
    if (this.#journal === undefined || notification.seq <= this.#seq) return false;
    this.#seq = notification.seq;
    return true;
  }

  /** Whether an event was written before this client attached. */
  isHistory(notification: SessionEventNotification): boolean {
    return notification.seq <= this.#historyUntil;
  }

  /** Whether history the attach replays is still to come. */
  get replaying(): boolean {
    return this.#journal !== undefined && this.#seq < this.#historyUntil;
  }
}

/** How a client reads the journal it follows. */
export type JournalReading = {
  /** The event was written before this client attached: it changes no turn state. */
  history: boolean;
  /** Whether a prompt is this client's own, sent from this device. */
  own(origin: TurnOrigin): boolean;
};

const clientNames: Record<string, string> = { 'weave-tui': 'the TUI', 'weave-app': 'the weave app' };

/**
 * Where another client's prompt came from: its device, its client, a headless run, or another
 * session: the session whose agent started this one, or one this session's agent started.
 */
export function originLabel(origin: TurnOrigin): string {
  if ('run' in origin) return 'a headless run';
  if ('session' in origin) return 'another thread';
  if (!('client' in origin)) return 'elsewhere';
  return origin.client.device || clientNames[origin.client.name] || origin.client.name;
}

/** A package as people say it: `@zed-industries/claude-code-acp` is `claude-code-acp`. */
const shortName = (name: string) => {
  if (!name.startsWith('@')) return name;
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
};

/** What the transcript says when the session's agent was started again, as the TUI says it. */
export function reopenedText(release?: AgentRelease | null, previous?: AgentRelease | null, failed?: string | null): string {
  if (failed) {
    return release ? `${failed}; it runs ${shortName(release.name)} ${release.version} again` : `${failed}; it runs the agent it ran again`;
  }
  if (!release) return 'Reopened this thread in a new agent process';
  if (previous && previous.version !== release.version) {
    return `Moved this thread to ${shortName(release.name)} ${release.version}, from ${previous.version}`;
  }
  return `Reopened this thread on ${shortName(release.name)} ${release.version}`;
}

/**
 * A journaled event as the transcript's events. Replayed history shows the same as live events
 * but changes no turn state; kinds this client doesn't know are skipped.
 */
export function transcriptEvents(notification: SessionEventNotification, reading: JournalReading): AcpTranscriptEvent[] {
  const root = notification.sessionId;
  const { event } = notification;
  const live = !reading.history;
  switch (event.kind) {
    case 'update':
      return [{
        type: 'session/update',
        update: event.notification.update,
        sessionId: event.notification.sessionId,
        ...(live ? {} : { replayed: true }),
      }];
    case 'turnStarted':
    case 'turnSteered': {
      const own = reading.own(event.origin);
      const prompt: AcpTranscriptEvent = {
        type: 'prompt',
        prompt: event.prompt,
        sessionId: event.sessionId,
        ...(event.kind === 'turnSteered' ? { steer: true } : {}),
        // One that waited in the Host's queue was never shown here before.
        ...(event.kind === 'turnStarted' && event.queuedId ? { queued: true } : {}),
        ...(own ? { own } : { origin: originLabel(event.origin) }),
        ...(live ? {} : { replayed: true }),
      };
      return event.kind === 'turnStarted' && event.sessionId === root && live ? [prompt, { type: 'turn/started' }] : [prompt];
    }
    case 'turnEnded': {
      const error = event.error ? event.error.message : event.response ? undefined : 'The turn ended unexplained';
      const stopReason = event.response?.stopReason;
      const ended: AcpTranscriptEvent = {
        type: 'turn/ended',
        sessionId: event.sessionId,
        ...(error === undefined ? {} : { error }),
        ...(stopReason ? { stopReason } : {}),
      };
      if (event.sessionId !== root || !live) return [ended];
      return [ended, error === undefined ? { type: 'turn/stopped', stopReason: stopReason ?? 'end_turn' } : { type: 'turn/failed', error }];
    }
    case 'terminalOutput':
      return [{ type: 'terminal/output', terminalId: event.terminalId, data: event.data }];
    case 'terminalExit':
      return [{ type: 'terminal/exit', terminalId: event.terminalId, status: event.status }];
    case 'agentReopened':
      return [{
        type: 'agent/reopened',
        text: reopenedText(event.agent.release, event.previous, event.failed),
        failed: Boolean(event.failed),
        modes: event.modes,
        configOptions: event.configOptions,
      }];
    case 'notice':
      return [{ type: 'notice', severity: 'info', title: event.text }];
    case 'closed':
      return [{ type: 'session/closed', reason: event.reason }];
    case 'renamed': {
      const by = !event.by ? 'The agent' : reading.own(event.by) ? 'You' : originLabel(event.by);
      return [{ type: 'session/renamed', title: event.title, by: by.charAt(0).toUpperCase() + by.slice(1) }];
    }
    default:
      return [];
  }
}
