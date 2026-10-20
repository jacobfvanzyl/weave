import type { PairedHost, SessionSummary } from './app-controller';
import { directoryName } from '@/lib/display-path';

/** The sessions one Host runs in one directory. */
export type DirectoryGroup = {
  key: string;
  hostId: string;
  /** Set only when more than one Host is paired. */
  hostName?: string;
  cwd: string;
  name: string;
  sessions: SessionSummary[];
};

export type SessionListView = {
  /** Sessions waiting on the person, across Hosts and directories. */
  needsYou: SessionSummary[];
  groups: DirectoryGroup[];
};

const recency = (session: SessionSummary) => session.lastActivityAt ?? 0;
const newestFirst = (left: SessionSummary, right: SessionSummary) => recency(right) - recency(left);

const matches = (session: SessionSummary, query: string) =>
  [session.title ?? '', session.cwd, session.agentName].some((value) =>
    value.toLocaleLowerCase().includes(query));

/**
 * The session list: closed sessions only when asked for, "Needs you" on top, then one group per
 * Host and directory, the most recently active first.
 */
export function sessionListView(
  sessions: readonly SessionSummary[],
  hosts: readonly PairedHost[],
  options: { query?: string; showClosed?: boolean } = {},
): SessionListView {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const shown = sessions.filter((session) =>
    (options.showClosed || session.state !== 'closed') && (!query || matches(session, query)));
  const named = hosts.length > 1;
  const groups = new Map<string, DirectoryGroup>();
  for (const session of [...shown].sort(newestFirst)) {
    const key = `${session.hostId}\u0000${session.cwd}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        hostId: session.hostId,
        hostName: named ? hosts.find(({ id }) => id === session.hostId)?.name : undefined,
        cwd: session.cwd,
        name: directoryName(session.cwd),
        sessions: [],
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return {
    needsYou: shown.filter(({ activity }) => activity === 'waiting').sort(newestFirst),
    // Sessions were added newest first, so groups already follow their latest activity.
    groups: [...groups.values()],
  };
}

/** How many sessions other than `except` wait on the person. */
export const waitingCount = (sessions: readonly SessionSummary[], except?: string) =>
  sessions.filter(({ key, activity }) => activity === 'waiting' && key !== except).length;

/** The directories a Host's sessions use, most recently active first, for new sessions. */
export const knownDirectories = (sessions: readonly SessionSummary[], hostId: string) =>
  [...new Set([...sessions].filter((session) => session.hostId === hostId).sort(newestFirst).map(({ cwd }) => cwd))];
