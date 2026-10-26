// The native terminal plugin's bridge (`ios/App/App/NativeTerminalPlugin.swift`, WVE-153), after
// e30f6e93 (product/alpha/src/terminal/native-terminal.ts) by way of the WVE-150 spike. The plugin
// holds each terminal's stream itself; only its messages come here.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { HOST_PROTOCOL, type HostTerminal } from '@/host/protocol';

/** What a surface's stream says, as the plugin passes it on. */
export type NativeTerminalEvent = { surfaceId: string } & (
  | { kind: 'opened'; terminal: HostTerminal; restore: 'snapshot' | 'vt' }
  | { kind: 'updated'; terminal: HostTerminal }
  | { kind: 'resized'; size: { cols: number; rows: number } }
  | { kind: 'resync' }
  | { kind: 'bell' }
  | { kind: 'notification'; title: string; body: string }
  | { kind: 'progress'; state: string; progress?: number }
  /** The program wrote to the clipboard, which the plugin put on the pasteboard. */
  | { kind: 'clipboard' }
  | { kind: 'exited'; exitCode: number }
  /** The stream ended: `code` is the WebSocket's close code, or 0 when the connection failed. */
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'focus' }
  | { kind: 'blur' }
);

export type NativeTerminalBounds = {
  surfaceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  /** An overlay covers the web view: touches and the keyboard stay with it. */
  inputBlocked: boolean;
};

export type NativeTerminalBridge = {
  create(input: { fontSize: number }): Promise<{ surfaceId: string; codec: string }>;
  /** Places the surface under the web view; resolves to the grid that fits it. */
  layout(bounds: NativeTerminalBounds): Promise<{ cols: number; rows: number }>;
  /** Opens a terminal's stream, closing one already open. */
  attach(input: { surfaceId: string; url: string; ticket: string }): Promise<void>;
  detach(input: { surfaceId: string }): Promise<void>;
  setFontSize(input: { surfaceId: string; fontSize: number }): Promise<{ cols: number; rows: number; fontSize: number }>;
  focus(input: { surfaceId: string }): Promise<void>;
  blur(input: { surfaceId: string }): Promise<void>;
  close(input: { surfaceId: string }): Promise<void>;
  /** Debug builds: the screen as text. */
  inspect(input: { surfaceId: string }): Promise<{ text: string; cols: number; rows: number; fontSize: number; codec: string; attached: boolean }>;
  addListener(event: 'event', listener: (event: NativeTerminalEvent) => void): Promise<PluginListenerHandle>;
};

export const nativeTerminalAvailable = () => Capacitor.getPlatform() === 'ios';
export const nativeTerminal = registerPlugin<NativeTerminalBridge>('NativeTerminal');

/** The stream's close codes. */
export const CLOSE = {
  revoked: HOST_PROTOCOL.websocket.closeRevoked,
  ticket: HOST_PROTOCOL.terminalStream.closeTicket,
  exited: HOST_PROTOCOL.terminalStream.closeExited,
} as const;
