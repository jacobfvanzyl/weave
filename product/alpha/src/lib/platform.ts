export const isCapacitorPlatform = (platform: string) =>
  platform === "ios";

export const isElectronDesktop = () => window.weaveDesktop?.runtime === "electron";
