import { useEffect, useRef } from 'react';
import { type ConnectionStatus, Network } from '@capacitor/network';

/**
 * Runs `onChange` when the device's network comes back or changes, as from Wi-Fi to cellular,
 * when connections over the old one may be gone without saying so.
 */
export function useNetworkChange(onChange: () => void) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let last: ConnectionStatus | undefined;
    void Network.getStatus().then((status) => { last ??= status; }).catch(() => undefined);
    const listener = Network.addListener('networkStatusChange', (status) => {
      // Reachability tells of changes in its flags too, with the same network.
      const changed = last !== undefined && status.connected && (!last.connected || last.connectionType !== status.connectionType);
      last = status;
      if (changed) onChangeRef.current();
    });

    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, []);
}
