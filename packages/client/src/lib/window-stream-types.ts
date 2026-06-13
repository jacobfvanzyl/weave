export type WindowStreamInfo = {
  id: string;
  title?: string;
  appName?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type WindowStreamControlMessage =
  | {
    type: 'pointer';
    action: 'move' | 'down' | 'up';
    x: number;
    y: number;
    modifiers?: string[];
  }
  | {
    type: 'scroll';
    dx: number;
    dy: number;
    x?: number;
    y?: number;
  }
  | {
    type: 'key';
    action: 'down' | 'up';
    key: string;
    code?: string;
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
