import { useEffect, useRef } from 'react';

/** Runs `onResume` when the app comes back to the front after having been away. */
export function useAppResume(onResume: () => void) {
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    let wasHidden = document.visibilityState === 'hidden';
    const changed = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      onResumeRef.current();
    };
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
}
