import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.veezee.weave',
  appName: 'Weave',
  webDir: 'dist',
  ios: {
    path: 'ios',
  },
  plugins: {
    Keyboard: {
      resize: 'body',
      style: 'default',
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'default',
    },
  },
};

export default config;
