import { beforeEach, expect, it, vi } from 'vitest';
import { installClientBrowser } from '../../electron/client-browser';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), removeHandler: vi.fn(),
  addon: { prepare: vi.fn(), create: vi.fn<(parent: Buffer, address: string, callback: (json: string) => void, paneKey?: string) => number>(() => 7), command: vi.fn(), close: vi.fn() },
}));
vi.mock('electron', () => ({ app: { getAppPath: () => '/test-app' }, ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler } }));
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>();
  const createRequire = () => () => mocks.addon;
  return { ...actual, default: { ...actual, createRequire }, createRequire };
});
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const mainFrame = { url: 'weave://app/index.html' };
  const contents = { mainFrame, on: vi.fn(), focus: vi.fn(), send: vi.fn(), isDestroyed: () => false };
  const window = { webContents: contents, getNativeWindowHandle: () => Buffer.alloc(8), once: vi.fn() };
  installClientBrowser(window as any);
  const request = mocks.handle.mock.calls[0]![1] as (event: unknown, method: string, input?: Record<string, unknown>) => any;
  const event = { sender: contents, senderFrame: mainFrame };
  const { surfaceId } = request(event, 'create', { address: 'about:blank', paneKey: 'local-pane' });
  const notify = mocks.addon.create.mock.calls[0]![2] as unknown as (json: string) => void;
  return { contents, event, request, notify, surfaceId };
}

it('transfers the native first responder back to Electron before publishing address focus', () => {
  const { contents, notify, surfaceId } = fixture();
  notify(JSON.stringify({ kind: 'focused' }));
  expect(contents.focus).not.toHaveBeenCalled();
  notify(JSON.stringify({ kind: 'focus-address' }));
  expect(contents.focus).toHaveBeenCalledOnce();
  expect(contents.send).toHaveBeenLastCalledWith('weave:client-browser:event', { kind: 'focus-address', surfaceId });
  expect(contents.focus.mock.invocationCallOrder[0]).toBeLessThan(contents.send.mock.invocationCallOrder[1]!);
});

it('limits local navigation commands to the owning trusted shell and live surface', () => {
  const { event, request, surfaceId } = fixture();
  request(event, 'command', { surfaceId, action: 'navigate', address: 'https://example.test/' });
  expect(mocks.addon.command).toHaveBeenCalledExactlyOnceWith(7, 'navigate', 'https://example.test/');
  for (const address of ['javascript:alert(1)', 'file:///tmp/private', 'about:config']) expect(() => request(event, 'command', { surfaceId, action: 'navigate', address })).toThrow('Invalid Client Browser address');
  expect(() => request(event, 'command', { surfaceId, action: 'evaluate' })).toThrow('Invalid Client Browser command');
  expect(() => request(event, 'command', { surfaceId: 'another-page', action: 'reload' })).toThrow('Missing Client Browser surface');
  expect(() => request({ ...event, senderFrame: { url: 'https://example.test/' } }, 'command', { surfaceId, action: 'reload' })).toThrow('Invalid Client Browser caller');
  expect(mocks.addon.command).toHaveBeenCalledOnce();
});
