import { Markdown, type MarkdownTheme } from 'pi-tui';

type TuiConfig = {
  httpServerUrl?: string;
  authToken?: string;
};

type ParsedArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

type ChatMessage = {
  id: string;
  role: string;
  parts?: Array<Record<string, unknown>>;
};

type ChatThread = {
  id: string;
  title?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

type ResolvedWorkspace = Record<string, any> & {
  plane?: { id?: string; name?: string };
  demiplane?: { id?: string; name?: string; path?: string };
  thread?: { id?: string };
};

type StreamChunk = {
  type: string;
  delta?: string;
  errorText?: string;
  toolName?: string;
  toolCallId?: string;
};

const homeDir = Deno.env.get('HOME') ?? '.';
const defaultConfigPath = `${homeDir}/.weave/tui.json`;
const defaultServerUrl = 'http://localhost:4111';
const mocha = {
  rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
  red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af',
  green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec',
  blue: '#89b4fa', lavender: '#b4befe', text: '#cdd6f4', subtext1: '#bac2de',
  subtext0: '#a6adc8', overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086',
  surface2: '#585b70', surface1: '#45475a', surface0: '#313244', base: '#1e1e2e',
  mantle: '#181825', crust: '#11111b',
};

const hexToRgb = (hex: string) => {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

const ansi = {
  reset: '\x1b[0m',
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
  fg: (hex: string, text: string) => {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  },
  bg: (hex: string, text: string) => {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
  },
};

const markdownTheme: MarkdownTheme = {
  heading: text => ansi.fg(mocha.peach, text),
  link: text => ansi.fg(mocha.blue, text),
  linkUrl: text => ansi.fg(mocha.overlay0, text),
  code: text => ansi.fg(mocha.teal, text),
  codeBlock: text => text,
  codeBlockBorder: text => ansi.fg(mocha.surface0, text),
  quote: text => ansi.fg(mocha.overlay0, text),
  quoteBorder: text => ansi.fg(mocha.surface0, text),
  hr: text => ansi.fg(mocha.surface0, text),
  listBullet: text => ansi.fg(mocha.mauve, text),
  bold: ansi.bold,
  italic: ansi.italic,
  underline: ansi.underline,
  strikethrough: ansi.strikethrough,
};

const terminalWidth = () => Deno.consoleSize().columns || 100;

const renderMarkdown = (text: string, width = terminalWidth()) => new Markdown(text, 0, 0, markdownTheme)
  .render(Math.max(20, width - 4))
  .map(line => line.trimEnd())
  .join('\n');

const estimateTerminalLines = (text: string, width = terminalWidth()) => {
  const contentWidth = Math.max(1, width);
  const lines = text.split('\n');
  return Math.max(1, lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / contentWidth)), 0));
};

const replaceLastPrintedBlock = async (rawText: string, replacement: string) => {
  const lineCount = estimateTerminalLines(rawText);
  const moveUp = lineCount > 1 ? `\x1b[${lineCount - 1}A` : '';
  await Deno.stdout.write(new TextEncoder().encode(`\r${moveUp}\x1b[J${replacement}\n`));
};

const inputBorder = () => ansi.fg(mocha.green, '─'.repeat(Math.max(20, terminalWidth())));
const padVisible = (text: string, width = terminalWidth()) => `${text}${' '.repeat(Math.max(0, width - text.length))}`;
const userMessageBg = (text: string) => ansi.bg(mocha.surface0, text);
const renderUserMessage = (text: string) => {
  const width = terminalWidth();
  const lines = text.split('\n');
  return [
    userMessageBg(' '.repeat(width)),
    ...lines.map(line => userMessageBg(padVisible(` ${line}`, width))),
    userMessageBg(' '.repeat(width)),
  ].join('\n');
};
const isRenameThreadTool = (toolName: string | undefined) => toolName === 'renameThreadTool' || toolName === 'rename-thread';
const formatToolCall = (toolName: string | undefined, toolCallId: string | undefined) =>
  `🔧 ${ansi.fg(mocha.mauve, ansi.bold(toolName ?? toolCallId ?? 'tool'))}`;

