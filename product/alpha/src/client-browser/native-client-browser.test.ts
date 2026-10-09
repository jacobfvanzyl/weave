import { afterEach, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({ isPluginAvailable: vi.fn(), registerPlugin: vi.fn(() => ({ native: 'capacitor' })) }));
vi.mock('@capacitor/core', () => ({ Capacitor: capacitor, registerPlugin: capacitor.registerPlugin }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it('exposes the desktop Client Browser without a renderer feature flag', async () => {
  const bridge = { native: 'desktop' };
  vi.stubGlobal('weaveDesktop', { nativeClientBrowser: bridge });
  const browser = await import('./native-client-browser');
  expect(browser.clientBrowserAvailable).toBe(true);
  expect(browser.nativeClientBrowser).toBe(bridge);
  expect(capacitor.registerPlugin).not.toHaveBeenCalled();
});

it('exposes the registered iPad Client Browser without a renderer feature flag', async () => {
  capacitor.isPluginAvailable.mockReturnValue(true);
  const browser = await import('./native-client-browser');
  expect(browser.clientBrowserAvailable).toBe(true);
  expect(capacitor.isPluginAvailable).toHaveBeenCalledWith('ClientBrowser');
  expect(capacitor.registerPlugin).toHaveBeenCalledWith('ClientBrowser');
});

it('keeps web previews and clients without the native plugin unavailable', async () => {
  capacitor.isPluginAvailable.mockReturnValue(false);
  const browser = await import('./native-client-browser');
  expect(browser.clientBrowserAvailable).toBe(false);
});
