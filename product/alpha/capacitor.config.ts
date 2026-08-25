/// <reference types="@capacitor/status-bar" />

import type { CapacitorConfig } from '@capacitor/cli';

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
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#11111b',
    },
  },
};

export default config;
