import type { WeaveDesktopBridge } from '../shared/desktop-api';

declare global {
  interface Window {
    weaveDesktop: WeaveDesktopBridge;
  }
}

export {};
