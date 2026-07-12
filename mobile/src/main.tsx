import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { Animation, StatusBar, Style } from '@capacitor/status-bar';
import { MobileConnectionApp } from '@weave/client/app/mobile-connection';
import { Providers } from '@weave/client/app/providers';
import { getClientAppDefinition } from '@weave/client/lib/client-app';
import { MobileKeyboardAssist } from './keyboard-assist';
import { configureMobileNotifications } from './notifications';
import { applyTheme, useThemeStore } from '@weave/client/stores/theme-store';
import './styles.css';

const configureNativeShell = async () => {
  const root = document.documentElement;
  root.dataset.weaveClientApp = getClientAppDefinition().id;
  root.dataset.weaveRuntime = 'mobile';
  root.dataset.weavePlatform = Capacitor.getPlatform();

  const themeMode = useThemeStore.getState().mode;
  if (themeMode === 'system') useThemeStore.getState().setMode('dark');
  else applyTheme(themeMode);

  if (!Capacitor.isNativePlatform()) return;

  await Promise.allSettled([
    StatusBar.setStyle({ style: Style.Default }),
    StatusBar.setOverlaysWebView({ overlay: true }),
    StatusBar.hide({ animation: Animation.None }),
    Keyboard.setResizeMode({ mode: KeyboardResize.None }),
    Keyboard.setStyle({ style: KeyboardStyle.Default }),
  ]);
};

configureMobileNotifications();
void configureNativeShell();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Providers>
      <MobileKeyboardAssist />
      <MobileConnectionApp />
    </Providers>
  </React.StrictMode>,
);
