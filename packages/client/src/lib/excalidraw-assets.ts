declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const configureExcalidrawAssetPath = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw/', document.baseURI).toString();
};
