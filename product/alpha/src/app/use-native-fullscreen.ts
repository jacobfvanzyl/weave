import { Capacitor } from "@capacitor/core";
import { Animation, StatusBar } from "@capacitor/status-bar";
import { useEffect } from "react";

interface NativeStatusBarBridge {
  setOverlaysWebView(options: { overlay: boolean }): Promise<void>;
  hide(options: { animation: Animation }): Promise<void>;
}

export async function configureNativeFullscreen(
  platform = Capacitor.getPlatform(),
  statusBar: NativeStatusBarBridge = StatusBar,
) {
  if (platform !== "ios") return;

  await statusBar.setOverlaysWebView({ overlay: true });
  await statusBar.hide({ animation: Animation.None });
}

export function useNativeFullscreen() {
  useEffect(() => {
    void configureNativeFullscreen().catch((error: unknown) => {
      console.error("Unable to configure native fullscreen", error);
    });
  }, []);
}
