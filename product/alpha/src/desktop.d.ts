interface Window {
  readonly weaveDesktop?: Readonly<{ runtime: 'electron'; platform: 'macos'; setTopRailHeight?(height: number, overlayHeight: number): Promise<number>; nativeTerminal?: import('./terminal/native-terminal').NativeTerminalBridge }>;
}
