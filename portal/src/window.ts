import {
  type ResolvedWindowStreamConfig,
  resolveWindowStreamConfig,
  sessionSettingsFields,
  viewerSupportsCodec,
} from './window_config.ts';
import { ProcessWindowHostClient } from './window_host_client.ts';
import type {
  PortalApplicationInfo,
  PortalWindowInfo,
  WindowClientMessage,
  WindowHostEvent,
} from './window_protocol.ts';
import {
  isRecord,
  isWindowClientEnvelope,
  normalizeVideoCodecs,
  optionalString,
  toErrorMessage,
} from './window_protocol.ts';

export type { ResolvedWindowStreamConfig, WindowStreamConfig } from './window_config.ts';
export { resolveWindowStreamConfig } from './window_config.ts';
export { isWindowHostAvailable, resolveWindowHostRuntime } from './window_host_runtime.ts';
export type { WindowHostRuntime } from './window_host_runtime.ts';
export { ProcessWindowHostClient } from './window_host_client.ts';
export type {
  PortalApplicationInfo,
  PortalWindowInfo,
  WindowClientEnvelope,
  WindowClientMessage,
  WindowHostEvent,
  WindowStreamVideoCodecCapability,
} from './window_protocol.ts';
export { isWindowClientEnvelope } from './window_protocol.ts';

export type PortalWindowConfig = {
  portalId?: string;
  windowStream?: ResolvedWindowStreamConfig;
};

type WindowSession = {
  clientId: string;
  send: (event: WindowHostEvent) => void;
};

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

  async listApplications(): Promise<{ ok: true; applications: PortalApplicationInfo[] }> {
    const result = await this.helper.request({ type: 'applications.list' });
    const applications = Array.isArray(result.applications)
      ? result.applications.flatMap((item) => this.normalizeApplicationInfo(item))
      : [];
    return { ok: true, applications };
  }

  async openApplication(input: { applicationId?: string }): Promise<{ ok: true; application?: PortalApplicationInfo }> {
    const applicationId = optionalString(input.applicationId);
    if (!applicationId) throw new Error('applicationId is required.');
    const result = await this.helper.request({ type: 'applications.open', applicationId });
    const application = this.normalizeApplicationInfo(result.application)[0];
    return { ok: true, ...(application ? { application } : {}) };
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
      bundleIdentifier: optionalString(value.bundleIdentifier),
      pid: typeof value.pid === 'number' ? value.pid : undefined,
      x: typeof value.x === 'number' ? value.x : undefined,
      y: typeof value.y === 'number' ? value.y : undefined,
      width: typeof value.width === 'number' ? value.width : undefined,
      height: typeof value.height === 'number' ? value.height : undefined,
    }];
  }

  private normalizeApplicationInfo(value: unknown): PortalApplicationInfo[] {
    if (!isRecord(value)) return [];
    const id = optionalString(value.id);
    const name = optionalString(value.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      path: optionalString(value.path),
      bundleIdentifier: optionalString(value.bundleIdentifier),
      isRunning: typeof value.isRunning === 'boolean' ? value.isRunning : undefined,
      pids: Array.isArray(value.pids)
        ? value.pids.filter((pid): pid is number => typeof pid === 'number' && Number.isFinite(pid))
        : undefined,
      isActive: typeof value.isActive === 'boolean' ? value.isActive : undefined,
      iconDataUrl: optionalString(value.iconDataUrl),
    }];
  }
}