const promptInput = async (readLine: () => Promise<string | undefined>) => {
  const border = inputBorder();
  await Deno.stdout.write(new TextEncoder().encode(`\n${border}\n \n${border}\n\n\x1b[3A\r\x1b[1C`));
  const line = await readLine();
  await Deno.stdout.write(new TextEncoder().encode('\x1b[2B\r'));
  return line;
};

const parseArgs = (args: string[]): ParsedArgs => {
  const [command, ...rest] = args;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;

    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
      continue;
    }

    flags[key] = true;
  }

  return { command, flags };
};

const stringFlag = (flags: Record<string, string | boolean>, key: string) => {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const readConfig = async (path: string): Promise<TuiConfig> => {
  const content = await Deno.readTextFile(path).catch(error => {
    if (error instanceof Deno.errors.NotFound) return '{}';
    throw error;
  });
  return JSON.parse(content) as TuiConfig;
};

const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

const writeConfig = async (path: string, config: TuiConfig) => {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};

const normalizeHttpUrl = (server: string) => server.replace(/\/$/, '');

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

const runGit = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  if (!output.success) throw new Error(decode(output.stderr) || `git ${args.join(' ')} failed`);
  return decode(output.stdout);
};

const detectWorkspace = async () => {
  const cwd = Deno.cwd();
  const gitTopLevel = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const gitCommonDir = await runGit(gitTopLevel, ['rev-parse', '--git-common-dir']).catch(() => undefined);
  const branch = await runGit(gitTopLevel, ['branch', '--show-current']).catch(() => undefined);
  const remote = await runGit(gitTopLevel, ['config', '--get', 'remote.origin.url']).catch(() => undefined);
  const workspacePath = await Deno.realPath(gitTopLevel);
  return { cwd, workspacePath, gitTopLevel: workspacePath, gitCommonDir, branch, remote };
};

const apiFetch = async (server: string, token: string, path: string, init: RequestInit = {}) => {
  const response = await fetch(`${server}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response;
};

const toolNameFromPartType = (type: string) => type.startsWith('tool-') ? type.slice('tool-'.length) : undefined;

const renderMessagePart = (part: Record<string, unknown>) => {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'reasoning' && typeof part.text === 'string') return part.text;

  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    const toolName = toolNameFromPartType(part.type);
    if (isRenameThreadTool(toolName)) return '';
    return formatToolCall(toolName, typeof part.toolCallId === 'string' ? part.toolCallId : undefined);
  }

  return '';
};

const textFromMessage = (message: ChatMessage) => (message.parts ?? [])
  .map(renderMessagePart)
  .filter(Boolean)
  .join('\n');

const printMessage = (message: ChatMessage) => {
  const text = textFromMessage(message).trim();
  if (!text) return;
  const rendered = message.role === 'assistant' ? renderMarkdown(text) : renderUserMessage(text);
  console.log(`\n${rendered}`);
};

const printMessages = (messages: ChatMessage[]) => {
  for (const message of messages) printMessage(message);
};

const getMessagesVersion = (messages: ChatMessage[]) => messages
  .map(message => `${message.id}:${message.role}:${message.parts?.length ?? 0}:${textFromMessage(message).length}`)
  .join('|');

const listMessages = async (server: string, token: string, threadId: string) => {
  const response = await apiFetch(server, token, `/chat-state/threads/${threadId}/messages`);
  const body = await response.json() as { messages?: ChatMessage[] };
  return body.messages ?? [];
};

const listDemiplaneThreads = async (server: string, token: string, planeId: string, demiplaneId?: string) => {
  const response = await apiFetch(server, token, '/chat-state/threads');
  const body = await response.json() as { threads?: ChatThread[] };
  return (body.threads ?? []).filter(thread => {
    const metadata = thread.metadata ?? {};
    return metadata.archived !== true && metadata.planeId === planeId && metadata.demiplaneId === demiplaneId;
  });
};

async function* parseSseJson(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data) as StreamChunk;
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const createLineReader = () => {
  const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  return async () => {
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        return line;
      }

      const { done, value } = await reader.read();
      if (done) {
        const line = buffer;
        buffer = '';
        return line || undefined;
      }
      buffer += value;
    }
  };
};

const createIdlePoller = (server: string, token: string, threadId: string, seenMessageIds: Set<string>) => {
  let running = false;
  let messagesVersion = '';

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await listMessages(server, token, threadId);
      const nextVersion = getMessagesVersion(messages);
      if (messagesVersion && nextVersion !== messagesVersion) {
        const unseenMessages = messages.filter(message => !seenMessageIds.has(message.id));
        if (unseenMessages.length > 0) {
          console.log('\n[refreshed]');
          for (const message of unseenMessages) {
            seenMessageIds.add(message.id);
            printMessage(message);
          }
          await Deno.stdout.write(new TextEncoder().encode('\n[input refreshed]\n'));
        }
      }
      messagesVersion = nextVersion;
    } catch (error) {
      console.error(`\n[refresh failed] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void poll(), 6_000);
  return {
    prime(messages: ChatMessage[]) {
      messagesVersion = getMessagesVersion(messages);
      for (const message of messages) seenMessageIds.add(message.id);
    },
    stop() {
      clearInterval(timer);
    },
    threadId() {
      return threadId;
    },
  };
};

