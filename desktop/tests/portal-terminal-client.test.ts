import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalTerminalClient } from '../src/main/portal-terminal-client';
import type { PortalSupervisor } from '../src/main/portal-supervisor';

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe('PortalTerminalClient', () => {
  it('uses one local WebSocket for concurrent snapshot requests', async () => {
    let socketCount = 0;
    class FakeWebSocket {
      static readonly OPEN = 1;
      readonly url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        socketCount += 1;
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(data: string) {
        const envelope = JSON.parse(data) as { message?: { requestId?: string } };
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({
              type: 'terminal.event',
              event: { type: 'windows', requestId: envelope.message?.requestId, windows: [] },
            }),
          }),
        );
      }

      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const ensureStarted = vi.fn(async () => ({
      url: 'ws://127.0.0.1:1234/terminal?token=test',
      httpUrl: 'http://127.0.0.1:1234',
      token: 'test',
    }));
    const supervisor = {
      ensureStarted,
    } as unknown as PortalSupervisor;
    const client = new PortalTerminalClient(supervisor);

    const snapshots = await Promise.all([client.snapshot(), client.snapshot()]);

    expect(snapshots).toEqual([[], []]);
    expect(socketCount).toBe(1);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});
