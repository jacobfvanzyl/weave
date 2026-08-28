import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";

export function useAppResume(onResume: () => void) {
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    let wasInactive = false;
    const listener = App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        wasInactive = true;
        return;
      }
      if (!wasInactive) return;
      wasInactive = false;
      onResumeRef.current();
    });

    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, []);
}
