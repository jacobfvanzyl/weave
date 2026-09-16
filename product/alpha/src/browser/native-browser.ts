import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export type NativeBrowserEvent = { surfaceId: string; kind: 'control' | 'frame' | 'error'; message?: unknown; width?: number; height?: number; diagnosticId?: string };
export type NativeBrowserBridge = {
  keyboard?(input: { requestId: string }): Promise<void>;
  create(): Promise<{ surfaceId: string }>;
  connect(input: { surfaceId: string; url: string }): Promise<void>;
  control(input: { surfaceId: string; json: string }): Promise<void>;
  layout(input: { surfaceId: string; x: number; y: number; width: number; height: number; visible: boolean; dim: number }): Promise<void>;
  clipboard(input: { surfaceId: string; text?: string }): Promise<{ text?: string }>;
  close(input: { surfaceId: string }): Promise<void>;
  addListener(event: 'event', listener: (value: NativeBrowserEvent) => void): Promise<PluginListenerHandle>;
};
export const nativeBrowserAvailable = Capacitor.getPlatform() === 'ios' || Boolean(window.weaveDesktop?.nativeBrowser);
export const nativeBrowserBridge = window.weaveDesktop?.nativeBrowser ?? registerPlugin<NativeBrowserBridge>('NativeBrowser');
