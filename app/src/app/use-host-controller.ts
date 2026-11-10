import { useEffect, useState, useSyncExternalStore } from 'react';
import { HostStore } from '@/host/host-store';
import type { AppController, AppModel } from './app-controller';
import { platform } from './platform';
import { useAppResume } from './use-app-resume';
import { useNetworkChange } from './use-network-change';

const client = { name: 'weave-app', version: '0.1.0' };

const emptyModel: AppModel = { starting: true, hosts: [], threads: [], agents: {}, unread: new Set() };

/** The store, with the device's side of it from the shell the page runs in (`platform.ts`). */
const newStore = () => new HostStore({ ...platform().store(), client });

const noSubscription = () => () => {};

// What the controller does in the moment before its store exists: nothing.
const idleActions: AppController['actions'] = {
  selectThread() {},
  createThread() {},
  listDirectory: () => Promise.reject(new Error('The app is still starting.')),
  listWorktrees: () => Promise.reject(new Error('The app is still starting.')),
  createWorktree: () => Promise.reject(new Error('The app is still starting.')),
  removeWorktree: () => Promise.reject(new Error('The app is still starting.')),
  closeThread() {},
  renameThread() {},
  deleteThread() {},
  pairDispatcher: () => Promise.reject(new Error('The app is still starting.')),
  forgetDispatcher() {},
  reconnectDispatcher() {},
  reconnectHost() {},
  send() {},
  removeQueued() {},
  resumeQueue() {},
  cancelTurn() {},
  reopenThread() {},
  updateAgent() {},
  respondToPermission() {},
  respondToElicitation() {},
  setMode() {},
  setConfigOption() {},
  newTerminal: () => Promise.reject(new Error('The app is still starting.')),
  closeTerminal: () => Promise.reject(new Error('The app is still starting.')),
  renameTerminal: () => Promise.reject(new Error('The app is still starting.')),
  attachTerminal: () => Promise.reject(new Error('The app is still starting.')),
};

/** The app's controller backed by the Dispatcher it's paired with and the Hosts it lists (`HostStore`). */
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
