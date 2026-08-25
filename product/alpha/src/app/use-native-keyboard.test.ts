import { describe, expect, it, vi } from 'vitest';
import { configureNativeKeyboard } from './use-native-keyboard';

function keyboardBridge() {
  return {
    setAccessoryBarVisible: vi.fn().mockResolvedValue(undefined),
    setScroll: vi.fn().mockResolvedValue(undefined),
  };
}

describe('configureNativeKeyboard', () => {
  it('pins the outer WebView and removes the iOS form accessory bar', async () => {
    const keyboard = keyboardBridge();

    await configureNativeKeyboard('ios', keyboard);

    expect(keyboard.setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: false });
    expect(keyboard.setScroll).toHaveBeenCalledWith({ isDisabled: true });
  });

  it('leaves browser and non-iOS platforms unchanged', async () => {
    const keyboard = keyboardBridge();

    await configureNativeKeyboard('web', keyboard);

    expect(keyboard.setAccessoryBarVisible).not.toHaveBeenCalled();
    expect(keyboard.setScroll).not.toHaveBeenCalled();
  });
});
