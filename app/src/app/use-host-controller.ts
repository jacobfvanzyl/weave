import { useEffect, useState, useSyncExternalStore } from 'react';
import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';
import { clipboardWrite } from '@/host/client-tools';
import { websocketConnector } from '@/host/connection';
import { type DeviceKey, nativeDeviceKey, webCryptoDeviceKey } from '@/host/device-key';
import { HostStore } from '@/host/host-store';
import { HOST_PROTOCOL } from '@/host/protocol';
import { preferencesStorage } from '@/host/storage';
import type { AppController, AppModel } from './app-controller';
import { useAppResume } from './use-app-resume';
import { useNetworkChange } from './use-network-change';

const client = { name: 'weave-app', version: '0.1.0' };

const emptyModel: AppModel = { hosts: [], sessions: [], agents: {}, unread: new Set() };

// A browser, during development, keeps its keys in memory: after a reload it pairs again.
const browserKeys = new Map<string, DeviceKey>();
const lostKey = (): DeviceKey => ({
  publicKey: () => Promise.reject(new Error('This browser no longer has its key for the Host. Pair it again.')),
  sign: () => Promise.reject(new Error('This browser no longer has its key for the Host. Pair it again.')),
  forget: async () => {},
});

function newStore() {
  const native = Capacitor.isNativePlatform();
  const idiom = document.documentElement.dataset.deviceIdiom;
  return new HostStore({
    storage: preferencesStorage,
    keyFor: (keyId) => native ? nativeDeviceKey(keyId) : browserKeys.get(keyId) ?? lostKey(),
    async newKey() {
      const keyId = crypto.randomUUID();
      if (native) return { keyId, key: nativeDeviceKey(keyId) };
      const key = await webCryptoDeviceKey();
      browserKeys.set(keyId, key);
      return { keyId, key };
    },
    connectorFor: (url) => websocketConnector(url),
    // The native plugin writes without a tap first, as an agent's call needs.
    clientTools: { [HOST_PROTOCOL.clientTools.clipboardWrite]: clipboardWrite((text) => Clipboard.write({ string: text })) },
    client,
    deviceName: idiom === 'phone' ? 'iPhone' : idiom === 'pad' ? 'iPad' : 'Browser',
  });
}

const noSubscription = () => () => {};

// What the controller does in the moment before its store exists: nothing.
const idleActions: AppController['actions'] = {
  selectSession() {},
  createSession() {},
  listDirectory: () => Promise.reject(new Error('The app is still starting.')),
  listWorktrees: () => Promise.reject(new Error('The app is still starting.')),
  createWorktree: () => Promise.reject(new Error('The app is still starting.')),
  removeWorktree: () => Promise.reject(new Error('The app is still starting.')),
  closeSession() {},
  renameSession() {},
  deleteSession() {},
  pairHost: () => Promise.reject(new Error('The app is still starting.')),
  forgetHost() {},
  reconnectHost() {},
  send() {},
  removeQueued() {},
  resumeQueue() {},
  cancelTurn() {},
  reopenSession() {},
  respondToPermission() {},
  respondToElicitation() {},
  setMode() {},
  setConfigOption() {},
};

/** The app's controller backed by its paired Hosts (`HostStore`). */
export function useHostController(): AppController {
  const [store, setStore] = useState<HostStore>();
  useEffect(() => {
    const created = newStore();
    setStore(created);
    void created.start();
    return () => created.stop();
  }, []);
  // Coming to the front, or onto another network, checks each connection and replaces dead ones.
  useAppResume(() => void store?.refresh());
  useNetworkChange(() => void store?.refresh());
  const model = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? (() => emptyModel));
  return { model, actions: store?.actions ?? idleActions };
}
