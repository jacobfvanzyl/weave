// The platform seam (ADR 0032, WVE-203): what differs between the shells the same UI runs in,
// in one place beside `AppController`. The iPad and iPhone run in Capacitor, the Mac in Tauri,
// and a browser runs the page alone, for development and with `?mock=`. A shell answers for the
// device's key and pairing, how it reaches the Dispatcher and the Hosts (the Mac's own Host
// among them), whether it draws terminals, and where its command keys come from.
import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';
import { clipboardWrite } from '@/host/client-tools';
import { websocketConnector } from '@/host/connection';
import { type DeviceKey, nativeDeviceKey, webCryptoDeviceKey } from '@/host/device-key';
import type { HostStoreOptions } from '@/host/host-store';
import { HOST_PROTOCOL } from '@/host/protocol';
import { preferencesStorage } from '@/host/storage';
import { MAC_KEY, macKey, macRoutes, macStorage, onMac } from '@/mac/routes';

/** What the store needs of the device: its pairing, its key, its routes and its client tools. */
export type DeviceStore = Pick<HostStoreOptions, 'storage' | 'keyFor' | 'newKey' | 'socket' | 'routes' | 'clientTools' | 'deviceName'>;

export type Platform = {
  /** The shell: Capacitor on the iPad and iPhone, Tauri on the Mac, or a browser alone. */
  kind: 'ios' | 'mac' | 'web';
  /**
   * Whether it draws terminals (ADR 0022): natively beneath the page on the iPad and iPhone.
   * Elsewhere a terminal's Block says what it is and what runs in it; the Mac draws them from
   * WVE-205.
   */
  drawsTerminals: boolean;
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
  /** The device's side of the store: made once, when the app starts. */
  store(): DeviceStore;
};

const clipboard = (write: (text: string) => Promise<void>) => ({ [HOST_PROTOCOL.clientTools.clipboardWrite]: clipboardWrite(write) });

/** The Mac: its core holds the key and reaches everything, with the pairing the computer's CLI shares. */
const mac: Platform = {
  kind: 'mac',
  drawsTerminals: false,
  keys: 'menu',
  localHost: true,
  windows: 'one',
  store: () => ({
    storage: macStorage(),
    keyFor: () => macKey,
    newKey: async () => ({ keyId: MAC_KEY, key: macKey }),
    routes: macRoutes(),
    clientTools: clipboard((text) => navigator.clipboard.writeText(text)),
    deviceName: 'Mac',
  }),
};

/** The iPad and iPhone: the key in the Secure Enclave, the pairing in the app's preferences. */
const ios: Platform = {
  kind: 'ios',
  drawsTerminals: true,
  keys: 'page',
  localHost: false,
  windows: 'one',
  store: () => ({
    storage: preferencesStorage,
    keyFor: (keyId) => nativeDeviceKey(keyId),
    newKey: async () => {
      const keyId = crypto.randomUUID();
      return { keyId, key: nativeDeviceKey(keyId) };
    },
    socket: (url, subprotocol) => websocketConnector(url, subprotocol),
    // The native plugin writes without a tap first, as an agent's call needs.
    clientTools: clipboard((text) => Clipboard.write({ string: text })),
    deviceName: document.documentElement.dataset.deviceIdiom === 'phone' ? 'iPhone' : 'iPad',
  }),
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
  drawsTerminals: false,
  keys: 'page',
  localHost: false,
  windows: 'one',
  store: () => ({
    storage: preferencesStorage,
    keyFor: (keyId) => browserKeys.get(keyId) ?? lostKey(),
    newKey: async () => {
      const keyId = crypto.randomUUID();
      const key = await webCryptoDeviceKey();
      browserKeys.set(keyId, key);
      return { keyId, key };
    },
    socket: (url, subprotocol) => websocketConnector(url, subprotocol),
    clientTools: clipboard((text) => Clipboard.write({ string: text })),
    deviceName: 'Browser',
  }),
};

/** The shell the page runs in. */
export const platform = (): Platform => onMac() ? mac : Capacitor.isNativePlatform() ? ios : web;
