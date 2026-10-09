import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export type ClientBrowserLayout = { surfaceId: string; x: number; y: number; width: number; height: number; visible: boolean; blocked: boolean };
export type ClientBrowserSnapshot = { closed?: boolean; focused?: boolean; canGoBack?: boolean; canGoForward?: boolean; faviconUrl?: string; pageIdentity: string; url: string; title: string; loading: boolean; width: number; height: number; hidden: boolean; error: string; renderer: string };
export type ClientBrowserEvent = { surfaceId: string; kind: string; [key: string]: unknown };
export type ClientBrowserBridge = {
  create(input: { address: string; paneKey?: string }): Promise<{ surfaceId: string }>;
  adopt(input: { popupToken: string; paneKey?: string }): Promise<{ surfaceId: string }>;
  list(): Promise<{ panes: { surfaceId: string; paneKey: string }[] }>;
  focus(input: { surfaceId: string }): Promise<void>;
  command(input: { surfaceId: string; action: 'navigate' | 'back' | 'forward' | 'reload' | 'stop'; address?: string }): Promise<void>;
  layout(input: ClientBrowserLayout): Promise<void>;
  snapshot(input: { surfaceId: string }): Promise<ClientBrowserSnapshot>;
  close(input: { surfaceId: string }): Promise<void>;
  addListener(event: 'event', callback: (event: ClientBrowserEvent) => void): Promise<PluginListenerHandle>;
};
export const nativeClientBrowser = window.weaveDesktop?.nativeClientBrowser ?? registerPlugin<ClientBrowserBridge>('ClientBrowser');

export const clientBrowserAvailable = Boolean(window.weaveDesktop?.nativeClientBrowser || Capacitor.isPluginAvailable('ClientBrowser'));
