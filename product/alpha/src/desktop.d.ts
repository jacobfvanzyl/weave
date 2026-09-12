interface Window {
  readonly weaveDesktop?: Readonly<{ runtime: 'electron'; platform: 'macos'; setTopRailHeight?(height: number, overlayHeight: number): Promise<number>; onTitlebarPointer?(listener: (point: { x: number; y: number } | null) => void): () => void; nativeTerminal?: import('./terminal/native-terminal').NativeTerminalBridge }>;
}