const streamChat = async (server: string, token: string, threadId: string, text: string) => {
  const response = await apiFetch(server, token, '/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
      memory: { thread: threadId },
    }),
  });

  if (!response.body) throw new Error('chat response missing body');
  let assistantText = '';
  console.log('');
  for await (const chunk of parseSseJson(response.body)) {
    if (chunk.type === 'text-delta') {
      assistantText += chunk.delta ?? '';
      await Deno.stdout.write(new TextEncoder().encode(chunk.delta ?? ''));
    }
    if (chunk.type === 'tool-input-start' && !isRenameThreadTool(chunk.toolName)) {
      console.log(`\n${formatToolCall(chunk.toolName, chunk.toolCallId)}`);
    }
    if (chunk.type === 'error') console.log(`\n[error] ${chunk.errorText ?? 'stream error'}`);
  }

  const rendered = assistantText.trim() ? renderMarkdown(assistantText) : '';
  if (rendered && rendered !== assistantText.trim()) {
    await replaceLastPrintedBlock(assistantText, rendered);
  } else {
    console.log('\n');
  }
};

const createThread = async (server: string, token: string, planeId: string, demiplaneId?: string) => {
  const response = await apiFetch(server, token, `/planes/${planeId}/threads`, {
    method: 'POST',
    body: JSON.stringify({ demiplaneId }),
  });
  const body = await response.json() as { thread?: { id?: string } };
  const threadId = body.thread?.id;
  if (!threadId) throw new Error('create thread response missing thread.id');
  return threadId;
};

const formatThreadLabel = (thread: ChatThread, index: number) => {
  const title = thread.title && !['...', 'New chat'].includes(thread.title) ? thread.title : 'Untitled';
  const updated = thread.updatedAt ? ` ${thread.updatedAt.slice(0, 19).replace('T', ' ')}` : '';
  return `${index + 1}. ${title} (${thread.id})${updated}`;
};

const resumeThread = async (
  server: string,
  token: string,
  resolved: ResolvedWorkspace,
  readLine: () => Promise<string | undefined>,
) => {
  const planeId = resolved.plane?.id;
  if (!planeId) throw new Error('resolved workspace missing plane.id');

  const threads = await listDemiplaneThreads(server, token, planeId, resolved.demiplane?.id);
  if (threads.length === 0) {
    console.log('\nNo threads in this demiplane.');
    return undefined;
  }

  console.log('\nThreads:');
  threads.forEach((thread, index) => console.log(formatThreadLabel(thread, index)));
  await Deno.stdout.write(new TextEncoder().encode('resume> '));
  const selection = (await readLine())?.trim();
  if (!selection) return undefined;

  const selectedIndex = Number.parseInt(selection, 10) - 1;
  const selected = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < threads.length
    ? threads[selectedIndex]
    : threads.find(thread => thread.id === selection);
  if (!selected) {
    console.log('Invalid selection.');
    return undefined;
  }

  const messages = await listMessages(server, token, selected.id);
  console.log(`\nResumed: ${selected.title ?? selected.id}`);
  printMessages(messages);
  return { threadId: selected.id, messages };
};

