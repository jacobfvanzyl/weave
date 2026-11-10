import { useEffect, useRef } from 'react';

// Asking the app to show a thread from outside its shell: a notification's click or a
// `weave://thread/…` link on the Mac (`src/mac/shell.ts`). The shell answers by showing the
// thread's Session with the thread's Block in front; a request made before the shell is there, as
// from the link the app was opened with, waits for it.

let handler: ((key: string) => void) | undefined;
let waiting: string | undefined;

/** Shows the thread `key`, in its Session, once the app's shell is on screen. */
export function requestOpenThread(key: string) {
  if (handler) handler(key);
  else waiting = key;
}

/** Answers `requestOpenThread` while the component is mounted, starting with a request that waited. */
export function useOpenThreadRequests(open: (key: string) => void) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const own = (key: string) => latest.current(key);
    handler = own;
    if (waiting) {
      const key = waiting;
      waiting = undefined;
      own(key);
    }
    return () => {
      if (handler === own) handler = undefined;
    };
  }, []);
}
