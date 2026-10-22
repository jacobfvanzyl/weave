import { describe, expect, it } from 'vitest';
import { websocketConnector } from './connection';

/** A WebSocket that never opens, as on a network that's gone, and says whether it was closed. */
class StuckSocket {
  static last?: StuckSocket;
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;

  constructor() {
    StuckSocket.last = this;
  }

  close() {
    this.closed = true;
  }

  send() {}
}

describe('websocketConnector', () => {
  it('closes a WebSocket still opening when the try is abandoned', async () => {
    const abort = new AbortController();
    const opening = websocketConnector('wss://mac', StuckSocket as unknown as typeof WebSocket)({ message() {}, closed() {} }, abort.signal);
    abort.abort(new Error('gave up'));
    await expect(opening).rejects.toThrow('gave up');
    expect(StuckSocket.last?.closed).toBe(true);
  });
});
