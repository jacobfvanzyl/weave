export type WindowStreamInfo = {
  id: string;
  title?: string;
  appName?: string;
  bundleIdentifier?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type WindowStreamApplicationInfo = {
  id: string;
  name: string;
  path?: string;
  bundleIdentifier?: string;
  isRunning?: boolean;
  pids?: number[];
  isActive?: boolean;
  iconDataUrl?: string;
};

export type WindowStreamControlMessage =
  | {
    type: 'pointer';
    action: 'move' | 'down' | 'up';
    x: number;
    y: number;
    button?: number;
    buttons?: number;
    clickCount?: number;
    pointerType?: string;
    pointerId?: number;
    pressure?: number;
    modifiers?: string[];
  }
  | {
    type: 'scroll';
    dx: number;
    dy: number;
    x?: number;
    y?: number;
    deltaMode?: number;
    modifiers?: string[];
    phase?: 'began' | 'changed' | 'ended' | 'momentum';
  }
  | {
    type: 'key';
    action: 'down' | 'up' | 'text';
    key: string;
    code?: string;
    repeat?: boolean;
    text?: string;
    modifiers?: string[];
  }
  | { type: 'focus' }
  | {
    type: 'resize';
    viewportWidth: number;
    viewportHeight: number;
    deviceScaleFactor?: number;
  };

export type WindowStreamSession = {
  sessionId: string;
  portalId: string;
  mediaStream: MediaStream;
  sendControl: (message: WindowStreamControlMessage) => void;
  close: () => void;
  onError: (listener: (error: Error) => void) => () => void;
  onStateChange: (listener: (state: RTCPeerConnectionState) => void) => () => void;
};
