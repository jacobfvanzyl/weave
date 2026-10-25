#!/usr/bin/env bun
// Records journals from a dev Host with the fake agent (`src/host/testing/dev-host.ts`), one
// session per script, into `src/chat/fixtures/journals/`, for the transcript's tests (WVE-101).
// Build the debug binaries first: `(cd .. && cargo build -p weave-cli -p weave-fake-agent)`.
//
//   bun scripts/record-journals.ts [name…]
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostConnection, type HostEvent } from '../src/host/connection';
import type { ContentBlock, SessionEventNotification, SessionState } from '../src/host/protocol';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from '../src/host/testing/dev-host';

const out = resolve(import.meta.dirname, '../src/chat/fixtures/journals');

/** A 2×2 PNG, for a prompt with an image. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

type Recording = { name: string; state: SessionState; events: SessionEventNotification[] };

type Script = (session: Session) => Promise<void>;

type Session = {
  id: string;
  /** The directory the session runs in. */
  cwd: string;
  local: HostConnection;
  prompt(words: string | ContentBlock[]): Promise<void>;
  /** Waits until the journal has been quiet for `ms`. */
  quiet(ms?: number): Promise<void>;
  events: SessionEventNotification[];
};

const text = (words: string): ContentBlock[] => [{ type: 'text', text: words }];

const scripts: Record<string, Script> = {
  plan: (session) => session.prompt('/plan'),
  run: (session) => session.prompt("/run printf '\\033[1;32mgreen\\033[0m and plain\\nline two\\r\\nline three\\n'; exit 3"),
  write: (session) => session.prompt(`/write ${session.cwd}/notes.txt Hello from the fake agent`),
  delegate: async (session) => {
    await session.prompt('/delegate');
    await session.quiet(1_500);
  },
  compact: (session) => session.prompt('/compact'),
  think: (session) => session.prompt('/think'),
  markdown: (session) => session.prompt('/markdown'),
  image: (session) => session.prompt([{ type: 'text', text: 'What is in this picture?' }, { type: 'image', mimeType: 'image/png', data: PNG }]),
  steer: async (session) => {
    const ended = session.prompt('/slow 12');
    await Bun.sleep(400);
    await session.local.request('turn/steer', { sessionId: session.id, prompt: text('And mention the steer.') });
    await ended;
  },
  cancel: async (session) => {
    const ended = session.prompt('/slow 40');
    await Bun.sleep(400);
    await session.local.request('turn/cancel', { sessionId: session.id });
    await ended;
  },
  modes: (session) => session.prompt('/switch-mode'),
  notice: async (session) => {
    await session.prompt('/mcp-legacy');
    await session.quiet();
  },
  reopen: async (session) => {
    await session.prompt('hello before the reopen');
    await session.local.request('session/reopen', { sessionId: session.id });
    await session.quiet();
    await session.prompt('hello after it');
  },
  close: async (session) => {
    await session.prompt('hello before closing');
    await session.local.request('session/close', { sessionId: session.id });
    await session.quiet();
  },
};

async function record(host: DevHost, name: string, script: Script): Promise<Recording> {
  const events: SessionEventNotification[] = [];
  let opened: SessionState | undefined;
  let failed: Error | undefined;
  const local = await HostConnection.connect({
    connector: unixConnector(host.socket),
    client: { name: 'weave-tui', version: '0' },
    credentials: { method: 'local' },
    onEvent(event: HostEvent) {
      if (event.type === 'opened') opened = event.session.state;
      else if (event.type === 'openFailed') failed = event.error;
      else if (event.type === 'notification' && event.method === 'session/event') events.push(event.params);
    },
  });
  try {
    local.open({ create: { agentId: 'fake', cwd: host.cwd, policy: { approve: ['edit', 'execute', 'read'], otherwise: 'ask' } } }, 1);
    while (!opened && !failed) await Bun.sleep(20);
    if (failed) throw failed;
    const state = opened!;
    const quiet = async (ms = 600) => {
      let seen = events.length;
      let since = Date.now();
      while (Date.now() - since < ms) {
        await Bun.sleep(50);
        if (events.length !== seen) {
          seen = events.length;
          since = Date.now();
        }
      }
    };
    const session: Session = {
      id: state.sessionId,
      cwd: host.cwd,
      local,
      events,
      quiet,
      async prompt(words) {
        const before = events.length;
        await local.request('turn/start', { sessionId: state.sessionId, prompt: typeof words === 'string' ? text(words) : words });
        const deadline = Date.now() + 20_000;
        while (!events.slice(before).some(({ event, sessionId }) => event.kind === 'turnEnded' && event.sessionId === sessionId)) {
          if (Date.now() > deadline) throw new Error(`${name}: the turn didn't end`);
          await Bun.sleep(20);
        }
      },
    };
    await script(session);
    await quiet(300);
    return { name, state, events };
  } finally {
    local.close();
  }
}

if (!devHostAvailable()) {
  console.error('Build the debug binaries first: (cd .. && cargo build -p weave-cli -p weave-fake-agent)');
  process.exit(1);
}
const wanted = process.argv.slice(2);
const host = await startDevHost();
try {
  await mkdir(out, { recursive: true });
  for (const [name, script] of Object.entries(scripts)) {
    if (wanted.length > 0 && !wanted.includes(name)) continue;
    const recording = await record(host, name, script);
    // The dev Host's directory is a temporary one; fixtures name a stable one, cut-off paths in
    // titles too.
    const root = tmpdir().split('/').slice(0, 3).join('/');
    const temporary = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^"\\s]*`, 'g');
    const json = JSON.stringify(recording, null, 2).replaceAll(host.cwd, '/work/project').replace(temporary, '/work/project');
    await writeFile(join(out, `${name}.json`), `${json}\n`);
    const kinds = [...new Set(recording.events.map(({ event }) => event.kind === 'update' ? event.notification.update.sessionUpdate : event.kind))];
    console.log(`${name}: ${recording.events.length} events (${kinds.join(', ')})`);
  }
} finally {
  await host.stop();
}
