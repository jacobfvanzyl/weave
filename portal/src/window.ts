export type PortalWindowConfig = {
  portalId?: string;
  windowStream?: ResolvedWindowStreamConfig;
};

export type PortalWindowInfo = {
  id: string;
  title?: string;
  appName?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type WindowStreamBackend = 'electron-sck' | 'native-webrtc';
export type WindowCaptureBackend = 'screencapturekit' | 'electron';
export type WindowStreamProfile = 'balanced' | 'quality' | 'performance' | 'low-bandwidth' | 'custom';
export type WindowStreamCodec = 'h264' | 'hevc' | 'av1';
export type WindowStreamColorMode = 'rec709-full-range' | 'rec709-video-range';
export type WindowControlDelivery = 'focus-hid' | 'pid-only' | 'pid-then-hid' | 'hid-only';
export type H264Profile = 'baseline' | 'main' | 'high';
export type HevcProfile = 'main';
export type Av1Packetization = 'temporal-unit' | 'obu';

export type WindowStreamVideoCodecCapability = {
  mimeType: string;
  clockRate?: number;
  sdpFmtpLine?: string;
};

export type WindowStreamConfig = {
  backend?: WindowStreamBackend;
  hostPath?: string | null;
  profile?: WindowStreamProfile;
  maxFps?: number;
  maxDimension?: number;
  bitrateMbps?: number;
  capture?: {
    showCursor?: boolean;
    queueDepth?: number;
    colorMode?: WindowStreamColorMode;
    pixelFormat?: 'nv12';
    scaleToFit?: boolean;
    preserveAspectRatio?: boolean;
    opaque?: boolean;
    ignoreGlobalClipSingleWindow?: boolean;
  };
  encoder?: {
    codec?: WindowStreamCodec;
    h264Profile?: H264Profile;
    hevcProfile?: HevcProfile;
    hevcLevelId?: number;
    hevcTierFlag?: 0 | 1;
    hevcTxMode?: 'SRST';
    av1Profile?: number;
    av1LevelIdx?: number;
    av1Tier?: 0 | 1;
    av1Packetization?: Av1Packetization;
    realtime?: boolean;
    hardwareAcceleration?: boolean;
    allowFrameReordering?: boolean;
    keyframeIntervalSeconds?: number;
    maxFrameDelayCount?: number;
  };
  backpressure?: {
    maxInFlightFrames?: number;
  };
  control?: {
    enabled?: boolean;
    delivery?: WindowControlDelivery;
  };
  electronFallback?: {
    electronPath?: string | null;
    appPath?: string | null;
    captureBackend?: WindowCaptureBackend;
    captureHelperPath?: string | null;
    maxFps?: number;
    maxDimension?: number;
    jpegQuality?: number;
  };
};

export type ResolvedWindowStreamConfig = {
  backend: WindowStreamBackend;
  hostPath?: string;
  profile: WindowStreamProfile;
  maxFps: number;
  maxDimension: number;
  bitrateMbps: number;
  capture: {
    showCursor: boolean;
    queueDepth: number;
    colorMode: WindowStreamColorMode;
    pixelFormat: 'nv12';
    scaleToFit: boolean;
    preserveAspectRatio: boolean;
    opaque: boolean;
    ignoreGlobalClipSingleWindow: boolean;
  };
  encoder: {
    codec: WindowStreamCodec;
    h264Profile: H264Profile;
    hevcProfile: HevcProfile;
    hevcLevelId: number;
    hevcTierFlag: 0 | 1;
    hevcTxMode: 'SRST';
    av1Profile: number;
    av1LevelIdx: number;
    av1Tier: 0 | 1;
    av1Packetization: Av1Packetization;
    realtime: boolean;
    hardwareAcceleration: boolean;
    allowFrameReordering: boolean;
    keyframeIntervalSeconds: number;
    maxFrameDelayCount: number;
  };
  backpressure: {
    maxInFlightFrames: number;
  };
  control: {
    enabled: boolean;
    delivery: WindowControlDelivery;
  };
  electronFallback: {
    electronPath?: string;
    appPath?: string;
    captureBackend: WindowCaptureBackend;
    captureHelperPath?: string;
    maxFps: number;
    maxDimension: number;
    jpegQuality: number;
  };
};

export type WindowClientMessage =
  | {
    type: 'start';
    sessionId: string;
    windowId?: string;
    iceServers?: unknown[];
    videoCodecs?: WindowStreamVideoCodecCapability[];
  }
  | { type: 'answer'; sessionId: string; answer: { type: 'answer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'ready'; sessionId: string }
  | { type: 'stop'; sessionId: string };

export type WindowHostEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'offer'; sessionId: string; offer: { type: 'offer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'stopped'; sessionId: string }
  | { type: 'error'; sessionId?: string; error: string }
  | { type: 'stats'; sessionId: string; stats: Record<string, unknown> };

export type WindowClientEnvelope = {
  type: 'window.client';
  clientId: string;
  sessionId?: string;
  message: WindowClientMessage;
};

type WindowSession = {
  clientId: string;
  send: (event: WindowHostEvent) => void;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultHelperRequestTimeoutMs = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isCliFlagRecord = (value: unknown): value is Record<string, string | boolean> =>
  Boolean(value && typeof value === 'object');

const profileDefaults: Record<WindowStreamProfile, { maxFps: number; maxDimension: number; bitrateMbps: number }> = {
  balanced: { maxFps: 60, maxDimension: 1920, bitrateMbps: 12 },
  quality: { maxFps: 60, maxDimension: 1920, bitrateMbps: 20 },
  performance: { maxFps: 30, maxDimension: 1440, bitrateMbps: 8 },
  'low-bandwidth': { maxFps: 30, maxDimension: 1280, bitrateMbps: 4 },
  custom: { maxFps: 60, maxDimension: 1920, bitrateMbps: 12 },
};

const parseEnumValue = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined => {
  const raw = optionalString(value)?.toLowerCase();
  if (!raw) return undefined;
  const match = allowed.find((candidate) => candidate.toLowerCase() === raw);
  if (!match) throw new Error(`${label} must be one of: ${allowed.join(', ')}.`);
  return match;
};

const parseNumberValue = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  return number;
};

const parseBooleanValue = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw new Error(`${label} must be a boolean.`);
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean.`);
};

const requireRange = (
  value: number,
  label: string,
  min: number,
  max: number,
  integer = false,
) => {
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
  }
  return value;
};

const optionalConfigString = (value: unknown) => optionalString(value) ?? undefined;

const configValue = (config: WindowStreamConfig | undefined, path: string[]) => {
  let current: unknown = config;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
};

const pickValue = (
  config: WindowStreamConfig | undefined,
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  input: {
    flag?: string;
    env?: string;
    configPath?: string[];
  },
) => {
  if (input.flag && flags[input.flag] !== undefined) return flags[input.flag];
  if (input.env && env[input.env] !== undefined) return env[input.env];
  return input.configPath ? configValue(config, input.configPath) : undefined;
};

const pickString = (
  config: WindowStreamConfig | undefined,
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  input: {
    flag?: string;
    env?: string;
    configPath?: string[];
    fallback?: string;
  },
) => optionalConfigString(pickValue(config, flags, env, input)) ?? input.fallback;

const pickEnum = <T extends string>(
  config: WindowStreamConfig | undefined,
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  input: {
    label: string;
    allowed: readonly T[];
    flag?: string;
    env?: string;
    configPath?: string[];
    fallback: T;
  },
) => parseEnumValue(pickValue(config, flags, env, input), input.allowed, input.label) ?? input.fallback;

const pickNumber = (
  config: WindowStreamConfig | undefined,
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  input: {
    label: string;
    flag?: string;
    env?: string;
    configPath?: string[];
    fallback: number;
    min: number;
    max: number;
    integer?: boolean;
  },
) =>
  requireRange(
    parseNumberValue(pickValue(config, flags, env, input), input.label) ?? input.fallback,
    input.label,
    input.min,
    input.max,
    input.integer,
  );

const pickBoolean = (
  config: WindowStreamConfig | undefined,
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  input: {
    label: string;
    flag?: string;
    env?: string;
    configPath?: string[];
    fallback: boolean;
  },
) => parseBooleanValue(pickValue(config, flags, env, input), input.label) ?? input.fallback;

export const resolveWindowStreamConfig = (
  config?: WindowStreamConfig,
  flags: Record<string, string | boolean> = {},
  env: Record<string, string | undefined> = Deno.env.toObject(),
): ResolvedWindowStreamConfig => {
  if (!isCliFlagRecord(flags)) throw new Error('Window stream flags must be a record.');
  const profile = pickEnum(config, flags, env, {
    label: 'windowStream.profile',
    allowed: ['balanced', 'quality', 'performance', 'low-bandwidth', 'custom'] as const,
    flag: 'window-stream-profile',
    env: 'WEAVE_WINDOW_STREAM_PROFILE',
    configPath: ['profile'],
    fallback: 'quality',
  });
  const preset = profileDefaults[profile];
  const bitrateEnv = env.WEAVE_WINDOW_STREAM_BITRATE_MBPS !== undefined
    ? env.WEAVE_WINDOW_STREAM_BITRATE_MBPS
    : env.WEAVE_WINDOW_STREAM_BITRATE !== undefined
    ? String(Number(env.WEAVE_WINDOW_STREAM_BITRATE) / 1_000_000)
    : undefined;

  const hevcTierFlag = pickNumber(config, flags, env, {
    label: 'windowStream.encoder.hevcTierFlag',
    flag: 'window-stream-hevc-tier-flag',
    configPath: ['encoder', 'hevcTierFlag'],
    fallback: 0,
    min: 0,
    max: 1,
    integer: true,
  }) as 0 | 1;
  const av1Tier = pickNumber(config, flags, env, {
    label: 'windowStream.encoder.av1Tier',
    flag: 'window-stream-av1-tier',
    configPath: ['encoder', 'av1Tier'],
    fallback: 0,
    min: 0,
    max: 1,
    integer: true,
  }) as 0 | 1;

  return {
    backend: pickEnum(config, flags, env, {
      label: 'windowStream.backend',
      allowed: ['native-webrtc', 'electron-sck'] as const,
      flag: 'window-stream-backend',
      env: 'WEAVE_WINDOW_STREAM_BACKEND',
      configPath: ['backend'],
      fallback: 'native-webrtc',
    }),
    hostPath: pickString(config, flags, env, {
      flag: 'window-stream-host',
      env: 'WEAVE_WINDOW_STREAM_HOST',
      configPath: ['hostPath'],
    }),
    profile,
    maxFps: pickNumber(config, flags, env, {
      label: 'windowStream.maxFps',
      flag: 'window-stream-max-fps',
      env: 'WEAVE_WINDOW_STREAM_MAX_FPS',
      configPath: ['maxFps'],
      fallback: preset.maxFps,
      min: 1,
      max: 60,
      integer: true,
    }),
    maxDimension: pickNumber(config, flags, env, {
      label: 'windowStream.maxDimension',
      flag: 'window-stream-max-dimension',
      env: 'WEAVE_WINDOW_STREAM_MAX_DIMENSION',
      configPath: ['maxDimension'],
      fallback: preset.maxDimension,
      min: 320,
      max: 4096,
      integer: true,
    }),
    bitrateMbps: requireRange(
      parseNumberValue(flags['window-stream-bitrate-mbps'], 'windowStream.bitrateMbps') ??
        parseNumberValue(bitrateEnv, 'windowStream.bitrateMbps') ??
        parseNumberValue(configValue(config, ['bitrateMbps']), 'windowStream.bitrateMbps') ??
        preset.bitrateMbps,
      'windowStream.bitrateMbps',
      0.5,
      250,
    ),
    capture: {
      showCursor: pickBoolean(config, flags, env, {
        label: 'windowStream.capture.showCursor',
        flag: 'window-stream-show-cursor',
        env: 'WEAVE_WINDOW_STREAM_SHOW_CURSOR',
        configPath: ['capture', 'showCursor'],
        fallback: false,
      }),
      queueDepth: pickNumber(config, flags, env, {
        label: 'windowStream.capture.queueDepth',
        flag: 'window-stream-capture-queue-depth',
        env: 'WEAVE_WINDOW_STREAM_CAPTURE_QUEUE_DEPTH',
        configPath: ['capture', 'queueDepth'],
        fallback: 3,
        min: 1,
        max: 8,
        integer: true,
      }),
      colorMode: pickEnum(config, flags, env, {
        label: 'windowStream.capture.colorMode',
        allowed: ['rec709-full-range', 'rec709-video-range'] as const,
        flag: 'window-stream-color-mode',
        env: 'WEAVE_WINDOW_STREAM_COLOR_MODE',
        configPath: ['capture', 'colorMode'],
        fallback: 'rec709-full-range',
      }),
      pixelFormat: pickEnum(config, flags, env, {
        label: 'windowStream.capture.pixelFormat',
        allowed: ['nv12'] as const,
        flag: 'window-stream-pixel-format',
        env: 'WEAVE_WINDOW_STREAM_PIXEL_FORMAT',
        configPath: ['capture', 'pixelFormat'],
        fallback: 'nv12',
      }),
      scaleToFit: pickBoolean(config, flags, env, {
        label: 'windowStream.capture.scaleToFit',
        flag: 'window-stream-scale-to-fit',
        env: 'WEAVE_WINDOW_STREAM_SCALE_TO_FIT',
        configPath: ['capture', 'scaleToFit'],
        fallback: true,
      }),
      preserveAspectRatio: pickBoolean(config, flags, env, {
        label: 'windowStream.capture.preserveAspectRatio',
        flag: 'window-stream-preserve-aspect-ratio',
        env: 'WEAVE_WINDOW_STREAM_PRESERVE_ASPECT_RATIO',
        configPath: ['capture', 'preserveAspectRatio'],
        fallback: true,
      }),
      opaque: pickBoolean(config, flags, env, {
        label: 'windowStream.capture.opaque',
        flag: 'window-stream-opaque',
        env: 'WEAVE_WINDOW_STREAM_OPAQUE',
        configPath: ['capture', 'opaque'],
        fallback: true,
      }),
      ignoreGlobalClipSingleWindow: pickBoolean(config, flags, env, {
        label: 'windowStream.capture.ignoreGlobalClipSingleWindow',
        flag: 'window-stream-ignore-global-clip-single-window',
        env: 'WEAVE_WINDOW_STREAM_IGNORE_GLOBAL_CLIP_SINGLE_WINDOW',
        configPath: ['capture', 'ignoreGlobalClipSingleWindow'],
        fallback: true,
      }),
    },
    encoder: {
      codec: pickEnum(config, flags, env, {
        label: 'windowStream.encoder.codec',
        allowed: ['h264', 'hevc', 'av1'] as const,
        flag: 'window-stream-codec',
        env: 'WEAVE_WINDOW_STREAM_CODEC',
        configPath: ['encoder', 'codec'],
        fallback: 'hevc',
      }),
      h264Profile: pickEnum(config, flags, env, {
        label: 'windowStream.encoder.h264Profile',
        allowed: ['baseline', 'main', 'high'] as const,
        flag: 'window-stream-h264-profile',
        env: 'WEAVE_WINDOW_STREAM_H264_PROFILE',
        configPath: ['encoder', 'h264Profile'],
        fallback: 'baseline',
      }),
      hevcProfile: pickEnum(config, flags, env, {
        label: 'windowStream.encoder.hevcProfile',
        allowed: ['main'] as const,
        flag: 'window-stream-hevc-profile',
        env: 'WEAVE_WINDOW_STREAM_HEVC_PROFILE',
        configPath: ['encoder', 'hevcProfile'],
        fallback: 'main',
      }),
      hevcLevelId: pickNumber(config, flags, env, {
        label: 'windowStream.encoder.hevcLevelId',
        flag: 'window-stream-hevc-level-id',
        env: 'WEAVE_WINDOW_STREAM_HEVC_LEVEL_ID',
        configPath: ['encoder', 'hevcLevelId'],
        fallback: 180,
        min: 1,
        max: 255,
        integer: true,
      }),
      hevcTierFlag,
      hevcTxMode: pickEnum(config, flags, env, {
        label: 'windowStream.encoder.hevcTxMode',
        allowed: ['SRST'] as const,
        flag: 'window-stream-hevc-tx-mode',
        env: 'WEAVE_WINDOW_STREAM_HEVC_TX_MODE',
        configPath: ['encoder', 'hevcTxMode'],
        fallback: 'SRST',
      }),
      av1Profile: pickNumber(config, flags, env, {
        label: 'windowStream.encoder.av1Profile',
        flag: 'window-stream-av1-profile',
        env: 'WEAVE_WINDOW_STREAM_AV1_PROFILE',
        configPath: ['encoder', 'av1Profile'],
        fallback: 0,
        min: 0,
        max: 2,
        integer: true,
      }),
      av1LevelIdx: pickNumber(config, flags, env, {
        label: 'windowStream.encoder.av1LevelIdx',
        flag: 'window-stream-av1-level-idx',
        env: 'WEAVE_WINDOW_STREAM_AV1_LEVEL_IDX',
        configPath: ['encoder', 'av1LevelIdx'],
        fallback: 5,
        min: 0,
        max: 31,
        integer: true,
      }),
      av1Tier,
      av1Packetization: pickEnum(config, flags, env, {
        label: 'windowStream.encoder.av1Packetization',
        allowed: ['temporal-unit', 'obu'] as const,
        flag: 'window-stream-av1-packetization',
        env: 'WEAVE_WINDOW_STREAM_AV1_PACKETIZATION',
        configPath: ['encoder', 'av1Packetization'],
        fallback: 'temporal-unit',
      }),
      realtime: pickBoolean(config, flags, env, {
        label: 'windowStream.encoder.realtime',
        flag: 'window-stream-realtime-encoder',
        env: 'WEAVE_WINDOW_STREAM_REALTIME_ENCODER',
        configPath: ['encoder', 'realtime'],
        fallback: true,
      }),
      hardwareAcceleration: pickBoolean(config, flags, env, {
        label: 'windowStream.encoder.hardwareAcceleration',
        flag: 'window-stream-hardware-acceleration',
        env: 'WEAVE_WINDOW_STREAM_HARDWARE_ACCELERATION',
        configPath: ['encoder', 'hardwareAcceleration'],
        fallback: true,
      }),
      allowFrameReordering: pickBoolean(config, flags, env, {
        label: 'windowStream.encoder.allowFrameReordering',
        flag: 'window-stream-allow-frame-reordering',
        env: 'WEAVE_WINDOW_STREAM_ALLOW_FRAME_REORDERING',
        configPath: ['encoder', 'allowFrameReordering'],
        fallback: false,
      }),
      keyframeIntervalSeconds: pickNumber(config, flags, env, {
        label: 'windowStream.encoder.keyframeIntervalSeconds',
        flag: 'window-stream-keyframe-interval-seconds',
        env: 'WEAVE_WINDOW_STREAM_KEYFRAME_INTERVAL_SECONDS',
        configPath: ['encoder', 'keyframeIntervalSeconds'],
        fallback: 2,
        min: 0.5,
        max: 10,
      }),
      maxFrameDelayCount: pickNumber(config, flags, env, {
        label: 'windowStream.encoder.maxFrameDelayCount',
        flag: 'window-stream-max-frame-delay-count',
        env: 'WEAVE_WINDOW_STREAM_MAX_FRAME_DELAY_COUNT',
        configPath: ['encoder', 'maxFrameDelayCount'],
        fallback: 0,
        min: 0,
        max: 4,
        integer: true,
      }),
    },
    backpressure: {
      maxInFlightFrames: pickNumber(config, flags, env, {
        label: 'windowStream.backpressure.maxInFlightFrames',
        flag: 'window-stream-max-in-flight-frames',
        env: 'WEAVE_WINDOW_STREAM_MAX_IN_FLIGHT_FRAMES',
        configPath: ['backpressure', 'maxInFlightFrames'],
        fallback: 3,
        min: 1,
        max: 8,
        integer: true,
      }),
    },
    control: {
      enabled: pickBoolean(config, flags, env, {
        label: 'windowStream.control.enabled',
        flag: 'window-control-enabled',
        env: 'WEAVE_WINDOW_CONTROL_ENABLED',
        configPath: ['control', 'enabled'],
        fallback: true,
      }),
      delivery: pickEnum(config, flags, env, {
        label: 'windowStream.control.delivery',
        allowed: ['focus-hid', 'pid-only', 'pid-then-hid', 'hid-only'] as const,
        flag: 'window-control-delivery',
        env: 'WEAVE_WINDOW_CONTROL_DELIVERY',
        configPath: ['control', 'delivery'],
        fallback: 'focus-hid',
      }),
    },
    electronFallback: {
      electronPath: pickString(config, flags, env, {
        flag: 'window-stream-electron',
        env: 'WEAVE_WINDOW_HOST_ELECTRON',
        configPath: ['electronFallback', 'electronPath'],
      }),
      appPath: pickString(config, flags, env, {
        flag: 'window-stream-electron-app',
        env: 'WEAVE_WINDOW_HOST_APP',
        configPath: ['electronFallback', 'appPath'],
      }),
      captureBackend: pickEnum(config, flags, env, {
        label: 'windowStream.electronFallback.captureBackend',
        allowed: ['screencapturekit', 'electron'] as const,
        flag: 'window-stream-electron-capture-backend',
        env: 'WEAVE_WINDOW_CAPTURE_BACKEND',
        configPath: ['electronFallback', 'captureBackend'],
        fallback: 'screencapturekit',
      }),
      captureHelperPath: pickString(config, flags, env, {
        flag: 'window-stream-capture-helper',
        env: 'WEAVE_WINDOW_CAPTURE_HELPER',
        configPath: ['electronFallback', 'captureHelperPath'],
      }),
      maxFps: pickNumber(config, flags, env, {
        label: 'windowStream.electronFallback.maxFps',
        flag: 'window-stream-electron-max-fps',
        env: 'WEAVE_WINDOW_ELECTRON_MAX_FPS',
        configPath: ['electronFallback', 'maxFps'],
        fallback: 20,
        min: 1,
        max: 60,
        integer: true,
      }),
      maxDimension: pickNumber(config, flags, env, {
        label: 'windowStream.electronFallback.maxDimension',
        flag: 'window-stream-electron-max-dimension',
        env: 'WEAVE_WINDOW_ELECTRON_MAX_DIMENSION',
        configPath: ['electronFallback', 'maxDimension'],
        fallback: 1920,
        min: 320,
        max: 4096,
        integer: true,
      }),
      jpegQuality: pickNumber(config, flags, env, {
        label: 'windowStream.electronFallback.jpegQuality',
        flag: 'window-stream-electron-jpeg-quality',
        env: 'WEAVE_WINDOW_ELECTRON_JPEG_QUALITY',
        configPath: ['electronFallback', 'jpegQuality'],
        fallback: 0.75,
        min: 0.1,
        max: 1,
      }),
    },
  };
};

const helperPathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') return undefined;
  return decodeURIComponent(url.pathname);
};

const joinPath = (...parts: string[]) => {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
  return joined === '' ? '.' : joined;
};

const dirname = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const defaultElectronPath = () =>
  helperPathFromFileUrl(new URL('../../desktop/node_modules/.bin/electron', import.meta.url));

const defaultWindowHostAppPath = () =>
  helperPathFromFileUrl(new URL('../window-host-electron/main.cjs', import.meta.url));

const defaultWindowCaptureHelperPaths = () =>
  [
    helperPathFromFileUrl(
      new URL('../native/window-capture-sck/.build/release/weave-window-capture-sck', import.meta.url),
    ),
    helperPathFromFileUrl(new URL('../dist/weave-window-capture-sck', import.meta.url)),
    joinPath(dirname(Deno.execPath()), 'weave-window-capture-sck'),
  ].filter((candidate): candidate is string => Boolean(candidate));

const defaultNativeWindowStreamHostPaths = () =>
  [
    helperPathFromFileUrl(
      new URL('../native/window-stream-native/build/weave-window-stream-native', import.meta.url),
    ),
    helperPathFromFileUrl(new URL('../dist/weave-window-stream-native', import.meta.url)),
    joinPath(dirname(Deno.execPath()), 'weave-window-stream-native'),
  ].filter((candidate): candidate is string => Boolean(candidate));

const isPathLike = (value: string) => value.includes('/');

const executableExists = async (path: string) => {
  const stat = await Deno.stat(path).catch(() => undefined);
  return Boolean(stat?.isFile);
};

const appPathExists = async (path: string) => {
  const stat = await Deno.stat(path).catch(() => undefined);
  return Boolean(stat?.isFile || stat?.isDirectory);
};

const findExecutableOnPath = async (command: string, env: Record<string, string | undefined>) => {
  for (const directory of (env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = joinPath(directory, command);
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
};

const resolveExecutable = async (
  configured: string | undefined,
  fallback: string | undefined,
  env: Record<string, string | undefined>,
) => {
  if (configured) {
    if (!isPathLike(configured)) return await findExecutableOnPath(configured, env) ?? configured;
    return await executableExists(configured) ? configured : undefined;
  }
  return fallback && await executableExists(fallback) ? fallback : undefined;
};

const resolveExecutableFromCandidates = async (
  configured: string | undefined,
  fallbacks: string[],
  env: Record<string, string | undefined>,
) => {
  if (configured) return await resolveExecutable(configured, undefined, env);
  for (const fallback of fallbacks) {
    if (await executableExists(fallback)) return fallback;
  }
  return undefined;
};

const resolveAppPath = async (configured: string | undefined, fallback: string | undefined) => {
  for (const candidate of [configured, fallback]) {
    if (candidate && await appPathExists(candidate)) return candidate;
  }
  return undefined;
};

export type WindowHostRuntime = {
  label: string;
  command: string;
  args: string[];
  streamBackend: WindowStreamBackend;
  env: Record<string, string>;
  electronPath?: string;
  appPath?: string;
  captureBackend?: WindowCaptureBackend;
  captureHelperPath?: string;
  nativeHostPath?: string;
};

export const resolveWindowHostRuntime = async (
  env: Record<string, string | undefined> = Deno.env.toObject(),
  config: ResolvedWindowStreamConfig = resolveWindowStreamConfig(undefined, {}, env),
): Promise<WindowHostRuntime | undefined> => {
  if (Deno.build.os !== 'darwin') return undefined;
  const streamBackend = config.backend;
  if (streamBackend === 'native-webrtc') {
    const nativeHostPath = await resolveExecutableFromCandidates(
      config.hostPath,
      defaultNativeWindowStreamHostPaths(),
      env,
    );
    if (!nativeHostPath) return undefined;
    return {
      label: 'Native window stream host',
      command: nativeHostPath,
      args: [],
      streamBackend,
      nativeHostPath,
      env: {
        WEAVE_WINDOW_HOST_PROTOCOL: '1',
        WEAVE_WINDOW_STREAM_BACKEND: 'native-webrtc',
      },
    };
  }

  const electronPath = await resolveExecutable(
    config.electronFallback.electronPath,
    defaultElectronPath(),
    env,
  );
  const appPath = await resolveAppPath(config.electronFallback.appPath, defaultWindowHostAppPath());
  const captureBackend = config.electronFallback.captureBackend;
  const captureHelperPath = captureBackend === 'screencapturekit'
    ? await resolveExecutableFromCandidates(
      config.electronFallback.captureHelperPath,
      defaultWindowCaptureHelperPaths(),
      env,
    )
    : undefined;
  if (!electronPath || !appPath) return undefined;
  if (captureBackend === 'screencapturekit' && !captureHelperPath) return undefined;
  return {
    label: 'Electron window host',
    command: electronPath,
    args: [appPath],
    streamBackend,
    electronPath,
    appPath,
    captureBackend,
    captureHelperPath,
    env: {
      WEAVE_WINDOW_HOST_PROTOCOL: '1',
      WEAVE_WINDOW_STREAM_BACKEND: 'electron-sck',
      WEAVE_WINDOW_CAPTURE_BACKEND: captureBackend,
      ...(captureHelperPath ? { WEAVE_WINDOW_CAPTURE_HELPER: captureHelperPath } : {}),
    },
  };
};

export const isWindowHostAvailable = async (
  env?: Record<string, string | undefined>,
  config?: ResolvedWindowStreamConfig,
) => Boolean(await resolveWindowHostRuntime(env, config));

const windowHostRuntimeError = (env: Record<string, string | undefined>, config: ResolvedWindowStreamConfig) =>
  [
    'Window streaming host is unavailable.',
    'Install desktop dependencies and build the ScreenCaptureKit helpers, or set WEAVE_WINDOW_STREAM_BACKEND, WEAVE_WINDOW_STREAM_HOST, WEAVE_WINDOW_HOST_ELECTRON, WEAVE_WINDOW_HOST_APP, WEAVE_WINDOW_CAPTURE_HELPER, or WEAVE_WINDOW_CAPTURE_BACKEND=electron.',
    `WEAVE_WINDOW_STREAM_BACKEND=${config.backend}`,
    `WEAVE_WINDOW_STREAM_HOST=${config.hostPath ?? defaultNativeWindowStreamHostPaths()[0] ?? ''}`,
    `WEAVE_WINDOW_HOST_ELECTRON=${config.electronFallback.electronPath ?? defaultElectronPath() ?? ''}`,
    `WEAVE_WINDOW_HOST_APP=${config.electronFallback.appPath ?? defaultWindowHostAppPath() ?? ''}`,
    `WEAVE_WINDOW_CAPTURE_BACKEND=${config.electronFallback.captureBackend}`,
    `WEAVE_WINDOW_CAPTURE_HELPER=${
      config.electronFallback.captureHelperPath ?? defaultWindowCaptureHelperPaths()[0] ?? ''
    }`,
  ].join(' ');

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  const direct = optionalString(error);
  if (direct) return direct;
  if (isRecord(error)) {
    const nested = optionalString(error.message) ?? optionalString(error.error) ?? optionalString(error.reason);
    if (nested) return nested;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
};

const normalizeVideoCodecs = (value: unknown): WindowStreamVideoCodecCapability[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const mimeType = optionalString(item.mimeType);
    if (!mimeType) return [];
    return [{
      mimeType,
      clockRate: typeof item.clockRate === 'number' ? item.clockRate : undefined,
      sdpFmtpLine: optionalString(item.sdpFmtpLine),
    }];
  });
};

const codecMimeType = (codec: WindowStreamCodec) => {
  if (codec === 'hevc') return 'video/h265';
  if (codec === 'av1') return 'video/av1';
  return 'video/h264';
};

const viewerSupportsCodec = (
  codec: WindowStreamCodec,
  videoCodecs: WindowStreamVideoCodecCapability[],
) => {
  if (codec === 'h264') return true;
  const expected = codecMimeType(codec);
  return videoCodecs.some((entry) => entry.mimeType.toLowerCase() === expected);
};

const sessionSettingsFields = (config: ResolvedWindowStreamConfig) => ({
  maxFrameRate: config.maxFps,
  maxDimension: config.maxDimension,
  bitrate: Math.round(config.bitrateMbps * 1_000_000),
  codec: config.encoder.codec,
  h264Profile: config.encoder.h264Profile,
  hevcProfile: config.encoder.hevcProfile,
  hevcLevelId: config.encoder.hevcLevelId,
  hevcTierFlag: config.encoder.hevcTierFlag,
  hevcTxMode: config.encoder.hevcTxMode,
  av1Profile: config.encoder.av1Profile,
  av1LevelIdx: config.encoder.av1LevelIdx,
  av1Tier: config.encoder.av1Tier,
  av1Packetization: config.encoder.av1Packetization,
  realtime: config.encoder.realtime,
  hardwareAcceleration: config.encoder.hardwareAcceleration,
  allowFrameReordering: config.encoder.allowFrameReordering,
  keyframeIntervalSeconds: config.encoder.keyframeIntervalSeconds,
  maxFrameDelayCount: config.encoder.maxFrameDelayCount,
  showCursor: config.capture.showCursor,
  captureQueueDepth: config.capture.queueDepth,
  colorMode: config.capture.colorMode,
  pixelFormat: config.capture.pixelFormat,
  scaleToFit: config.capture.scaleToFit,
  preserveAspectRatio: config.capture.preserveAspectRatio,
  opaque: config.capture.opaque,
  ignoreGlobalClipSingleWindow: config.capture.ignoreGlobalClipSingleWindow,
  maxInFlightFrames: config.backpressure.maxInFlightFrames,
  controlEnabled: config.control.enabled,
  controlDelivery: config.control.delivery,
  electronMaxFrameRate: config.electronFallback.maxFps,
  electronMaxDimension: config.electronFallback.maxDimension,
  electronJpegQuality: config.electronFallback.jpegQuality,
});

class ProcessWindowHostClient {
  private readonly env: Record<string, string | undefined>;
  private readonly windowStream: ResolvedWindowStreamConfig;
  private readonly requestTimeoutMs: number;
  private process?: Deno.ChildProcess;
  private stdin?: WritableStreamDefaultWriter<Uint8Array>;
  private runtime?: WindowHostRuntime;
  private nextRequestId = 0;
  private buffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionListeners = new Map<string, Set<(event: WindowHostEvent) => void>>();

  constructor(options: {
    env?: Record<string, string | undefined>;
    windowStream?: ResolvedWindowStreamConfig;
    requestTimeoutMs?: number;
  } = {}) {
    this.env = options.env ?? Deno.env.toObject();
    this.windowStream = options.windowStream ?? resolveWindowStreamConfig(undefined, {}, this.env);
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultHelperRequestTimeoutMs;
  }

  async request(payload: Record<string, unknown>) {
    await this.ensureStarted();
    if (!this.stdin) throw new Error(`${this.runtime?.label ?? 'Window host'} is not writable.`);
    const id = `window_req_${++this.nextRequestId}`;
    const message = { id, ...payload };
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.runtime?.label ?? 'Window host'} timed out: ${String(payload.type)}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    await this.stdin.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
    return result;
  }

  onSessionEvent(sessionId: string, listener: (event: WindowHostEvent) => void) {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.runtime?.label ?? 'Window host'} stopped.`));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.stdin?.close().catch(() => undefined);
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.stdin = undefined;
  }

  private async ensureStarted() {
    if (this.process && this.stdin) return;
    this.runtime = await resolveWindowHostRuntime(this.env, this.windowStream);
    if (!this.runtime) throw new Error(windowHostRuntimeError(this.env, this.windowStream));

    const command = new Deno.Command(this.runtime.command, {
      args: this.runtime.args,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: this.runtime.env,
    });
    this.process = command.spawn();
    this.stdin = this.process.stdin.getWriter();
    void this.readStdout(this.process.stdout);
    void this.readStderr(this.process.stderr);
    void this.process.status.then((status) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} exited with code ${status.code}.`));
      this.process = undefined;
      this.stdin = undefined;
    }).catch((error) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} failed: ${toErrorMessage(error)}`));
      this.process = undefined;
      this.stdin = undefined;
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stdout) {
        this.buffer += textDecoder.decode(chunk, { stream: true });
        let newlineIndex = this.buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (line) this.handleLine(line);
          newlineIndex = this.buffer.indexOf('\n');
        }
      }
    } catch (error) {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} stdout failed: ${toErrorMessage(error)}`));
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stderr) {
        const text = textDecoder.decode(chunk).trim();
        if (text) console.error(`[window-host] ${text}`);
      }
    } catch {
      // Stderr is diagnostic only.
    }
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[window-host] invalid json: ${line}`);
      return;
    }

    if (typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok === false) {
        pending.reject(
          new Error(
            message.error === undefined
              ? `${this.runtime?.label ?? 'Window host'} request failed.`
              : toErrorMessage(message.error),
          ),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'session.event') {
      const event = isRecord(message.event) ? message.event as WindowHostEvent : undefined;
      const sessionId = optionalString(message.sessionId) ?? optionalString(event?.sessionId);
      if (!event || !sessionId) return;
      for (const listener of this.sessionListeners.get(sessionId) ?? []) listener(event);
    }
  }
}

