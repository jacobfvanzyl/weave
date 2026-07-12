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
      resize: 'none',
      style: 'default',
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'default',
    },
    LocalNotifications: {
      presentationOptions: ['banner', 'list', 'sound'],
    },
  },
};

export default config;
