import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import capacitorConfig from "../../capacitor.config";
import { configureNativeFullscreen } from "./use-native-fullscreen";

const statusBarBridge = () => ({
  setOverlaysWebView: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
});

describe("configureNativeFullscreen", () => {
  it("overlays and hides the iOS status bar without a transition", async () => {
    const statusBar = statusBarBridge();

    await configureNativeFullscreen("ios", statusBar);

    expect(statusBar.setOverlaysWebView).toHaveBeenCalledWith({
      overlay: true,
    });
    expect(statusBar.hide).toHaveBeenCalledWith({ animation: "NONE" });
    expect(statusBar.setOverlaysWebView.mock.invocationCallOrder[0]).toBeLessThan(
      statusBar.hide.mock.invocationCallOrder[0],
    );
  });

  it("leaves browser and non-iOS platforms unchanged", async () => {
    const statusBar = statusBarBridge();

    await configureNativeFullscreen("web", statusBar);

    expect(statusBar.setOverlaysWebView).not.toHaveBeenCalled();
    expect(statusBar.hide).not.toHaveBeenCalled();
  });

  it("starts iOS in the same fullscreen state before JavaScript boots", async () => {
    const infoPlist = await readFile(
      resolve(process.cwd(), "ios/App/App/Info.plist"),
      "utf8",
    );

    expect(capacitorConfig.plugins?.StatusBar).toMatchObject({
      overlaysWebView: true,
    });
    expect(infoPlist).toMatch(
      /<key>UIStatusBarHidden<\/key>\s*<true\/>/,
    );
  });
});
