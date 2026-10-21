import { useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { pairingLink } from '@/host/storage';

/**
 * The `weave pair` link the app was opened with: the Camera opens its QR code's
 * `weave://pair?url=…&code=…` in the app. Each link is offered once, for the person to confirm.
 */
export function usePairingLink() {
  const [offer, setOffer] = useState<{ url: string; code: string }>();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const take = (url?: string) => {
      const link = url ? pairingLink(url) : undefined;
      if (link) setOffer(link);
    };
    void App.getLaunchUrl().then((launch) => take(launch?.url)).catch(() => {});
    const listener = App.addListener('appUrlOpen', ({ url }) => take(url));
    return () => { void listener.then((handle) => handle.remove()); };
  }, []);
  return offer;
}
