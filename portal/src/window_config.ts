import type { WindowStreamVideoCodecCapability } from './window_protocol.ts';
import { isRecord, optionalString } from './window_protocol.ts';

export type WindowStreamBackend = 'native-webrtc';
export type WindowStreamProfile = 'balanced' | 'quality' | 'performance' | 'low-bandwidth' | 'custom';
export type WindowStreamCodec = 'h264' | 'hevc';
export type WindowStreamColorMode =
  | 'srgb-full-range'
  | 'srgb-video-range'
  | 'rec709-full-range'
  | 'rec709-video-range';
export type WindowControlDelivery = 'focus-hid' | 'pid-only' | 'pid-then-hid' | 'hid-only';
export type H264Profile = 'baseline' | 'main' | 'high';
export type HevcProfile = 'main';

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
};

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

  return {
    backend: pickEnum(config, flags, env, {
      label: 'windowStream.backend',
      allowed: ['native-webrtc'] as const,
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
        allowed: ['srgb-full-range', 'srgb-video-range', 'rec709-full-range', 'rec709-video-range'] as const,
        flag: 'window-stream-color-mode',
        env: 'WEAVE_WINDOW_STREAM_COLOR_MODE',
        configPath: ['capture', 'colorMode'],
        fallback: 'srgb-video-range',
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
        allowed: ['h264', 'hevc'] as const,
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
  };
};

const codecMimeType = (codec: WindowStreamCodec) => codec === 'hevc' ? 'video/h265' : 'video/h264';

export const viewerSupportsCodec = (
  codec: WindowStreamCodec,
  videoCodecs: WindowStreamVideoCodecCapability[],
) => {
  if (codec === 'h264') return true;
  const expected = codecMimeType(codec);
  return videoCodecs.some((entry) => entry.mimeType.toLowerCase() === expected);
};

export const sessionSettingsFields = (config: ResolvedWindowStreamConfig) => ({
  maxFrameRate: config.maxFps,
  maxDimension: config.maxDimension,
  bitrate: Math.round(config.bitrateMbps * 1_000_000),
  codec: config.encoder.codec,
  h264Profile: config.encoder.h264Profile,
  hevcProfile: config.encoder.hevcProfile,
  hevcLevelId: config.encoder.hevcLevelId,
  hevcTierFlag: config.encoder.hevcTierFlag,
  hevcTxMode: config.encoder.hevcTxMode,
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
});
