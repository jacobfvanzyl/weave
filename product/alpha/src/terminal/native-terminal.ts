import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export type NativeTerminalEvent = { surfaceId: string; kind: 'input' | 'resize' | 'focus' | 'blur' | 'window-focus' | 'window-blur' | 'error'; intent?: 'pointer'; message?: string; data?: string; cols?: number; rows?: number };
export type NativeTerminalBounds = { surfaceId: string; x: number; y: number; width: number; height: number; visible: boolean; readOnly: boolean; dimAmount?: number; focusBorder?: { width: number; radius: number; rgb: number } };
export type NativeTerminalBridge = {
  windowGeometry?(): Promise<{ bottomRightRadius: number; width: number }>;
  create(): Promise<{ surfaceId: string; renderer: string; codec: string }>;
  layout(bounds: NativeTerminalBounds): Promise<{ cols: number; rows: number }>;
  write(input: { surfaceId: string; data: string | Uint8Array; reset: boolean; history?: boolean; cols?: number; rows?: number }): Promise<void>;
  focusWeb(): Promise<void>;
  focus(input: { surfaceId: string }): Promise<void>;
  close(input: { surfaceId: string }): Promise<void>;
  inspect(input: { surfaceId: string }): Promise<{ text: string; renderer: string }>;
  addListener(event: 'event', listener: (value: NativeTerminalEvent) => void): Promise<PluginListenerHandle>;
};
export const nativeTerminalAvailable = Capacitor.getPlatform() === 'ios' || Boolean(window.weaveDesktop?.nativeTerminal);
export const nativeSoftwareKeyboard = Capacitor.getPlatform() === 'ios';
export const nativeTerminalBridge = window.weaveDesktop?.nativeTerminal ?? registerPlugin<NativeTerminalBridge>('NativeTerminal');
export const nativeTerminalAcceptance = new Map<HTMLElement, { focus(): Promise<void>; read(): Promise<string> }>();
export function encodeTerminalBytes(bytes: Uint8Array) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
export function decodeTerminalBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
