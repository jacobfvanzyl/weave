import { ProcessTerminal, TUI } from 'pi-tui';
import { archiveThread, createThread, getContextUsage, isConnectionError, listDemiplaneThreads, listMessages, listPortals, normalizeHttpUrl, resolveWorkspace, streamChat } from './api.ts';
import { WeaveApp } from './components/app.ts';
import { ResumeList } from './components/resume-list.ts';
import { defaultConfigPath, defaultServerUrl, parseArgs, readConfig, stringFlag, writeConfig } from './config.ts';
import { detectWorkspace } from './git.ts';
import { chatMessageToRenderMessages, getMessagesVersion, renameTitleFromMessages, renderTranscriptMessage } from './messages.ts';
import { fetchModelConfig, getResolvedModelContextWindow, getResolvedModelDisplayName } from './models.ts';
import { formatToolCall, renderMarkdown } from './rendering.ts';
import type { AppState, ChatMessage, RenderMessage, ResolvedWorkspace, TokenUsage } from './types.ts';

const stderrIsTerminal = () => (Deno.stderr as unknown as { isTerminal?: () => boolean }).isTerminal?.() ?? false;

const printStartupConnectionError = (server: string) => {
  const message = `Not Connected: unable to reach ${server}`;
  console.error(stderrIsTerminal() ? `\x1b[2J\x1b[H${message}` : message);
};

