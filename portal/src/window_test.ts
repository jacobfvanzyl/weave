import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import { resolveWindowStreamConfig } from './window.ts';

Deno.test('window stream config resolves presets and defaults', () => {
  const config = resolveWindowStreamConfig(undefined, {}, {});
  assertEquals(config.backend, 'native-webrtc');
  assertEquals(config.profile, 'quality');
  assertEquals(config.maxFps, 60);
  assertEquals(config.maxDimension, 1920);
  assertEquals(config.bitrateMbps, 20);
  assertEquals(config.encoder.codec, 'hevc');
  assertEquals(config.capture.showCursor, false);
  assertEquals(config.capture.colorMode, 'srgb-video-range');
  assertEquals(config.control.enabled, true);
  assertEquals(config.control.delivery, 'focus-hid');
});

Deno.test('window stream config precedence is CLI over env over config over preset', () => {
  const config = resolveWindowStreamConfig(
    {
      profile: 'low-bandwidth',
      maxFps: 24,
      bitrateMbps: 5,
      encoder: { codec: 'h264' },
    },
    {
      'window-stream-max-fps': '60',
      'window-stream-codec': 'hevc',
    },
    {
      WEAVE_WINDOW_STREAM_MAX_FPS: '30',
      WEAVE_WINDOW_STREAM_BITRATE_MBPS: '9',
      WEAVE_WINDOW_STREAM_CODEC: 'h264',
      WEAVE_WINDOW_STREAM_COLOR_MODE: 'srgb-video-range',
      WEAVE_WINDOW_CONTROL_DELIVERY: 'hid-only',
    },
  );

  assertEquals(config.maxFps, 60);
  assertEquals(config.bitrateMbps, 9);
  assertEquals(config.encoder.codec, 'hevc');
  assertEquals(config.capture.colorMode, 'srgb-video-range');
  assertEquals(config.control.delivery, 'hid-only');
});

Deno.test('window stream config preserves legacy bitrate env in bps', () => {
  const config = resolveWindowStreamConfig({}, {}, { WEAVE_WINDOW_STREAM_BITRATE: '18000000' });
  assertEquals(config.bitrateMbps, 18);
});

Deno.test('window stream config parses codec-specific settings', () => {
  const config = resolveWindowStreamConfig(
    {
      encoder: {
        codec: 'hevc',
        hevcLevelId: 186,
        hevcTierFlag: 1,
      },
      capture: {
        showCursor: true,
        queueDepth: 4,
        colorMode: 'srgb-video-range',
      },
      backpressure: {
        maxInFlightFrames: 5,
      },
      control: {
        enabled: false,
        delivery: 'pid-only',
      },
    },
    {},
    {},
  );

  assertEquals(config.encoder.codec, 'hevc');
  assertEquals(config.encoder.hevcLevelId, 186);
  assertEquals(config.encoder.hevcTierFlag, 1);
  assertEquals(config.capture.showCursor, true);
  assertEquals(config.capture.queueDepth, 4);
  assertEquals(config.capture.colorMode, 'srgb-video-range');
  assertEquals(config.backpressure.maxInFlightFrames, 5);
  assertEquals(config.control.enabled, false);
  assertEquals(config.control.delivery, 'pid-only');
});

Deno.test('window stream config rejects invalid codec and ranges', async () => {
  await assertRejects(
    async () => resolveWindowStreamConfig({}, { 'window-stream-codec': 'vp9' }, {}),
    Error,
    'windowStream.encoder.codec',
  );
  await assertRejects(
    async () => resolveWindowStreamConfig({ maxFps: 120 }, {}, {}),
    Error,
    'windowStream.maxFps',
  );
  await assertRejects(
    async () => resolveWindowStreamConfig({}, { 'window-stream-color-mode': 'p3' }, {}),
    Error,
    'windowStream.capture.colorMode',
  );
  await assertRejects(
    async () => resolveWindowStreamConfig({}, { 'window-control-delivery': 'ax' }, {}),
    Error,
    'windowStream.control.delivery',
  );
  await assertRejects(
    async () => resolveWindowStreamConfig({}, { 'window-stream-backend': 'electron-sck' }, {}),
    Error,
    'windowStream.backend',
  );
  await assertRejects(
    async () => resolveWindowStreamConfig({}, { 'window-stream-codec': 'av1' }, {}),
    Error,
    'windowStream.encoder.codec',
  );
});
