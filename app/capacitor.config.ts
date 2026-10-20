/// <reference types="@capacitor/status-bar" />

import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.veezee.weave',
  appName: 'Weave',
  webDir: 'dist',
  ios: {
    backgroundColor: '#1e1e2e',
    contentInset: 'never',
    scrollEnabled: false,
    zoomEnabled: false,
  },
  plugins: {
    // The native shell sizes the web view with UIKit's keyboardLayoutGuide;
    // the app follows that viewport, so the notification resize is off.
    Keyboard: { resize: KeyboardResize.None },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
  },
};

export default config;
