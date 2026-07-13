import { addRpcSubscription, onRpcNotification, rpcRequest } from '../mastra-client';
import { parseWeaveNotificationEvent, type WeaveNotificationEvent } from './types';
import { RpcRemoteError, rpcErrorCode } from '@weave/protocol';

type NotificationStreamOptions = {
  onEvent: (event: WeaveNotificationEvent) => void;
};

type NotificationSubscriptionResult = {
  subscriptionId?: unknown;
};

export const connectServerNotificationStream = ({ onEvent }: NotificationStreamOptions) => {
  let lastSequence = 0;
  let subscriptionId: string | undefined;

  const detachEvents = onRpcNotification('notification.event', raw => {
    if (!raw || typeof raw !== 'object') return;
    const event = raw as { subscriptionId?: unknown; sequence?: unknown; event?: unknown };
    if (subscriptionId && event.subscriptionId !== subscriptionId) return;
    const sequence = Number(event.sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return;
    const parsed = parseWeaveNotificationEvent(event.event);
    if (!parsed) return;
    lastSequence = sequence;
    onEvent(parsed);
  });

  const detachSubscription = addRpcSubscription(
    'notifications',
    'notification.subscribe',
    () => ({ afterSequence: lastSequence }),
    raw => {
      const result = raw && typeof raw === 'object' ? raw as NotificationSubscriptionResult : {};
      subscriptionId = typeof result.subscriptionId === 'string' ? result.subscriptionId : undefined;
    },
    async error => {
      if (!(error instanceof RpcRemoteError) || error.code !== rpcErrorCode.resumeGap) return;
      lastSequence = 0;
      const result = await rpcRequest<NotificationSubscriptionResult>('notification.subscribe', { afterSequence: 0 });
      subscriptionId = typeof result.subscriptionId === 'string' ? result.subscriptionId : undefined;
    },
  );

  return () => {
    detachEvents();
    detachSubscription();
    if (subscriptionId) void rpcRequest('notification.unsubscribe', { subscriptionId }).catch(() => undefined);
  };
};
