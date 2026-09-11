import { useCallback, useState } from 'react';

// A device preference, deliberately separate from the Host's workspace composition.
export function useDevicePaneSize(key: string, fallback?: number) {
  const [size, setSize] = useState<number | undefined>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      if (stored?.schemaVersion === 1 && validSize(stored.size)) return stored.size;
    } catch { /* Missing or unavailable local storage uses the default layout. */ }
    return fallback;
  });
  const remember = useCallback((next: number) => {
    if (!validSize(next)) return;
    setSize(next);
    try {
      window.localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, size: next }));
    } catch { /* Resizing still works if device storage is unavailable. */ }
  }, [key]);
  return [size, remember] as const;
}

function validSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100;
}
