import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { useEffect } from 'react';

interface NativeKeyboardBridge {
  setAccessoryBarVisible(options: { isVisible: boolean }): Promise<void>;
  setScroll(options: { isDisabled: boolean }): Promise<void>;
}

export async function configureNativeKeyboard(
  platform = Capacitor.getPlatform(),
  keyboard: NativeKeyboardBridge = Keyboard,
) {
  if (platform !== 'ios') return;

  await Promise.all([
    keyboard.setAccessoryBarVisible({ isVisible: false }),
    keyboard.setScroll({ isDisabled: true }),
  ]);
}

export function useNativeKeyboard() {
  useEffect(() => {
    void configureNativeKeyboard().catch((error: unknown) => {
      console.error('Unable to configure the native keyboard', error);
    });
  }, []);
}
