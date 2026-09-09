/// <reference types="@capacitor/status-bar" />

import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.veezee.alpha',
  appName: 'Weave',
  webDir: 'dist',
  ios: {
    backgroundColor: '#1e1e2e',
    contentInset: 'never',
    scrollEnabled: false,
    zoomEnabled: false,
  },
  plugins: {
    // The iPad controller sizes the WebView using UIKit keyboardLayoutGuide.
    // Alpha follows that viewport; disable the competing notification resize.
    Keyboard: { resize: KeyboardResize.None },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
  },
};

export default config;
