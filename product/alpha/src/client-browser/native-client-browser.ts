import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export type ClientBrowserLayout = { surfaceId: string; x: number; y: number; width: number; height: number; visible: boolean; blocked: boolean };
export type ClientBrowserSnapshot = { closed?: boolean; focused?: boolean; pageIdentity: string; url: string; title: string; loading: boolean; width: number; height: number; hidden: boolean; error: string; renderer: string };
export type ClientBrowserEvent = { surfaceId: string; kind: string; [key: string]: unknown };
export type ClientBrowserPrototypeBridge = {
  create(input: { address: string; paneKey?: string }): Promise<{ surfaceId: string }>;
  adopt(input: { popupToken: string; paneKey?: string }): Promise<{ surfaceId: string }>;
  list(): Promise<{ panes: { surfaceId: string; paneKey: string }[] }>;
  focus(input: { surfaceId: string }): Promise<void>;
  layout(input: ClientBrowserLayout): Promise<void>;
  snapshot(input: { surfaceId: string }): Promise<ClientBrowserSnapshot>;
  close(input: { surfaceId: string }): Promise<void>;
  addListener(event: 'event', callback: (event: ClientBrowserEvent) => void): Promise<PluginListenerHandle>;
};
export const clientBrowserPrototype = window.weaveDesktop?.clientBrowserPrototype ?? registerPlugin<ClientBrowserPrototypeBridge>('ClientBrowserPrototype');

export const clientBrowserAvailable = import.meta.env.VITE_CLIENT_BROWSER_PROTOTYPE === '1' && Boolean(window.weaveDesktop?.clientBrowserPrototype || Capacitor.isPluginAvailable('ClientBrowserPrototype'));
