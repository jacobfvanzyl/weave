import { onRpcConnectionState, onRpcNotification, rpcRequest } from '../mastra-client';
import { parseWeaveNotificationEvent, type WeaveNotificationEvent } from './types';
import { RpcRemoteError, rpcErrorCode } from '@weave/protocol';

type NotificationStreamOptions = {
  onEvent: (event: WeaveNotificationEvent) => void;
};

export const connectServerNotificationStream = ({ onEvent }: NotificationStreamOptions) => {
  let lastSequence = 0;
  let subscriptionId: string | undefined;
  let disposed = false;
  let subscribing = false;

  const detachEvents = onRpcNotification('notification.event', event => {
    if (subscriptionId && event.subscriptionId !== subscriptionId) return;
    const sequence = event.sequence;
    if (sequence <= lastSequence) return;
    const parsed = parseWeaveNotificationEvent(event.event);
    if (!parsed) return;
    lastSequence = sequence;
    onEvent(parsed);
  });

  const subscribe = async () => {
    if (disposed || subscribing) return;
    subscribing = true;
    try {
      const result = await rpcRequest('notification.subscribe', { afterSequence: lastSequence });
      if (!disposed) subscriptionId = result.subscriptionId;
    } catch (error) {
      if (!(error instanceof RpcRemoteError) || error.code !== rpcErrorCode.resumeGap) return;
      lastSequence = 0;
      const result = await rpcRequest('notification.subscribe', { afterSequence: 0 });
      if (!disposed) subscriptionId = result.subscriptionId;
    } finally {
      subscribing = false;
    }
  };
  const detachState = onRpcConnectionState(state => {
    if (state !== 'connected') {
      subscriptionId = undefined;
      return;
    }
    void subscribe();
  });
  void subscribe();

  return () => {
    disposed = true;
    detachEvents();
    detachState();
    if (subscriptionId) void rpcRequest('notification.unsubscribe', { subscriptionId }).catch(() => undefined);
  };
};
