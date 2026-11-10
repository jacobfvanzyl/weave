import type { AppModel, ThreadActivity } from '@/app/app-controller';
import { waitingCount } from '@/app/thread-list';
import type { AcpTranscript, TranscriptEntry } from '@/chat/acp-transcript';
import { ownThreads } from '@/session/sessions';

/**
 * What a Surface (WVE-183) shows of a thread above its transcript. The device sends it; the
 * Surface talks to no Host.
 */
export type SurfaceThread = {
  key: string;
  title?: string;
  agentName?: string;
  cwd?: string;
  branch?: string;
  /** The Host's name, when the device has more than one. */
  host?: string;
  activity?: ThreadActivity;
  /** Its history is still replaying on the device. */
  loading?: boolean;
};

/** A transcript without its entries, which travel apart, from the first that changed. */
export type TranscriptBase = Omit<AcpTranscript, 'entries'>;

/** From the device to its Surface. */
export type ToSurface =
  /**
   * What the Surface shows: the thread open on the device, or with `dimmed` the one last open
   * while the device shows its list, and how many threads wait on the person.
   */
  | { kind: 'show'; thread?: SurfaceThread; dimmed: boolean; waiting: number }
  /**
   * The thread's transcript: `base`, and `entries` replacing the Surface's from `from` on, so
   * that it has `length` entries. A Surface whose count comes out otherwise asks again (`ready`).
   */
  | { kind: 'transcript'; key: string; base: TranscriptBase; from: number; entries: TranscriptEntry[]; length: number }
  /** Scrolls the Surface's thread: to a fraction of the way down, or to its end, following it. */
  | { kind: 'scroll'; fraction: number }
  | { kind: 'scroll'; to: 'end' };

/** Where the Surface's thread is scrolled to. `following` while it keeps to the end. */
export type SurfacePosition = { fraction: number; following: boolean; scrollable: boolean };

/** From the Surface to the device. `ready` asks for everything again, as on connecting. */
export type FromSurface = { kind: 'ready' } | ({ kind: 'position' } & SurfacePosition);

/** What the device last sent of a transcript, by reference, for sending only what changed since. */
export type SentTranscript = { key: string; transcript: AcpTranscript };

/**
 * The transcript message that brings a Surface from `sent` to `transcript`: entries are replaced
 * from the first whose object changed, since the transcript's reducer replaces an entry it
 * changes and keeps the rest. None when nothing changed.
 */
export function transcriptMessage(key: string, transcript: AcpTranscript, sent?: SentTranscript): ToSurface | undefined {
  if (sent?.key === key && sent.transcript === transcript) return undefined;
  const { entries, ...base } = transcript;
  const previous = sent?.key === key ? sent.transcript.entries : [];
  let from = 0;
  while (from < entries.length && from < previous.length && entries[from] === previous[from]) from += 1;
  return { kind: 'transcript', key, base, from, entries: entries.slice(from), length: entries.length };
}

/** Applies a transcript message to what the Surface has; none when it doesn't add up and the Surface has to ask again. */
export function applyTranscript(current: { key: string; transcript: AcpTranscript } | undefined,
  message: Extract<ToSurface, { kind: 'transcript' }>): { key: string; transcript: AcpTranscript } | undefined {
  const kept = current?.key === message.key ? current.transcript.entries.slice(0, message.from) : [];
  if (kept.length !== message.from) return undefined;
  const entries = [...kept, ...message.entries];
  if (entries.length !== message.length) return undefined;
  return { key: message.key, transcript: { ...message.base, entries } };
}

/** The thread's header on a Surface, from the device's list. */
export function surfaceThread(model: AppModel, key: string, loading?: boolean): SurfaceThread {
  const summary = model.threads.find((thread) => thread.key === key);
  const host = summary ? model.hosts.find(({ id }) => id === summary.hostId) : undefined;
  return {
    key,
    title: summary?.title,
    agentName: summary?.agentName,
    cwd: summary?.cwd,
    branch: summary?.git?.branch,
    host: model.hosts.length > 1 ? host?.name : undefined,
    activity: summary?.activity,
    ...(loading ? { loading } : {}),
  };
}

/**
 * The `show` message for the device's model: the open thread, or the one last open, dimmed, while
 * the device shows its list. `waiting` counts the threads that wait on the person other than the
 * one shown.
 */
export function showMessage(model: AppModel, lastKey: string | undefined): Extract<ToSurface, { kind: 'show' }> {
  const key = model.thread?.key ?? lastKey;
  return {
    kind: 'show',
    thread: key ? surfaceThread(model, key, model.thread?.loading) : undefined,
    dimmed: !model.thread,
    waiting: waitingCount(ownThreads(model), model.thread?.key),
  };
}
