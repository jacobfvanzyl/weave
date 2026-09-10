import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export type NativeTerminalEvent = { surfaceId: string; kind: 'input' | 'resize' | 'focus' | 'error'; message?: string; data?: string; cols?: number; rows?: number };
export type NativeTerminalBounds = { surfaceId: string; x: number; y: number; width: number; height: number; visible: boolean; readOnly: boolean };
export type NativeTerminalBridge = {
  create(): Promise<{ surfaceId: string; renderer: string }>;
  layout(bounds: NativeTerminalBounds): Promise<{ cols: number; rows: number }>;
  write(input: { surfaceId: string; data: string; reset: boolean }): Promise<void>;
  focus(input: { surfaceId: string }): Promise<void>;
  close(input: { surfaceId: string }): Promise<void>;
  inspect(input: { surfaceId: string }): Promise<{ text: string; renderer: string }>;
  addListener(event: 'event', listener: (value: NativeTerminalEvent) => void): Promise<PluginListenerHandle>;
};
export const nativeTerminalEnabled = import.meta.env.VITE_NATIVE_TERMINAL === '1' && (Capacitor.getPlatform() === 'ios' || window.weaveDesktop?.platform === 'macos');
export const nativeTerminalBridge = window.weaveDesktop?.nativeTerminal ?? registerPlugin<NativeTerminalBridge>('NativeTerminal');
export const nativeTerminalAcceptance = new Map<HTMLElement, { focus(): Promise<void>; read(): Promise<string> }>();
export function encodeTerminalBytes(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
export function decodeTerminalBytes(value: string) {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
