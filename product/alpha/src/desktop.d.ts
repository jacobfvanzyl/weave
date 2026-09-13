interface Window {
  readonly weaveDesktop?: Readonly<{ runtime: 'electron'; platform: 'macos'; setTopRailHeight?(height: number, overlayHeight: number): Promise<number>; onTitlebarClick?(listener: (point: { x: number; y: number }) => void): () => void; onTitlebarPointer?(listener: (point: { x: number; y: number } | null) => void): () => void; nativeBrowser?: import('./browser/native-browser').NativeBrowserBridge; nativeTerminal?: import('./terminal/native-terminal').NativeTerminalBridge }>;
}
