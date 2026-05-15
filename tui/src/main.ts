import { ProcessTerminal, TUI } from 'pi-tui';
import { createThread, getContextUsage, listDemiplaneThreads, listMessages, normalizeHttpUrl, resolveWorkspace, streamChat } from './api.ts';
import { WeaveApp } from './components/app.ts';
import { ResumeList } from './components/resume-list.ts';
import { defaultConfigPath, defaultServerUrl, parseArgs, readConfig, stringFlag, writeConfig } from './config.ts';
import { detectWorkspace } from './git.ts';
import { chatMessageToRenderMessages, getMessagesVersion, renderTranscriptMessage } from './messages.ts';
import { defaultModel, fallbackModelOptions, fetchModelOptions, getResolvedModelDisplayName } from './models.ts';
import { formatToolCall, renderMarkdown } from './rendering.ts';
import type { AppState, ChatMessage, RenderMessage, ResolvedWorkspace } from './types.ts';

const createIdlePoller = (server: string, token: string, threadId: string, seenMessageIds: Set<string>, onMessages?: (messages: ChatMessage[]) => void) => {
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
          for (const message of unseenMessages) seenMessageIds.add(message.id);
          onMessages?.(unseenMessages);
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

const chatLoop = async (server: string, token: string, resolved: ResolvedWorkspace, initialMessages: ChatMessage[], model: string, modelDisplayName: string) => {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const titleFor = (threadTitle?: string) => ({
    plane: resolved.plane?.name ?? 'Plane',
    demiplane: resolved.demiplane?.name,
    thread: threadTitle && !['...', 'New chat'].includes(threadTitle) ? threadTitle : undefined,
  });
  const state: AppState = {
    modelDisplayName,
    contextPercent: 0,
    title: titleFor(),
    messages: initialMessages.flatMap(chatMessageToRenderMessages),
  };
  const app = new WeaveApp(tui, state);
  tui.addChild(app);
  tui.setFocus(app);

  const seenMessageIds = new Set<string>();
  let threadId = resolved.thread?.id;
  let busy = false;
  let ctrlCArmed = false;
  let ctrlCTimer: number | undefined;
  let poller: ReturnType<typeof createIdlePoller> | undefined;
  const requestRender = () => tui.requestRender();
  const refreshContextUsage = async () => {
    if (!threadId) {
      state.contextPercent = undefined;
      return;
    }
    const usage = await getContextUsage(server, token, threadId);
    state.contextPercent = usage.percent;
  };
  if (threadId) void refreshContextUsage().finally(requestRender);
  const addMessages = (messages: ChatMessage[]) => {
    state.messages.push(...messages.flatMap(chatMessageToRenderMessages));
    void refreshContextUsage().finally(requestRender);
  };
  const switchPoller = (nextThreadId: string, messages: ChatMessage[]) => {
    poller?.stop();
    seenMessageIds.clear();
    threadId = nextThreadId;
    poller = createIdlePoller(server, token, nextThreadId, seenMessageIds, addMessages);
    poller.prime(messages);
  };
  if (threadId) switchPoller(threadId, initialMessages);

  const stop = async (code = 0) => {
    poller?.stop();
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    tui.stop();
    await terminal.drainInput().catch(() => undefined);
    Deno.exit(code);
  };

  app.onCancel = () => {
    if (ctrlCArmed) {
      void stop(0);
      return;
    }
    ctrlCArmed = true;
    state.status = 'Press Ctrl+C again to exit.';
    requestRender();
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => {
      ctrlCArmed = false;
      if (state.status === 'Press Ctrl+C again to exit.') state.status = undefined;
      requestRender();
    }, 2000);
  };

  app.onSubmit = text => {
    void (async () => {
      const trimmed = text.trim();
      app.clearEditor();
      requestRender();
      if (!trimmed || busy) return;
      if (trimmed === '/new') {
        poller?.stop();
        poller = undefined;
        seenMessageIds.clear();
        threadId = undefined;
        resolved.thread = undefined;
        state.title = titleFor();
        state.messages = [];
        state.contextPercent = undefined;
        requestRender();
        return;
      }
      if (trimmed === '/resume') {
        const planeId = resolved.plane?.id;
        if (!planeId) {
          state.status = 'Resolved workspace missing plane.id';
          requestRender();
          return;
        }
        busy = true;
        state.status = 'Loading threads...';
        requestRender();
        try {
          const threads = await listDemiplaneThreads(server, token, planeId, resolved.demiplane?.id);
          state.status = undefined;
          if (threads.length === 0) {
            state.status = 'No threads in this demiplane.';
            requestRender();
            return;
          }
          let overlay: ReturnType<TUI['showOverlay']> | undefined;
          const closeOverlay = () => {
            overlay?.hide();
            tui.setFocus(app);
            requestRender();
          };
          const resumeList = new ResumeList(threads, selected => {
            void (async () => {
              closeOverlay();
              busy = true;
              state.status = `Resuming ${selected.title ?? selected.id}...`;
              requestRender();
              try {
                const messages = await listMessages(server, token, selected.id);
                state.title = titleFor(selected.title);
                state.messages = messages.flatMap(chatMessageToRenderMessages);
                resolved.thread = { id: selected.id };
                switchPoller(selected.id, messages);
                await refreshContextUsage();
                state.status = undefined;
              } catch (error) {
                state.status = error instanceof Error ? error.message : String(error);
              } finally {
                busy = false;
                requestRender();
              }
            })();
          }, closeOverlay);
          overlay = tui.showOverlay(resumeList, { anchor: 'bottom-center', width: '90%', maxHeight: '50%', margin: { bottom: 6 } });
          requestRender();
        } catch (error) {
          state.status = error instanceof Error ? error.message : String(error);
        } finally {
          busy = false;
          requestRender();
        }
        return;
      }

      busy = true;
      app.addToHistory(trimmed);
      try {
        state.status = undefined;
        state.messages.push({ type: 'user', text: trimmed });
        requestRender();
        if (!threadId) {
          const planeId = resolved.plane?.id;
          if (!planeId) throw new Error('resolved workspace missing plane.id');
          threadId = await createThread(server, token, planeId, resolved.demiplane?.id);
          state.title = titleFor();
          switchPoller(threadId, []);
        }
        const assistant: RenderMessage = { type: 'assistant', rawText: '' };
        state.messages.push(assistant);
        await streamChat(
          server,
          token,
          threadId,
          trimmed,
          model,
          delta => {
            assistant.rawText += delta;
            requestRender();
          },
          (toolName, toolCallId) => {
            state.messages.splice(state.messages.length - 1, 0, { type: 'tool', toolName: toolName ?? 'tool', toolCallId });
            requestRender();
          },
          usage => {
            void usage;
          },
          () => {
            assistant.renderedText = assistant.rawText.trim() ? renderMarkdown(assistant.rawText) : undefined;
            void refreshContextUsage().finally(requestRender);
          },
        );
        const messages = await listMessages(server, token, threadId).catch(() => []);
        poller?.prime(messages);
      } catch (error) {
        state.status = error instanceof Error ? error.message : String(error);
        requestRender();
      } finally {
        busy = false;
      }
    })();
  };

  try {
    tui.start();
    tui.requestRender(true);
    await new Promise(() => undefined);
  } finally {
    poller?.stop();
    tui.stop();
  }
};

