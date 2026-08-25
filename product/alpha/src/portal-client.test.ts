import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectHostClient } from './portal-client';

class FakeWebSocket {
  static instance: FakeWebSocket;

  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;

  constructor() {
    FakeWebSocket.instance = this;
  }

  send() {}

  close(code = 1000, reason = '') {
    this.onclose?.({ code, reason });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('DirectHostClient', () => {
  it('reports an unexpected Portal transport closure without reporting an intentional disconnect', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onClose = vi.fn();
    const first = new DirectHostClient('127.0.0.1', 'token', vi.fn(), onClose);

    FakeWebSocket.instance.onclose?.({ code: 1006, reason: 'Portal stopped' });
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: 'Portal stopped' }));

    onClose.mockClear();
    const second = new DirectHostClient('127.0.0.1', 'token', vi.fn(), onClose);
    second.close();
    expect(onClose).not.toHaveBeenCalled();
    first.close();
  });
});