export class PortalWindowHost {
  private readonly helper: ProcessWindowHostClient;
  private readonly windowStream: ResolvedWindowStreamConfig;
  private readonly sessions = new Map<string, WindowSession & { dispose: () => void }>();

  constructor(options: {
    config: PortalWindowConfig;
    helper?: ProcessWindowHostClient;
  }) {
    this.windowStream = options.config.windowStream ?? resolveWindowStreamConfig();
    this.helper = options.helper ?? new ProcessWindowHostClient({ windowStream: this.windowStream });
  }

  async list(): Promise<{ ok: true; windows: PortalWindowInfo[] }> {
    const result = await this.helper.request({ type: 'windows.list' });
    const windows = Array.isArray(result.windows)
      ? result.windows.flatMap((item) => this.normalizeWindowInfo(item))
      : [];
    return { ok: true, windows };
  }

  async handleClientMessage(
    clientId: string,
    message: WindowClientMessage,
    send: (event: WindowHostEvent) => void,
  ) {
    const sessionId = optionalString(message.sessionId);
    if (!sessionId) {
      send({ type: 'error', error: 'sessionId is required.' });
      return;
    }

    if (message.type === 'start') {
      const dispose = this.helper.onSessionEvent(sessionId, send);
      this.sessions.set(sessionId, { clientId, send, dispose });
      try {
        const videoCodecs = normalizeVideoCodecs(message.videoCodecs);
        const codec = this.windowStream.encoder.codec;
        if (!viewerSupportsCodec(codec, videoCodecs)) {
          throw new Error(
            `Window stream codec ${codec} is not supported by this viewer. Supported codecs: ${
              videoCodecs.map((entry) => entry.mimeType).filter(Boolean).join(', ') || 'h264 only'
            }.`,
          );
        }
        await this.helper.request({
          type: 'session.start',
          sessionId,
          windowId: message.windowId,
          iceServers: message.iceServers ?? [],
          videoCodecs,
          ...sessionSettingsFields(this.windowStream),
        });
      } catch (error) {
        send({ type: 'error', sessionId, error: toErrorMessage(error) });
      }
      return;
    }

    if (message.type === 'answer') {
      await this.forwardOrReport(sessionId, send, {
        type: 'session.answer',
        sessionId,
        answer: message.answer,
      });
      return;
    }

    if (message.type === 'ice-candidate') {
      await this.forwardOrReport(sessionId, send, {
        type: 'session.ice-candidate',
        sessionId,
        candidate: message.candidate,
      });
      return;
    }

    if (message.type === 'ready') {
      await this.forwardOrReport(sessionId, send, { type: 'session.ready', sessionId });
      return;
    }

    if (message.type === 'stop') {
      await this.stop(sessionId, send);
    }
  }

