import { createDesktopNotificationAdapter } from './adapters/desktop';
import { createWebNotificationAdapter } from './adapters/web';
import type { NativeNotificationAdapter } from './types';

let configuredAdapter: NativeNotificationAdapter | undefined;
let cachedFallbackAdapter: NativeNotificationAdapter | undefined;

export const setNativeNotificationAdapter = (adapter: NativeNotificationAdapter | undefined) => {
  configuredAdapter = adapter;
};

export const getNativeNotificationAdapter = () => {
  if (configuredAdapter) return configuredAdapter;
  cachedFallbackAdapter ??= createDesktopNotificationAdapter() ?? createWebNotificationAdapter();
  return cachedFallbackAdapter;
};

export const clearNativeNotificationAdapterForTests = () => {
  configuredAdapter = undefined;
  cachedFallbackAdapter = undefined;
};
