import { afterEach, expect, it, vi } from 'vitest';
import { DirectHostClient } from './portal-client';
const sessions = vi.hoisted(() => [] as Array<any>);
vi.mock('@/chat/acp-client', () => ({ AcpSessionClient: class {
  initializeAndLoad = vi.fn(async () => {}); prompt = vi.fn(async () => {}); cancel = vi.fn(async () => {});
  respondToPermission = vi.fn(() => true); respondToElicitation = vi.fn(() => true);
  setMode = vi.fn(async () => {}); setConfigOption = vi.fn(async () => {}); close = vi.fn();
  constructor(readonly options: any) { sessions.push(this); }
} }));
class Socket { close() {} send() {} }
afterEach(() => { vi.unstubAllGlobals(); sessions.length = 0; });
function setup() {
  vi.stubGlobal('WebSocket', Socket);
  const events = vi.fn();
  const client = new DirectHostClient('127.0.0.1', { hostId: 'host', credentialId: 'credential', sign: async () => 'signature' }, events);
  const request = vi.spyOn(client as any, 'request').mockImplementation(async (...args: any[]) => {
    const [method, params] = args;
    const thread = { threadId: params.threadId, acpSessionId: `session-${params.threadId}` };
    return method === 'thread.attach' ? { thread, connection: { path: '/acp', threadId: params.threadId, cwd: '/project' } } : { thread };
  });
  return { client, request, events };
}
it('keeps concurrent Agent Panes attached and routes every ACP action and event by Thread', async () => {
  const { client, request, events } = setup();
  try {
    await Promise.all([client.attach('first'), client.attach('second'), client.attach('first')]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sessions).toHaveLength(2);
    const [first, second] = sessions;
    expect(first.close).not.toHaveBeenCalled();
    const content = [{ type: 'text' as const, text: 'first command' }];
    await client.prompt(content, 'first'); await client.cancelPrompt('first');
    client.respondToPermission('same-request-id', 'allow', 'first');
    client.respondToElicitation('same-request-id', { action: 'cancel' }, 'first');
    await client.setMode('plan', 'first'); await client.setConfigOption('model', 'chosen', 'first');
    expect(first.prompt).toHaveBeenCalledWith(content); expect(second.prompt).not.toHaveBeenCalled();
    expect(first.cancel).toHaveBeenCalledOnce(); expect(second.cancel).not.toHaveBeenCalled();
    expect(first.respondToPermission).toHaveBeenCalledWith('same-request-id', { outcome: 'selected', optionId: 'allow' });
    expect(second.respondToPermission).not.toHaveBeenCalled();
    expect(first.respondToElicitation).toHaveBeenCalledWith('same-request-id', { action: 'cancel' });
    expect(first.setMode).toHaveBeenCalledWith('plan'); expect(first.setConfigOption).toHaveBeenCalledWith('model', 'chosen');
    const event = { type: 'turn/started' }; first.options.onEvent(event);
    expect(events).toHaveBeenLastCalledWith(event, 'first');
    await client.archiveThread('first');
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).not.toHaveBeenCalled();
    await expect(client.prompt(content, 'first')).rejects.toThrow('this Thread');
    await client.prompt(content, 'second'); expect(second.prompt).toHaveBeenCalledWith(content);
  } finally { client.close(); }
  expect(sessions[1].close).toHaveBeenCalledOnce();
});
it('does not open a late attachment after the Host connection closes', async () => {
  const { client, request } = setup();
  let release!: (value: any) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const attach = client.attach('late');
  client.close();
  release({ thread: { threadId: 'late' }, connection: {} });
  await expect(attach).rejects.toThrow('closed');
  expect(sessions).toHaveLength(0);
});
