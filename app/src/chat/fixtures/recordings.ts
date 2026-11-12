// The journals recorded from a dev Host with the fake agent (`scripts/record-journals.ts`), for tests,
// and the transcript a client shows after following one.
import type { OpenedThread } from '@/host/connection';
import { JournalFollower, transcriptEvents } from '@/host/journal';
import type { ThreadEventNotification, ThreadState } from '@/host/protocol';
import { type AcpTranscript, createTranscript, reduceAcpEvent, reduceJournalEvent } from '../acp-transcript';

export type Recording = { name: string; state: ThreadState; events: ThreadEventNotification[] };

/** The recorded journals, by name. */
export const recordings: Record<string, Recording> = Object.fromEntries(
  Object.values(import.meta.glob<Recording>('./journals/*.json', { eager: true, import: 'default' }))
    .map((recording) => [recording.name, recording]),
);

/**
 * The transcript a client shows after following the journal: `live` as each event happened, or
 * `replayed` from history after attaching once it was all written; `until` stops before the first
 * event it picks.
 */
export function follow(recording: Recording, how: 'live' | 'replayed', until?: (notification: ThreadEventNotification) => boolean): AcpTranscript {
  const follower = new JournalFollower();
  const head = how === 'replayed' ? recording.events.at(-1)?.seq ?? 0 : 0;
  const state = { ...recording.state, journal: { ...recording.state.journal, head } };
  follower.opened({ state, replay: { from: 1, reset: true } } as OpenedThread);
  let transcript = reduceAcpEvent(createTranscript(state.threadId), { type: 'thread/loaded', modes: state.modes, configOptions: state.configOptions });
  for (const notification of recording.events) {
    if (until?.(notification)) break;
    if (!follower.accept(notification)) continue;
    const reading = { history: follower.isHistory(notification), own: () => false };
    // Dated as the app dates them, by when the journal recorded them.
    transcript = transcriptEvents(notification, reading).reduce((model, event) => reduceJournalEvent(model, event, notification.at), transcript);
  }
  return transcript;
}