const chatLoop = async (server: string, token: string, resolved: ResolvedWorkspace, initialMessages: ChatMessage[]) => {
  const seenMessageIds = new Set<string>();
  let threadId = resolved.thread?.id;
  let poller = threadId ? createIdlePoller(server, token, threadId, seenMessageIds) : undefined;
  poller?.prime(initialMessages);

  const readLine = createLineReader();
  const switchPoller = (nextThreadId: string, messages: ChatMessage[]) => {
    poller?.stop();
    seenMessageIds.clear();
    threadId = nextThreadId;
    poller = createIdlePoller(server, token, nextThreadId, seenMessageIds);
    poller.prime(messages);
  };

  try {
    while (true) {
      const text = (await promptInput(readLine))?.trim();
      if (!text) continue;
      if (text === '/quit' || text === '/exit') {
        poller?.stop();
        console.log('bye');
        Deno.exit(0);
      }
      if (text === '/new') {
        poller?.stop();
        poller = undefined;
        seenMessageIds.clear();
        threadId = undefined;
        resolved.thread = undefined;
        console.log('\nNew thread draft. Server thread will be created on first message.');
        continue;
      }
      if (text === '/resume') {
        const resumed = await resumeThread(server, token, resolved, readLine);
        if (resumed) switchPoller(resumed.threadId, resumed.messages);
        continue;
      }

      if (!threadId) {
        const planeId = resolved.plane?.id;
        if (!planeId) throw new Error('resolved workspace missing plane.id');
        threadId = await createThread(server, token, planeId, resolved.demiplane?.id);
        console.log(`Thread: ${threadId}`);
        switchPoller(threadId, []);
      }

      await streamChat(server, token, threadId, text);
      const messages = await listMessages(server, token, threadId).catch(() => []);
      poller?.prime(messages);
    }
  } finally {
    poller?.stop();
  }
};

const start = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const config = await readConfig(configPath);
  const server = normalizeHttpUrl(stringFlag(flags, 'server') ?? config.httpServerUrl ?? defaultServerUrl);
  const token = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN') ?? config.authToken;
  if (!token) throw new Error('Missing auth token. Run login, pass --token, or set WEAVE_AUTH_TOKEN.');

  const workspace = await detectWorkspace();
  const response = await apiFetch(server, token, '/planes/resolve-workspace', {
    method: 'POST',
    body: JSON.stringify({ ...workspace, createThread: false }),
  });
  const resolved = await response.json() as Record<string, any>;
  if (!resolved.resolved) {
    console.error('No Plane/Demiplane resolved for cwd. Open web client or connect Portal, then try again.');
    if (resolved.needsConfirmation) console.error('Remote matched but needs confirmation in web client.');
    Deno.exit(1);
  }

  if (resolved.offline) console.log('[offline] Portal offline. Chat works; local tools unavailable until reconnect.');
  if (resolved.adopted) console.log(`[adopted] ${resolved.demiplane?.path}`);
  console.log(`Plane: ${resolved.plane?.name} / ${resolved.demiplane?.name}`);
  if (resolved.thread?.id) console.log(`Thread: ${resolved.thread.id}`);
  else console.log('Thread: not created until first message');

  const messages = resolved.thread?.id ? await listMessages(server, token, resolved.thread.id) : [];
  printMessages(messages);
  await chatLoop(server, token, resolved, messages);
};

const login = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const server = normalizeHttpUrl(stringFlag(flags, 'server') ?? defaultServerUrl);
  const token = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN');
  if (!token) throw new Error('Missing auth token. Pass --token or set WEAVE_AUTH_TOKEN.');
  await writeConfig(configPath, { httpServerUrl: server, authToken: token });
  console.log(`TUI config: ${configPath}`);
};

const usage = () => {
  console.log(`weave-tui

Commands:
  login --server http://localhost:4111 --token <auth-token>
  start [--server http://localhost:4111] [--token <auth-token>]

Inside chat: /new starts a draft thread. /resume lists demiplane threads. /quit exits.
`);
};

const main = async () => {
  const { command, flags } = parseArgs(Deno.args);
  if (command === 'login') return login(flags);
  if (!command || command === 'start') return start(flags);
  usage();
  Deno.exit(1);
};

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}
