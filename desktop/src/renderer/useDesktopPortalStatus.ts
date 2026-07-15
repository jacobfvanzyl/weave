import { useCallback, useEffect, useState } from 'react';
import type { DesktopPortalStatus } from '../shared/desktop-api';

export const useDesktopPortalStatus = () => {
  const [status, setStatus] = useState<DesktopPortalStatus>();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.weaveDesktop.getPortalStatus().then(nextStatus => {
      if (!cancelled) setStatus(nextStatus);
    });
    const unsubscribe = window.weaveDesktop.onPortalStatus(nextStatus => {
      if (!cancelled) setStatus(nextStatus);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      setStatus(await window.weaveDesktop.retryPortal());
    } catch (error) {
      setStatus(current => ({
        phase: 'failed',
        serverUrl: current?.serverUrl ?? '',
        portalId: current?.portalId,
        source: current?.source,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRetrying(false);
    }
  }, []);

  return { retry, retrying, status };
};
