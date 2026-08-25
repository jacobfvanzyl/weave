import { type JsonRpcMessage, parseJsonRpcMessage, result } from '../json-rpc.ts';
import { readLines } from '../line-stream.ts';

const encoder = new TextEncoder();
const writer = Deno.stdout.writable.getWriter();
const send = async (message: JsonRpcMessage) => await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
const recoveryMode = Deno.args.find((value) => value.startsWith('--recovery='))?.slice('--recovery='.length) ?? 'load';
const replaysTranscript = Deno.args.includes('--replay-transcript');
const transcript: JsonRpcMessage[] = [];
let resumeAttempted = false;
let restoredWith = '';

for await (const line of readLines(Deno.stdin.readable)) {
  if (!line.trim()) continue;
  const message = parseJsonRpcMessage(line);
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
    await send(result(message.id, {
      sessionId: 'fake-session',
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
    await send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Fake resume failed.' } });
    continue;
  }
  if (message.method === 'session/load') {
    restoredWith = resumeAttempted ? 'LOAD_AFTER_RESUME' : 'LOAD';
    if (replaysTranscript) {
      for (const update of transcript) await send(update);
    }
    if (recoveryMode === 'resume-fails-then-load') {
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fake-session',
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
        sessionId: 'fake-session',
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
    if (prompt.includes('CRASH_WITH_STALE')) {
      new Deno.Command(Deno.execPath(), {
        args: [
          'eval',
          `await new Promise((resolve) => setTimeout(resolve, 75)); console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fake-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OBSOLETE_PROVIDER_EVENT'}}}}));`,
        ],
        stdin: 'null',
        stdout: 'inherit',
        stderr: 'null',
      }).spawn();
      Deno.exit(17);
    }
    if (prompt.includes('CRASH_AFTER')) Deno.exit(17);
    if (prompt.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 100));
    const userUpdate: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
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
        sessionId: 'fake-session',
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