  detachClientsByPrefix(prefix: string) {
    for (const [sessionId, session] of this.sessions) {
      if (session.clientId.startsWith(prefix)) void this.stop(sessionId, session.send);
    }
  }

  dispose() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.helper.dispose();
  }

  private async stop(sessionId: string, send?: (event: WindowHostEvent) => void) {
    const session = this.sessions.get(sessionId);
    session?.dispose();
    this.sessions.delete(sessionId);
    await this.forwardOrReport(sessionId, send ?? session?.send, { type: 'session.stop', sessionId });
  }

  private async forwardOrReport(
    sessionId: string,
    send: ((event: WindowHostEvent) => void) | undefined,
    payload: Record<string, unknown>,
  ) {
    try {
      await this.helper.request(payload);
    } catch (error) {
      send?.({ type: 'error', sessionId, error: toErrorMessage(error) });
    }
  }

  private normalizeWindowInfo(value: unknown): PortalWindowInfo[] {
    if (!isRecord(value)) return [];
    const id = optionalString(value.id);
    if (!id) return [];
    return [{
      id,
      title: optionalString(value.title),
      appName: optionalString(value.appName),
      pid: typeof value.pid === 'number' ? value.pid : undefined,
      x: typeof value.x === 'number' ? value.x : undefined,
      y: typeof value.y === 'number' ? value.y : undefined,
      width: typeof value.width === 'number' ? value.width : undefined,
      height: typeof value.height === 'number' ? value.height : undefined,
    }];
  }
}

export const isWindowClientEnvelope = (message: Record<string, unknown>): message is WindowClientEnvelope =>
  message.type === 'window.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');
