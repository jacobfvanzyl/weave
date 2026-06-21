import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19';
import { PortalWindowHost, resolveWindowStreamConfig } from './window.ts';

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

Deno.test('PortalWindowHost normalizes application and window metadata', async () => {
  const calls: Record<string, unknown>[] = [];
  const helper = {
    request: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      if (payload.type === 'windows.list') {
        return {
          windows: [
            {
              id: 'sck:1',
              title: 'Example',
              appName: 'Example App',
              bundleIdentifier: 'com.example.app',
              pid: 42,
              width: 800,
              malformed: true,
            },
            { title: 'missing id' },
          ],
        };
      }
      if (payload.type === 'applications.list') {
        return {
          applications: [
            {
              id: 'bundle:com.example.app',
              name: 'Example App',
              path: '/Applications/Example.app',
              bundleIdentifier: 'com.example.app',
              isRunning: true,
              pids: [42, 'bad', 43],
              isActive: true,
              iconDataUrl: 'data:image/png;base64,abc',
            },
            { id: 'missing-name' },
          ],
        };
      }
      throw new Error(`Unexpected payload: ${String(payload.type)}`);
    },
    dispose: () => undefined,
  };
  const host = new PortalWindowHost({
    config: { windowStream: resolveWindowStreamConfig({}, {}, {}) },
    helper: helper as any,
  });

  assertEquals(await host.list(), {
    ok: true,
    windows: [{
      id: 'sck:1',
      title: 'Example',
      appName: 'Example App',
      bundleIdentifier: 'com.example.app',
      pid: 42,
      x: undefined,
      y: undefined,
      width: 800,
      height: undefined,
    }],
  });
  assertEquals(await host.listApplications(), {
    ok: true,
    applications: [{
      id: 'bundle:com.example.app',
      name: 'Example App',
      path: '/Applications/Example.app',
      bundleIdentifier: 'com.example.app',
      isRunning: true,
      pids: [42, 43],
      isActive: true,
      iconDataUrl: 'data:image/png;base64,abc',
    }],
  });
  assertEquals(calls.map(call => call.type), ['windows.list', 'applications.list']);
});

Deno.test('PortalWindowHost validates and forwards application open requests', async () => {
  const calls: Record<string, unknown>[] = [];
  const helper = {
    request: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      return {
        application: {
          id: payload.applicationId,
          name: 'Example App',
          isRunning: true,
          pids: [42],
        },
      };
    },
    dispose: () => undefined,
  };
  const host = new PortalWindowHost({
    config: { windowStream: resolveWindowStreamConfig({}, {}, {}) },
    helper: helper as any,
  });

  await assertRejects(
    () => host.openApplication({ applicationId: ' ' }),
    Error,
    'applicationId is required',
  );
  assertEquals(await host.openApplication({ applicationId: 'bundle:com.example.app' }), {
    ok: true,
    application: {
      id: 'bundle:com.example.app',
      name: 'Example App',
      path: undefined,
      bundleIdentifier: undefined,
      isRunning: true,
      pids: [42],
      isActive: undefined,
      iconDataUrl: undefined,
    },
  });
  assertEquals(calls, [{ type: 'applications.open', applicationId: 'bundle:com.example.app' }]);
});
