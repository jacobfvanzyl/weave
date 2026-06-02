import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { Animation, StatusBar, Style } from '@capacitor/status-bar';
import { MobileConnectionApp } from '@weave/client/app/mobile-connection';
import { Providers } from '@weave/client/app/providers';
import './styles.css';

const configureNativeShell = async () => {
  const root = document.documentElement;
  root.dataset.weaveRuntime = 'mobile';
  root.dataset.weavePlatform = Capacitor.getPlatform();

  if (!Capacitor.isNativePlatform()) return;

  await Promise.allSettled([
    StatusBar.setStyle({ style: Style.Default }),
    StatusBar.setOverlaysWebView({ overlay: true }),
    StatusBar.hide({ animation: Animation.None }),
    Keyboard.setResizeMode({ mode: KeyboardResize.Body }),
    Keyboard.setStyle({ style: KeyboardStyle.Default }),
  ]);
};

void configureNativeShell();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Providers>
      <MobileConnectionApp />
    </Providers>
  </React.StrictMode>,
);
