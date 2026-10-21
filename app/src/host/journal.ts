import type { AcpTranscriptEvent } from '@/chat/acp-transcript';
import type { OpenedSession } from './connection';
import type { JournalPosition, SessionEventNotification } from './protocol';

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
}

/**
 * A journaled event as the transcript's events. Events about subagent sessions, Host-run
 * terminals and reopened agents show from WVE-101; kinds this client doesn't know are skipped.
 */
export function transcriptEvents(notification: SessionEventNotification): AcpTranscriptEvent[] {
  const root = notification.sessionId;
  const { event } = notification;
  const prompt = (sessionId: string, blocks: { type: string }[], seq: number): AcpTranscriptEvent[] =>
    sessionId !== root ? [] : blocks.map((content) => ({
      type: 'session/update',
      update: { sessionUpdate: 'user_message_chunk', content, messageId: `prompt-${seq}` },
    }) as AcpTranscriptEvent);
  switch (event.kind) {
    case 'update':
      return event.notification.sessionId === root ? [{ type: 'session/update', update: event.notification.update }] : [];
    case 'turnStarted':
      return event.sessionId === root ? [...prompt(event.sessionId, event.prompt, notification.seq), { type: 'turn/started' }] : [];
    case 'turnSteered':
      return prompt(event.sessionId, event.prompt, notification.seq);
    case 'turnEnded':
      if (event.sessionId !== root) return [];
      return event.error
        ? [{ type: 'turn/failed', error: event.error.message }]
        : [{ type: 'turn/stopped', stopReason: event.response?.stopReason ?? 'end_turn' }];
    case 'notice':
      return [{ type: 'notice', severity: 'info', title: event.text }];
    case 'closed':
      return [{ type: 'notice', severity: 'info', title: 'The session closed', detail: event.reason }];
    default:
      return [];
  }
}