const createIdlePoller = (
  server: string,
  token: string,
  threadId: string,
  seenMessageIds: Set<string>,
  onMessages?: (messages: ChatMessage[]) => void,
  onConnectionError?: (error: unknown) => void,
  onConnected?: () => void,
) => {
  let running = false;
  let messagesVersion = '';

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const messages = await listMessages(server, token, threadId);
      onConnected?.();
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
      if (isConnectionError(error)) onConnectionError?.(error);
      else console.error(`\n[refresh failed] ${error instanceof Error ? error.message : String(error)}`);
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

const chatLoop = async (server: string, token: string, resolved: ResolvedWorkspace, initialMessages: ChatMessage[], model: string, modelDisplayName: string, modelContextWindow?: number) => {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const titleFor = (threadTitle?: string) => ({
    plane: resolved.adHoc ? undefined : resolved.plane?.name ?? 'Plane',
    demiplane: resolved.demiplane?.name,
    thread: threadTitle && !['...', 'New chat'].includes(threadTitle) ? threadTitle : undefined,
  });
  const usageTotalTokens = (usage: TokenUsage | undefined) => usage?.totalTokens
    ?? ((usage?.inputTokens ?? usage?.promptTokens ?? 0) + (usage?.outputTokens ?? usage?.completionTokens ?? 0));
  const updateContextFromUsage = (usage: TokenUsage | undefined) => {
    const tokens = usageTotalTokens(usage);
    if (!tokens || !modelContextWindow) return;
    state.contextPercent = Math.min(100, (tokens / modelContextWindow) * 100);
  };
  const markConnected = () => {
    state.connectionStatus = 'connected';
  };
  const markConnectionError = (error: unknown) => {
    if (!isConnectionError(error)) return false;
    state.connectionStatus = 'not-connected';
    return true;
  };

  const state: AppState = {
    modelDisplayName,
    connectionStatus: resolved.offline ? 'not-connected' : 'connected',
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
  let ctrlCTimer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof createIdlePoller> | undefined;
  let assistantSpinnerTimer: ReturnType<typeof setInterval> | undefined;
  const requestRender = () => tui.requestRender();
  const stopAssistantSpinner = (assistant?: RenderMessage) => {
    if (assistant?.type === 'assistant') assistant.pending = false;
    if (assistantSpinnerTimer) {
      clearInterval(assistantSpinnerTimer);
      assistantSpinnerTimer = undefined;
    }
  };
  const startAssistantSpinner = (assistant: RenderMessage) => {
    stopAssistantSpinner();
    if (assistant.type !== 'assistant') return;
    assistant.pending = true;
    assistant.spinnerFrame = 0;
    assistantSpinnerTimer = setInterval(() => {
      assistant.spinnerFrame = ((assistant.spinnerFrame ?? 0) + 1) % 10;
      requestRender();
    }, 80);
  };
  const refreshContextUsage = async () => {
    if (!threadId) {
      state.contextPercent = undefined;
      return;
    }
    try {
      const usage = await getContextUsage(server, token, threadId, modelContextWindow);
      markConnected();
      if (typeof usage.percent === 'number' && usage.percent > 0) state.contextPercent = usage.percent;
    } catch (error) {
      if (!markConnectionError(error)) throw error;
    }
  };
  if (threadId) void refreshContextUsage().finally(requestRender);
  const setThreadTitle = (threadTitle: string) => {
    if (!threadTitle.trim()) return;
    state.title = titleFor(threadTitle.trim());
  };
  const addMessages = (messages: ChatMessage[]) => {
    setThreadTitle(renameTitleFromMessages(messages));
    state.messages.push(...messages.flatMap(chatMessageToRenderMessages));
    void refreshContextUsage().finally(requestRender);
  };
  const switchPoller = (nextThreadId: string, messages: ChatMessage[]) => {
    poller?.stop();
    seenMessageIds.clear();
    threadId = nextThreadId;
    poller = createIdlePoller(
      server,
      token,
      nextThreadId,
      seenMessageIds,
      addMessages,
      error => {
        markConnectionError(error);
        requestRender();
      },
      () => {
        markConnected();
        requestRender();
      },
    );
    poller.prime(messages);
  };
  const resetToDraftThread = () => {
    poller?.stop();
    poller = undefined;
    seenMessageIds.clear();
    threadId = undefined;
    resolved.thread = undefined;
    state.title = titleFor();
    state.messages = [];
    state.contextPercent = undefined;
  };
  if (threadId) switchPoller(threadId, initialMessages);

  const stop = async (code = 0) => {
    poller?.stop();
    stopAssistantSpinner();
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
        resetToDraftThread();
        requestRender();
        return;
      }
      if (trimmed === '/archive') {
        if (!threadId) {
          resetToDraftThread();
          state.status = 'No current thread to archive.';
          requestRender();
          return;
        }
        busy = true;
        state.status = 'Archiving thread...';
        requestRender();
        try {
          await archiveThread(server, token, threadId);
          markConnected();
          resetToDraftThread();
          state.status = undefined;
        } catch (error) {
          if (markConnectionError(error)) state.status = undefined;
          else state.status = error instanceof Error ? error.message : String(error);
        } finally {
          busy = false;
          requestRender();
        }
        return;
      }
      if (trimmed === '/threads') {
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
          markConnected();
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
                markConnected();
                state.title = titleFor(selected.title);
                setThreadTitle(renameTitleFromMessages(messages));
                state.messages = messages.flatMap(chatMessageToRenderMessages);
                resolved.thread = { id: selected.id };
                switchPoller(selected.id, messages);
                await refreshContextUsage();
                state.status = undefined;
              } catch (error) {
                if (markConnectionError(error)) state.status = undefined;
                else state.status = error instanceof Error ? error.message : String(error);
              } finally {
                busy = false;
                requestRender();
              }
            })();
          }, closeOverlay);
          overlay = tui.showOverlay(resumeList, { anchor: 'bottom-center', width: '90%', maxHeight: '50%', margin: { bottom: 6 } });
          requestRender();
        } catch (error) {
          if (markConnectionError(error)) state.status = undefined;
          else state.status = error instanceof Error ? error.message : String(error);
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
          markConnected();
          state.title = titleFor();
          switchPoller(threadId, []);
        }
        const assistant: RenderMessage = { type: 'assistant', rawText: '', pending: true, spinnerFrame: 0 };
        state.messages.push(assistant);
        startAssistantSpinner(assistant);
        await streamChat(
          server,
          token,
          threadId,
          trimmed,
          model,
          delta => {
            stopAssistantSpinner(assistant);
            assistant.rawText += delta;
            requestRender();
          },
          (toolName, toolCallId, input, output, isError) => {
            const existing = toolCallId ? state.messages.find(message => message.type === 'tool' && message.toolCallId === toolCallId) : undefined;
            if (existing?.type === 'tool') {
              existing.toolName = toolName ?? existing.toolName;
              if (input !== undefined) existing.input = input;
              if (output !== undefined) existing.output = output;
              if (isError !== undefined) existing.isError = isError;
            } else {
              state.messages.splice(state.messages.length - 1, 0, { type: 'tool', toolName: toolName ?? 'tool', toolCallId, input, output, isError });
            }
            requestRender();
          },
          title => {
            setThreadTitle(title);
            requestRender();
          },
          updateContextFromUsage,
          () => {
            stopAssistantSpinner(assistant);
            assistant.renderedText = assistant.rawText.trim() ? renderMarkdown(assistant.rawText) : undefined;
            void refreshContextUsage().finally(requestRender);
          },
        );
        markConnected();
        const messages = await listMessages(server, token, threadId).catch(error => {
          markConnectionError(error);
          return [];
        });
        if (messages.length > 0) {
          state.messages = messages.flatMap(chatMessageToRenderMessages);
          requestRender();
        }
        setThreadTitle(renameTitleFromMessages(messages));
        poller?.prime(messages);
      } catch (error) {
        stopAssistantSpinner();
        if (markConnectionError(error)) state.status = undefined;
        else state.status = error instanceof Error ? error.message : String(error);
        requestRender();
      } finally {
        stopAssistantSpinner();
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
  const modelConfig = await fetchModelConfig(server, token);
  const model = modelConfig.defaultModel;
  const modelDisplayName = getResolvedModelDisplayName(model, modelConfig.options);
  const modelContextWindow = getResolvedModelContextWindow(model, modelConfig.options);

  const workspace = await detectWorkspace();
  const configuredPortalId = stringFlag(flags, 'portal') ?? config.portalId;
  const portals = await listPortals(server, token).catch(() => []);
  const onlinePortals = portals.filter(portal => portal.status === 'online');
  const portalId = configuredPortalId ?? (onlinePortals.length === 1 ? onlinePortals[0].portalId : undefined);
  if (!portalId) {
    const choices = onlinePortals.map(portal => `- ${portal.portalId}${portal.name ? ` (${portal.name})` : ''}`).join('\n');
    console.error(`No Portal selected. Pass --portal <portalId>${choices ? `\nOnline portals:\n${choices}` : ''}`);
    Deno.exit(1);
  }
  const resolved = await resolveWorkspace(server, token, workspace, portalId).catch(error => {
    if (isConnectionError(error)) {
      printStartupConnectionError(server);
      Deno.exit(1);
    }
    throw error;
  });
  if (!resolved.resolved) {
    console.error('No Plane/Demiplane resolved for cwd. Open web client or connect Portal, then try again.');
    if (resolved.needsConfirmation) console.error('Remote matched but needs confirmation in web client.');
    Deno.exit(1);
  }

  const messages = resolved.thread?.id ? await listMessages(server, token, resolved.thread.id) : [];
  if (resolved.offline) messages.unshift({ id: 'offline', role: 'system', parts: [{ type: 'text', text: '[offline] Portal offline. Chat works; local tools unavailable until reconnect.' }] });
  if (resolved.adopted) messages.unshift({ id: 'adopted', role: 'system', parts: [{ type: 'text', text: `[adopted] ${resolved.demiplane?.path}` }] });
  await chatLoop(server, token, resolved, messages, model, modelDisplayName, modelContextWindow);
};

const login = async (flags: Record<string, string | boolean>) => {
  const configPath = stringFlag(flags, 'config') ?? defaultConfigPath;
  const server = normalizeHttpUrl(stringFlag(flags, 'server') ?? defaultServerUrl);
  const token = stringFlag(flags, 'token') ?? Deno.env.get('WEAVE_AUTH_TOKEN');
  if (!token) throw new Error('Missing auth token. Pass --token or set WEAVE_AUTH_TOKEN.');
  await writeConfig(configPath, { ...(await readConfig(configPath)), httpServerUrl: server, authToken: token });
  console.log(`TUI config: ${configPath}`);
};

const usage = () => {
  console.log(`weave-tui

Commands:
  login --server http://localhost:4111 --token <auth-token>
  start [--server http://localhost:4111] [--token <auth-token>] [--portal <portalId>]

Config: ~/.config/weave/config.json (or $XDG_CONFIG_HOME/weave/config.json)

Inside chat: /new starts a draft thread. /archive archives current thread and starts a draft. /threads lists demiplane threads. Ctrl+C twice exits.
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
