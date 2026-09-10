interface Window {
  readonly weaveDesktop?: Readonly<{ runtime: 'electron'; platform: 'macos'; nativeTerminal?: import('./terminal/native-terminal').NativeTerminalBridge }>;
}
