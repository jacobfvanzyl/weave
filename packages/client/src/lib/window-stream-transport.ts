import { getAuthHeaders, getMastraUrl } from './mastra-client';
import type { WindowStreamControlMessage, WindowStreamInfo, WindowStreamSession } from './window-stream-types';

type WindowListResponse = {
  windows?: unknown[];
  error?: string;
};

type WindowSessionTokenResponse = {
  token: string;
  sessionId: string;
  portalId: string;
  wsUrl: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const getWindowStreamErrorMessage = (error: unknown): string => {
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

const parseJson = async <T>(response: Response): Promise<T> => {
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.text();
  let errorBody: unknown = body;
  try {
    errorBody = JSON.parse(body) as unknown;
  } catch {
    // Plain text error body.
  }
  throw new Error(getWindowStreamErrorMessage(errorBody));
};

const normalizeRtcDescription = (value: unknown): RTCSessionDescriptionInit | undefined => {
  if (!isRecord(value)) return undefined;
  const type = optionalString(value.type);
  const sdp = optionalString(value.sdp);
  if ((type !== 'offer' && type !== 'answer' && type !== 'pranswer' && type !== 'rollback') || !sdp) return undefined;
  return { type, sdp };
};

const sanitizeRemoteOffer = (description: RTCSessionDescriptionInit): RTCSessionDescriptionInit => {
  if (description.type !== 'offer' || !description.sdp) return description;
  const lines = description.sdp.split(/\r\n|\n/).filter(line => line && !line.startsWith('a=max-message-size:'));
  return { ...description, sdp: `${lines.join('\r\n')}\r\n` };
};

const normalizeLocalDescription = (description: RTCSessionDescriptionInit): RTCSessionDescriptionInit => {
  const type = description.type;
  if (!description.sdp || !type) return description;
  const sdp = description.sdp.replace(/\r\n|\n/g, '\r\n');
  return { type, sdp: sdp.endsWith('\r\n') ? sdp : `${sdp}\r\n` };
};

const normalizeWindow = (value: unknown): WindowStreamInfo[] => {
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
};

export const listWindowStreamWindows = async (portalId: string) => {
  const params = new URLSearchParams({ portalId });
  const result = await parseJson<WindowListResponse>(
    await fetch(`${getMastraUrl()}/window-sessions/windows?${params}`, { headers: getAuthHeaders() }),
  );
  return (result.windows ?? []).flatMap(normalizeWindow);
};

const requestWindowSessionToken = async (input: { portalId: string; windowId?: string }) =>
  parseJson<WindowSessionTokenResponse>(
    await fetch(`${getMastraUrl()}/window-sessions/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(input),
    }),
  );

const rtcConfig: RTCConfiguration = { iceServers: [] };
const windowStreamSetupTimeoutMs = 15_000;

export const startWindowStreamSession = async (input: {
  portalId: string;
  windowId?: string;
}): Promise<WindowStreamSession> => {
  if (typeof RTCPeerConnection !== 'function') throw new Error('WebRTC is not available in this client.');
  if (typeof WebSocket !== 'function') throw new Error('WebSocket signaling is not available in this client.');

  const token = await requestWindowSessionToken(input);
  const url = new URL(token.wsUrl);
  url.searchParams.set('token', token.token);

  const socket = new WebSocket(url);
  const peerConnection = new RTCPeerConnection(rtcConfig);
  let controlChannel: RTCDataChannel | undefined;
  const mediaStream = new MediaStream();
  const stateListeners = new Set<(state: RTCPeerConnectionState) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  const emitState = () => {
    for (const listener of stateListeners) listener(peerConnection.connectionState);
  };
  const emitError = (error: Error) => {
    for (const listener of errorListeners) listener(error);
  };

  peerConnection.ondatachannel = event => {
    if (event.channel.label !== 'control') return;
    controlChannel = event.channel;
  };
  peerConnection.ontrack = event => {
    const stream = event.streams[0];
    if (stream) {
      for (const track of stream.getVideoTracks()) mediaStream.addTrack(track);
      return;
    }
    mediaStream.addTrack(event.track);
  };
  peerConnection.onconnectionstatechange = emitState;
  peerConnection.onicecandidate = event => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate?.toJSON() ?? null }));
  };

  const close = () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    socket.close();
    controlChannel?.close();
    peerConnection.close();
    for (const track of mediaStream.getTracks()) track.stop();
  };

  const sendControl = (message: WindowStreamControlMessage) => {
    const channel = controlChannel;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(message));
  };

  await new Promise<void>((resolve, reject) => {
    let accepted = false;
    let resolved = false;
    let hasAnswered = false;
    let hasStarted = false;
    let hasRemoteDescription = false;
    const pendingRemoteCandidates: RTCIceCandidateInit[] = [];
    const setupTimeout = window.setTimeout(() => {
      fail(new Error('Window stream timed out before direct WebRTC connected.'));
    }, windowStreamSetupTimeoutMs);
    const fail = (error: Error) => {
      window.clearTimeout(setupTimeout);
      close();
      if (resolved) emitError(error);
      else reject(error);
    };
    const maybeResolve = () => {
      if (!hasAnswered || !hasStarted || resolved) return;
      resolved = true;
      window.clearTimeout(setupTimeout);
      resolve();
    };
    const addRemoteCandidate = async (candidate: RTCIceCandidateInit) => {
      if (!hasRemoteDescription) {
        pendingRemoteCandidates.push(candidate);
        return;
      }
      await peerConnection.addIceCandidate(candidate);
    };
    const flushRemoteCandidates = async () => {
      const candidates = pendingRemoteCandidates.splice(0);
      for (const candidate of candidates) await peerConnection.addIceCandidate(candidate);
    };

    socket.onerror = () => fail(new Error('Window stream signaling failed.'));
    socket.onclose = () => {
      if (!accepted) fail(new Error('Window stream signaling closed before acceptance.'));
    };
    socket.onmessage = event => {
      void (async () => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === 'window.accepted') {
          accepted = true;
          socket.send(JSON.stringify({ type: 'start' }));
          return;
        }

        if (message.type === 'offer') {
          const offer = normalizeRtcDescription(message.offer);
          if (!offer) throw new Error('Window stream offer was missing.');
          await peerConnection.setRemoteDescription(sanitizeRemoteOffer(offer));
          hasRemoteDescription = true;
          await flushRemoteCandidates();
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          socket.send(JSON.stringify({
            type: 'answer',
            answer: normalizeLocalDescription(peerConnection.localDescription ?? answer),
          }));
          hasAnswered = true;
          maybeResolve();
          return;
        }

        if (message.type === 'started') {
          hasStarted = true;
          maybeResolve();
          return;
        }

        if (message.type === 'ice-candidate') {
          if (message.candidate) await addRemoteCandidate(message.candidate as RTCIceCandidateInit);
          return;
        }

        if (message.type === 'error') {
          throw new Error(message.error === undefined ? 'Window stream failed.' : getWindowStreamErrorMessage(message.error));
        }
      })().catch(error => fail(error instanceof Error ? error : new Error(getWindowStreamErrorMessage(error))));
    };
  });

  return {
    sessionId: token.sessionId,
    portalId: token.portalId,
    mediaStream,
    sendControl,
    close,
    onError: listener => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onStateChange: listener => {
      stateListeners.add(listener);
      listener(peerConnection.connectionState);
      return () => stateListeners.delete(listener);
    },
  };
};
