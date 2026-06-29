import type { CapacitorConfig } from '@capacitor/cli';

const clientAppId = process.env.WEAVE_CLIENT_APP === 'coppermind' || process.env.VITE_WEAVE_CLIENT_APP === 'coppermind'
  ? 'coppermind'
  : 'flare';

const config: CapacitorConfig = {
  appId: clientAppId === 'coppermind' ? 'com.veezee.coppermind' : 'com.veezee.flare',
  appName: clientAppId === 'coppermind' ? 'Coppermind' : 'Flare',
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
