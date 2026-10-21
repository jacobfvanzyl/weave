import { useEffect, useState, useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { websocketConnector } from '@/host/connection';
import { type DeviceKey, nativeDeviceKey, webCryptoDeviceKey } from '@/host/device-key';
import { HostStore } from '@/host/host-store';
import { preferencesStorage } from '@/host/storage';
import type { AppController, AppModel } from './app-controller';
import { useAppResume } from './use-app-resume';

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
    client,
    deviceName: idiom === 'phone' ? 'iPhone' : idiom === 'pad' ? 'iPad' : 'Browser',
  });
}

const noSubscription = () => () => {};

// What the controller does in the moment before its store exists: nothing.
const idleActions: AppController['actions'] = {
  selectSession() {},
  createSession() {},
  closeSession() {},
  deleteSession() {},
  pairHost: () => Promise.reject(new Error('The app is still starting.')),
  forgetHost() {},
  reconnectHost() {},
  send() {},
  removeQueued() {},
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
  useAppResume(() => void store?.refresh());
  const model = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? (() => emptyModel));
  return { model, actions: store?.actions ?? idleActions };
}
