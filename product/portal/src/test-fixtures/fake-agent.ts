import { writeText } from '../host-files.ts';
import { stdinStream, stdoutStream } from '../local-stream.ts';
import { type JsonRpcMessage, parseJsonRpcMessage, result } from '../json-rpc.ts';
import { readLines } from '../line-stream.ts';

const encoder = new TextEncoder();
const writer = stdoutStream().getWriter();
const send = async (message: JsonRpcMessage) => await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
const staleSession = process.argv.find((value) => value.startsWith('--emit-stale='))?.slice('--emit-stale='.length);
if (staleSession) {
  await Bun.sleep(75);
  await send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: staleSession,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OBSOLETE_PROVIDER_EVENT' } } } });
  process.exit(0);
}
const recoveryMode = process.argv.slice(2).find((value) => value.startsWith('--recovery='))?.slice('--recovery='.length) ?? 'load';
const replaysTranscript = process.argv.slice(2).includes('--replay-transcript');
const processLog = process.argv.slice(2).find((value) => value.startsWith('--process-log='))?.slice('--process-log='.length);
const transcript: JsonRpcMessage[] = [];
let resumeAttempted = false;
let permissionPromptId: string | number | null | undefined;
let restoredWith = '';
let activeSessionId = 'fake-session';

if (processLog) {
  await writeText(processLog, `start ${process.pid}\n`, { append: true, create: true });
  process.on('SIGTERM', async () => {
    await writeText(processLog, `stop ${process.pid}\n`, { append: true, create: true });
    process.exit();
  });
}

for await (const line of readLines(stdinStream())) {
  if (!line.trim()) continue;
  const message = parseJsonRpcMessage(line);
  if (message.id === 'ui-permission' && permissionPromptId !== undefined) {
    const accepted = (message.result as { outcome?: { optionId?: string } })?.outcome?.optionId === 'allow-once';
    await send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: activeSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: accepted ? 'PERMISSION_ACCEPTED' : 'PERMISSION_DENIED' } } } });
    await send(result(permissionPromptId, { stopReason: 'end_turn' }));
    permissionPromptId = undefined;
    continue;
  }
  if (message.id === undefined || !message.method) continue;
  if (message.method === 'initialize') {
    await send(result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        ...(recoveryMode === 'none' ? {} : { loadSession: true }),
        ...(recoveryMode === 'resume-fails-then-load' ? { sessionCapabilities: { resume: {} } } : {}),
      },
      agentInfo: { name: 'Fake ACP Agent', version: '1.0.0' },
    }));
    continue;
  }
  if (message.method === 'session/new') {
    activeSessionId = recoveryMode === 'missing-session' ? 'replacement-session' : 'fake-session';
    await send(result(message.id, {
      sessionId: activeSessionId,
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
      },
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: false,
      }],
    }));
    continue;
  }
  if (message.method === 'session/resume') {
    resumeAttempted = true;
    if (recoveryMode === 'missing-session') {
      await send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Fake session is missing.' } });
      continue;
    }
    activeSessionId = (message.params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId;
    await send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Fake resume failed.' } });
    continue;
  }
  if (message.method === 'session/load') {
    if (recoveryMode === 'missing-session') {
      await send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Fake session is missing.' } });
      continue;
    }
    activeSessionId = (message.params as { sessionId?: string } | undefined)?.sessionId ?? activeSessionId;
    restoredWith = resumeAttempted ? 'LOAD_AFTER_RESUME' : 'LOAD';
    if (replaysTranscript) {
      for (const update of transcript) await send(update);
    }
    if (recoveryMode === 'resume-fails-then-load') {
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'PROVIDER_REPLAY_SHOULD_NOT_ESCAPE' },
          },
        },
      });
    }
    await send(result(message.id, {
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
      },
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: false,
      }],
    }));
    continue;
  }
  if (message.method === 'session/set_mode') {
    await send(result(message.id, {}));
    continue;
  }
  if (message.method === 'session/set_config_option') {
    const configOptions = [{
      type: 'boolean',
      id: 'fast',
      name: 'Fast mode',
      currentValue: true,
    }];
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      },
    });
    await send(result(message.id, { configOptions }));
    continue;
  }
  if (message.method === 'session/prompt') {
    const prompt = (message.params as { prompt?: Array<{ text?: unknown }> } | undefined)?.prompt
      ?.map((content) => typeof content.text === 'string' ? content.text : '')
      .join('') ?? '';
    if (prompt === 'UI_PERMISSION' || prompt === 'UI_PERMISSION_AFTER_DETACH') {
      if (prompt === 'UI_PERMISSION_AFTER_DETACH') await new Promise((resolve) => setTimeout(resolve, 200));
      permissionPromptId = message.id;
      await send({ jsonrpc: '2.0', id: 'ui-permission', method: 'session/request_permission', params: {
        sessionId: activeSessionId, toolCall: { toolCallId: 'acceptance-permission', title: 'Acceptance permission', kind: 'read', status: 'pending' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
      } });
      continue;
    }
    const renamedTitle = prompt.startsWith('RENAME_TO:') ? prompt.slice('RENAME_TO:'.length) : undefined;
    const titleUpdate = renamedTitle !== undefined
      ? { sessionId: activeSessionId, title: renamedTitle }
      : prompt === 'CLEAR_TITLE'
      ? { sessionId: activeSessionId, title: null }
      : prompt.startsWith('RENAME_WRONG_SESSION_TO:')
      ? {
        sessionId: 'wrong-session',
        title: prompt.slice('RENAME_WRONG_SESSION_TO:'.length),
      }
      : undefined;
    if (titleUpdate) {
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: titleUpdate.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: titleUpdate.title,
          },
        },
      });
    }
    if (prompt.includes('CRASH_WITH_STALE')) {
      Bun.spawn([process.execPath, ...(import.meta.path.startsWith('/$bunfs/') ? [] : [import.meta.path]),
        `--emit-stale=${activeSessionId}`,
      ], { stdin: 'ignore', stdout: 'inherit', stderr: 'ignore' });
      process.exit(17);
    }
    if (prompt.includes('CRASH_AFTER')) process.exit(17);
    if (prompt.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 100));
    const userUpdate: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          messageId: 'provider-user-message',
          content: {
            type: 'text',
            text: prompt,
            annotations: { audience: ['assistant'] },
          },
        },
      },
    };
    const agentUpdate: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `FAKE_AGENT${restoredWith ? `_${restoredWith}` : ''}:${prompt}` },
        },
      },
    };
    transcript.push(userUpdate, agentUpdate);
    await send(userUpdate);
    await send(agentUpdate);
    await send(result(message.id, { stopReason: 'end_turn' }));
  }
}

if (processLog) {
  await writeText(processLog, `stop ${process.pid}\n`, { append: true, create: true });
}
