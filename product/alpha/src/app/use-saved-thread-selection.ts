import { useEffect, useRef, useState } from 'react';
import { Preferences } from '@capacitor/preferences';

const key = 'weave.selected-thread.v1';
// This key is independent of terminal presentation and connection credentials.
export function useSavedThreadSelection(selected: string | undefined, durable: boolean, availableIds: string[], restore: (id: string) => Promise<void>) {
  const [candidate, setCandidate] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  const save = useRef(Promise.resolve());
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    let disposed = false;
    void Preferences.get({ key }).then(({ value }) => {
      if (!disposed && value && value.length < 1000) setCandidate(value);
    }).catch(() => undefined).finally(() => { if (!disposed) setLoaded(true); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!loaded || selected === previous.current || selected && !durable) return;
    previous.current = selected;
    setCandidate(undefined);
    save.current = save.current.catch(() => undefined).then(() => Preferences.set({ key, value: selected ?? '' })).catch(() => undefined);
  }, [loaded, selected, durable]);
  useEffect(() => {
    if (!loaded || !candidate || selected || !availableIds.includes(candidate)) return;
    setCandidate(undefined);
    void restoreRef.current(candidate);
  }, [loaded, candidate, selected, availableIds]);
}
