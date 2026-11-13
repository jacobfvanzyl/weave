import { useEffect, useRef } from 'react';

/**
 * Runs `onChange` when the device's network comes back, when connections over the old one may be
 * gone without saying so. A change from one network to another without a gap, as from Wi-Fi to
 * cellular, the web view doesn't tell of: those connections fail their next check, and coming back
 * to the app checks them too (`useAppResume`).
 */
export function useNetworkChange(onChange: () => void) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const online = () => onChangeRef.current();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);
}