const start = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const config = await readConfig(configPath);
  const server = normalizeHttpUrl(stringFlag(flags, 'server') ?? config.httpServerUrl ?? defaultServerUrl);
  const token = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN') ?? config.authToken;
  if (!token) throw new Error('Missing auth token. Run login, pass --token, or set WEAVE_AUTH_TOKEN.');
  const model = stringFlag(flags, 'model') ?? Deno.env.get('WEAVE_MODEL') ?? config.model ?? defaultModel;
  const modelOptions = await fetchModelOptions().catch(() => fallbackModelOptions);
  const modelDisplayName = getResolvedModelDisplayName(model, modelOptions);

  const workspace = await detectWorkspace();
  const resolved = await resolveWorkspace(server, token, workspace);
  if (!resolved.resolved) {
    console.error('No Plane/Demiplane resolved for cwd. Open web client or connect Portal, then try again.');
    if (resolved.needsConfirmation) console.error('Remote matched but needs confirmation in web client.');
    Deno.exit(1);
  }

  const messages = resolved.thread?.id ? await listMessages(server, token, resolved.thread.id) : [];
  if (resolved.offline) messages.unshift({ id: 'offline', role: 'system', parts: [{ type: 'text', text: '[offline] Portal offline. Chat works; local tools unavailable until reconnect.' }] });
  if (resolved.adopted) messages.unshift({ id: 'adopted', role: 'system', parts: [{ type: 'text', text: `[adopted] ${resolved.demiplane?.path}` }] });
  await chatLoop(server, token, resolved, messages, model, modelDisplayName);
};

const login = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const server = normalizeHttpUrl(stringFlag(flags, 'server') ?? defaultServerUrl);
  const token = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN');
  if (!token) throw new Error('Missing auth token. Pass --token or set WEAVE_AUTH_TOKEN.');
  const model = stringFlag(flags, 'model') ?? Deno.env.get('WEAVE_MODEL');
  await writeConfig(configPath, { httpServerUrl: server, authToken: token, ...(model ? { model } : {}) });
  console.log(`TUI config: ${configPath}`);
};

const usage = () => {
  console.log(`weave-tui

Commands:
  login --server http://localhost:4111 --token <auth-token> [--model openai/gpt-5.5]
  start [--server http://localhost:4111] [--token <auth-token>] [--model openai/gpt-5.5]

Inside chat: /new starts a draft thread. /resume lists demiplane threads. Ctrl+C twice exits.
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
