import { afterEach, describe, expect, it, vi } from 'vitest';
import { canConnectChatGPT, connectChatGPT } from '../../packages/client/src/lib/chatgpt-auth-api';

afterEach(() => vi.unstubAllGlobals());

describe('ChatGPT client login adapter', () => {
  it('requires Weave Desktop when no login bridge is available', async () => {
    vi.stubGlobal('window', {});
    expect(canConnectChatGPT()).toBe(false);
    await expect(connectChatGPT()).rejects.toThrow(/Weave Desktop/);
  });

  it('returns only server auth status through the Desktop bridge', async () => {
    const connect = vi.fn(async () => ({ connected: true, accountId: 'account-1', expires: 123 }));
    vi.stubGlobal('window', { weaveDesktop: { connectChatGPT: connect } });
    expect(canConnectChatGPT()).toBe(true);
    await expect(connectChatGPT()).resolves.toEqual({ connected: true, accountId: 'account-1', expires: 123 });
    expect(connect).toHaveBeenCalledOnce();
  });
});
