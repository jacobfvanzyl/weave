import { useEffect } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Keyboard, type KeyboardInfo } from '@capacitor/keyboard';

const keyboardHeightProperty = '--weave-mobile-keyboard-height';

const nonTextInputTypes = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const getDeepActiveElement = () => {
  let activeElement: Element | null = document.activeElement;

  while (activeElement instanceof HTMLElement && activeElement.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }

  return activeElement;
};

const getFocusedEditableElement = () => {
  const activeElement = getDeepActiveElement();
  if (!(activeElement instanceof HTMLElement)) return null;

  if (activeElement instanceof HTMLInputElement) {
    return nonTextInputTypes.has(activeElement.type) ? null : activeElement;
  }

  if (activeElement instanceof HTMLTextAreaElement) return activeElement;
  if (!activeElement.isContentEditable) return null;

  return activeElement.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])')
    ?? activeElement;
};

const scrollFocusedEditableIntoView = () => {
  const activeElement = getFocusedEditableElement();
  if (!activeElement) return;

  const visualViewport = window.visualViewport;
  const visibleTop = visualViewport?.offsetTop ?? 0;
  const visibleBottom = visibleTop + (visualViewport?.height ?? window.innerHeight);
  const visibilityMargin = 16;
  const bounds = activeElement.getBoundingClientRect();

  if (
    bounds.top >= visibleTop + visibilityMargin
    && bounds.bottom <= visibleBottom - visibilityMargin
  ) return;

  activeElement.scrollIntoView({
    behavior: 'auto',
    block: 'center',
    inline: 'nearest',
  });
};

export const MobileKeyboardAssist = () => {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;

    let disposed = false;
    let keyboardVisible = false;
    let firstAnimationFrame: number | undefined;
    let secondAnimationFrame: number | undefined;
    const listenerHandles: PluginListenerHandle[] = [];

    const cancelPendingScroll = () => {
      if (firstAnimationFrame !== undefined) window.cancelAnimationFrame(firstAnimationFrame);
      if (secondAnimationFrame !== undefined) window.cancelAnimationFrame(secondAnimationFrame);
      firstAnimationFrame = undefined;
      secondAnimationFrame = undefined;
    };

    const scheduleFocusedElementScroll = () => {
      cancelPendingScroll();
      firstAnimationFrame = window.requestAnimationFrame(() => {
        firstAnimationFrame = undefined;
        secondAnimationFrame = window.requestAnimationFrame(() => {
          secondAnimationFrame = undefined;
          scrollFocusedEditableIntoView();
        });
      });
    };

    const handleFocusIn = () => {
      if (keyboardVisible) scheduleFocusedElementScroll();
    };

    const setKeyboardHeight = (info: KeyboardInfo) => {
      const keyboardHeight = Math.max(0, Math.round(info.keyboardHeight));
      document.documentElement.style.setProperty(keyboardHeightProperty, `${keyboardHeight}px`);
      document.documentElement.dataset.weaveKeyboardVisible = 'true';
    };

    const clearKeyboardHeight = () => {
      document.documentElement.style.removeProperty(keyboardHeightProperty);
      delete document.documentElement.dataset.weaveKeyboardVisible;
    };

    document.addEventListener('focusin', handleFocusIn);

    void Keyboard.addListener('keyboardWillShow', info => {
      keyboardVisible = true;
      setKeyboardHeight(info);
      scheduleFocusedElementScroll();
    }).then(handle => {
      if (disposed) void handle.remove();
      else listenerHandles.push(handle);
    }).catch(error => {
      console.error('[mobile] failed to register keyboard will-show listener', error);
    });

    void Keyboard.addListener('keyboardDidShow', info => {
      keyboardVisible = true;
      setKeyboardHeight(info);
      scheduleFocusedElementScroll();
    }).then(handle => {
      if (disposed) void handle.remove();
      else listenerHandles.push(handle);
    }).catch(error => {
      console.error('[mobile] failed to register keyboard did-show listener', error);
    });

    void Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisible = false;
      clearKeyboardHeight();
      cancelPendingScroll();
    }).then(handle => {
      if (disposed) void handle.remove();
      else listenerHandles.push(handle);
    }).catch(error => {
      console.error('[mobile] failed to register keyboard did-hide listener', error);
    });

    return () => {
      disposed = true;
      keyboardVisible = false;
      clearKeyboardHeight();
      cancelPendingScroll();
      document.removeEventListener('focusin', handleFocusIn);
      for (const handle of listenerHandles) void handle.remove();
      listenerHandles.length = 0;
    };
  }, []);

  return null;
};
