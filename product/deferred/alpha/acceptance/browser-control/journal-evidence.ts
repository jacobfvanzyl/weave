import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type JournalEvent = {
  threadId?: string;
  sequence?: number;
  createdAt?: string;
  message?: { params?: { update?: Record<string, unknown> } };
};

export type BrowserControlAcceptanceEvidence = {
  version: 1;
  platform: 'macOS' | 'iPadOS';
  threadId: string;
  sequence: { first: number; last: number };
  url: string;
  tabId: string;
  generation: number;
  controlRevision: number;
  finalVisibleState: string;
  actions: string[];
  navigationOutcome: 'completed' | 'timed-out-then-observed';
  freshViewChain: boolean;
  screenshot: { kind: 'inline' | 'artifact'; sizeBytes: number };
  typedFailures: string[];
  observedTabIds: string[];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const option = (name: string) => {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
};

export function collectBrowserControlEvidence(
  events: JournalEvent[],
  input: {
    threadId: string;
    platform: 'macOS' | 'iPadOS';
    expectedText: string;
    startSequence?: number;
    endSequence?: number;
    allowLoopbackHttp?: boolean;
  },
): BrowserControlAcceptanceEvidence {
  const scoped = events.filter((event) =>
    event.threadId === input.threadId &&
    (event.sequence ?? 0) >= (input.startSequence ?? 0) &&
    (event.sequence ?? 0) <= (input.endSequence ?? Number.MAX_SAFE_INTEGER));
  const completed = scoped.flatMap((event) => {
    const update = record(event.message?.params?.update);
    if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'completed') return [];
    const rawInput = record(update.rawInput);
    const rawResult = record(record(update.rawOutput).result);
    const view = record(rawResult.structuredContent);
    const tool = typeof rawInput.tool === 'string' ? rawInput.tool : '';
    if (!tool.startsWith('browser_') || typeof view.id !== 'string' || typeof view.tabId !== 'string') return [];
    return [{ event, update, tool, args: record(rawInput.arguments), result: rawResult, view }];
  });
  const failedNavigations = scoped.flatMap((event) => {
    const update = record(event.message?.params?.update);
    const rawInput = record(update.rawInput);
    const result = record(record(record(update.rawOutput).result).structuredContent);
    const args = record(rawInput.arguments);
    if (
      update.sessionUpdate !== 'tool_call_update' || update.status !== 'failed' ||
      rawInput.tool !== 'browser_see' || typeof args.url !== 'string' ||
      record(result.error).code !== 'TIMEOUT'
    ) return [];
    return [{ event, url: args.url }];
  });
  const final = [...completed].reverse().find(({ view, result }) => {
    const content = Array.isArray(result.content) ? result.content.map(record) : [];
    return typeof view.text === 'string' && view.text.includes(input.expectedText) &&
      content.some((item) => item.type === 'image' || item.type === 'resource_link');
  });
  if (!final) throw new Error(`No completed Browser run contains ${input.expectedText} and screenshot evidence.`);
  const url = String(final.view.url ?? '');
  if (!url.startsWith('https://') && !(input.allowLoopbackHttp && /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url))) {
    throw new Error(`Browser control acceptance requires HTTPS; received ${url || 'no URL'}.`);
  }
  const run = completed.filter(({ event, view }) =>
    view.tabId === final.view.tabId && (event.sequence ?? 0) <= (final.event.sequence ?? 0));
  let previousViewId: string | undefined;
  let freshViewChain = true;
  const actions: string[] = [];
  for (const call of run) {
    if (call.tool === 'browser_see') {
      actions.push(call.args.url ? 'navigate' : 'observe');
    } else {
      if (call.args.viewId !== previousViewId) freshViewChain = false;
      const action = record(call.args.action);
      if (typeof action.kind === 'string') actions.push(action.kind);
    }
    previousViewId = String(call.view.id);
  }
  let navigationOutcome: BrowserControlAcceptanceEvidence['navigationOutcome'] = 'completed';
  if (!actions.includes('navigate')) {
    const timedOutNavigation = failedNavigations.find(({ event, url: attemptedUrl }) =>
      attemptedUrl === url && (event.sequence ?? 0) <= (run[0]?.event.sequence ?? 0));
    if (!timedOutNavigation) throw new Error('Browser run is missing navigate.');
    actions.unshift('navigate');
    navigationOutcome = 'timed-out-then-observed';
  }
  for (const required of ['navigate', 'fill', 'key', 'click', 'scroll']) {
    if (!actions.includes(required)) throw new Error(`Browser run is missing ${required}.`);
  }
  if (!freshViewChain) throw new Error('Browser actions did not chain from every fresh view.');
  const content = Array.isArray(final.result.content) ? final.result.content.map(record) : [];
  const image = content.find((item) => item.type === 'image');
  const artifact = content.find((item) => item.type === 'resource_link');
  const screenshot = image
    ? { kind: 'inline' as const, sizeBytes: Math.floor(String(image.data ?? '').length * 3 / 4) }
    : { kind: 'artifact' as const, sizeBytes: Number(artifact?.size ?? 0) };
  if (screenshot.sizeBytes < 1) throw new Error('Screenshot evidence is empty.');
  const typedFailures = [...new Set(scoped.flatMap((event) => {
    const update = record(event.message?.params?.update);
    const result = record(record(record(update.rawOutput).result).structuredContent);
    const error = record(result.error);
    return typeof error.code === 'string' ? [error.code] : [];
  }))];
  const observedTabIds = [...new Set(completed.map(({ view }) => String(view.tabId)))];
  return {
    version: 1,
    platform: input.platform,
    threadId: input.threadId,
    sequence: {
      first: Math.min(...run.map(({ event }) => event.sequence ?? 0)),
      last: final.event.sequence ?? 0,
    },
    url,
    tabId: String(final.view.tabId),
    generation: Number(final.view.generation),
    controlRevision: Number(final.view.controlRevision),
    finalVisibleState: input.expectedText,
    actions,
    navigationOutcome,
    freshViewChain,
    screenshot,
    typedFailures,
    observedTabIds,
  };
}

if (import.meta.main) {
  const journalPath = option('--journal');
  const threadId = option('--thread');
  const platform = option('--platform');
  const expectedText = option('--expected-text');
  const output = option('--output');
  if (!journalPath || !threadId || !expectedText || !output || (platform !== 'macOS' && platform !== 'iPadOS')) {
    throw new Error('--journal, --thread, --platform macOS|iPadOS, --expected-text, and --output are required.');
  }
  const journal = JSON.parse(readFileSync(resolve(journalPath), 'utf8')) as { events?: JournalEvent[] };
  const evidence = collectBrowserControlEvidence(journal.events ?? [], {
    threadId,
    platform,
    expectedText,
    startSequence: Number(option('--start-sequence') ?? 0),
    endSequence: Number(option('--end-sequence') ?? Number.MAX_SAFE_INTEGER),
    allowLoopbackHttp: Bun.argv.includes('--allow-loopback-http'),
  });
  const destination = resolve(output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(destination, 0o600);
  console.log(JSON.stringify(evidence, null, 2));
}
