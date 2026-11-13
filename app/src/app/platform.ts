// The platform seam (ADR 0032, WVE-203): what differs between where the same UI runs, in one
// place beside `AppController`. The Mac, the iPad and the iPhone run it in the app's shell
// (Tauri, WVE-221), whose core holds the device's key and opens its connections; a browser runs
// the page alone, which then holds its own key and opens its own WebSockets, for development,
// with `?mock=`, and for a web build later. Each answers for the device's key and pairing, how
// it reaches the Dispatcher and the Hosts (the Mac's own Host among them), how it draws
// terminals, and where its command keys come from. Nothing outside this file and `src/mac` asks
// which shell it is.
import { clipboardWrite } from '@/host/client-tools';
import { websocketConnector } from '@/host/connection';
import { type DeviceKey, webCryptoDeviceKey } from '@/host/device-key';
import type { HostStoreOptions } from '@/host/host-store';
import { HOST_PROTOCOL } from '@/host/protocol';
import { pageStorage } from '@/host/storage';
import { macNotify } from '@/mac/notify';
import { MAC_KEY, macKey, macRoutes, macStorage, onIos, onMac, tauriCore } from '@/mac/routes';

/** What the store needs of the device: its pairing, its key, its routes and its client tools. */
export type DeviceStore = Pick<HostStoreOptions, 'storage' | 'keyFor' | 'newKey' | 'socket' | 'routes' | 'clientTools' | 'deviceName'>;

export type Platform = {
  /** The device: the iPad or iPhone, or the Mac, in the app's shell, or a browser alone. */
  kind: 'ios' | 'mac' | 'web';
  /**
   * How it draws terminals (ADR 0022): in the page itself, with libghostty-vt in WebAssembly
   * (`page`, WVE-205), where the core passes it their streams. In a browser alone a terminal's
   * Block says what it is and what runs in it (`text`).
   */
  terminals: 'page' | 'text';
  /**
   * Where a hardware keyboard's command keys come from: the page hears them itself, or the
   * Mac's menu bar has them and runs the command in the page.
   */
  keys: 'page' | 'menu';
  /**
   * Whether the device reaches its own computer's Host without the Dispatcher: the Mac's, over
   * its socket, as local clients do (ADR 0030).
   */
  localHost: boolean;
  /** How many windows the app may have: one on every device, until the Mac's shell takes more. */
  windows: 'one';
  /**
   * Whether the page is the window's title row: the Mac's window has no title bar of its own
   * (`overlay`), so its traffic lights sit over the page's top left, the leftmost rail there leaves
   * them room, and the rails' empty parts drag the window. Elsewhere the page keeps to the safe area.
   */
  titleBar: 'overlay' | 'none';
  /**
   * Puts text on the device's clipboard without the person's tap or key, as an agent's call or
   * a terminal's program (OSC 52) needs: the native clipboard, or on the Mac its core's.
   */
  writeClipboard(text: string): Promise<void>;
  /** Shows a notification that isn't a thread's, as a terminal's program asks: the Mac's, while the app isn't in front. */
  notify?(notice: { title: string; body: string }): void;
  /** The device's side of the store: made once, when the app starts. */
  store(): DeviceStore;
};

const clipboard = (write: (text: string) => Promise<void>) => ({ [HOST_PROTOCOL.clientTools.clipboardWrite]: clipboardWrite(write) });

// The web view lets a page write only while the person is clicking or typing in it, so the core writes.
const macClipboard = (text: string) => tauriCore.invoke<void>('clipboard_write', { text });
// A browser's own, which may refuse without a click or key first.
const pageClipboard = (text: string) => navigator.clipboard.writeText(text);

/** The core's side of the store: it holds the key and the pairing, and opens every connection. */
const coreStore = (deviceName: string): DeviceStore => ({
  storage: macStorage(),
  keyFor: () => macKey,
  newKey: async () => ({ keyId: MAC_KEY, key: macKey }),
  routes: macRoutes(),
  clientTools: clipboard(macClipboard),
  deviceName,
});

/** The Mac: its core holds the key and reaches everything, with the pairing the computer's CLI shares. */
const mac: Platform = {
  kind: 'mac',
  terminals: 'page',
  keys: 'menu',
  localHost: true,
  windows: 'one',
  titleBar: 'overlay',
  notify: macNotify,
  writeClipboard: macClipboard,
  store: () => coreStore('Mac'),
};

/** The iPad and iPhone (WVE-221): the Mac's core, with a pairing of the device's own and no Host beside it. */
const ios: Platform = {
  kind: 'ios',
  terminals: 'page',
  keys: 'page',
  localHost: false,
  windows: 'one',
  titleBar: 'none',
  writeClipboard: macClipboard,
  store: () => coreStore(document.documentElement.dataset.deviceIdiom === 'phone' ? 'iPhone' : 'iPad'),
};

// A browser, during development, keeps its keys in memory: after a reload it pairs again.
const browserKeys = new Map<string, DeviceKey>();
const lostKey = (): DeviceKey => ({
  publicKey: () => Promise.reject(new Error('This browser no longer has its key for the Dispatcher. Pair it again.')),
  sign: () => Promise.reject(new Error('This browser no longer has its key for the Dispatcher. Pair it again.')),
  forget: async () => {},
});

const web: Platform = {
  kind: 'web',
  terminals: 'text',
  keys: 'page',
  localHost: false,
  windows: 'one',
  titleBar: 'none',
  writeClipboard: pageClipboard,
  store: () => ({
    storage: pageStorage,
    keyFor: (keyId) => browserKeys.get(keyId) ?? lostKey(),
    newKey: async () => {
      const keyId = crypto.randomUUID();
      const key = await webCryptoDeviceKey();
      browserKeys.set(keyId, key);
      return { keyId, key };
    },
    socket: (url, subprotocol) => websocketConnector(url, subprotocol),
    clientTools: clipboard(pageClipboard),
    deviceName: 'Browser',
  }),
};

/** The shell the page runs in. */
export const platform = (): Platform => onMac() ? mac : onIos() ? ios : web;

/**
 * What makes a rail in the window's title row drag the window on the Mac: Tauri's `drag.js` moves
 * it from a press anywhere in the rail but on a button, tab, input or link, and a double click
 * zooms it. Nothing elsewhere.
 */
export const dragsWindow = (): { 'data-tauri-drag-region'?: 'deep' } => platform().titleBar === 'overlay' ? { 'data-tauri-drag-region': 'deep' } : {};
