import { useEffect, useRef } from 'react';
import { useChatStore, type ChatThread } from '../../stores/chat-store';
import { dispatchNotificationEvent, handleNativeNotificationAction } from '../../lib/notifications/coordinator';
import { getNativeNotificationAdapter } from '../../lib/notifications/registry';
import { connectServerNotificationStream } from '../../lib/notifications/server-stream';
import type { WeaveNotificationEvent } from '../../lib/notifications/types';

const completedThreadBody = 'A background Weave thread finished.';

const createThreadCompletedEvent = (thread: ChatThread): WeaveNotificationEvent => ({
  id: `client:thread-completed:${thread.id}:${Date.now()}`,
  kind: 'thread.completed',
  title: 'Thread completed',
  body: completedThreadBody,
  createdAt: new Date().toISOString(),
  dedupeKey: `thread.completed:${thread.id}`,
  priority: 'normal',
  target: {
    threadId: thread.id,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}),
  },
  source: 'client',
});

export const NotificationHost = () => {
  const completedThreadIds = useChatStore(state => state.completedThreadIds);
  const threads = useChatStore(state => state.threads);
  const previousCompletedThreadIdsRef = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    const adapter = getNativeNotificationAdapter();
    return adapter?.onAction(handleNativeNotificationAction);
  }, []);

  useEffect(() => {
    return connectServerNotificationStream({
      onEvent: event => {
        void dispatchNotificationEvent(event);
      },
    });
  }, []);

  useEffect(() => {
    const previous = previousCompletedThreadIdsRef.current;
    const current = new Set(completedThreadIds);
    previousCompletedThreadIdsRef.current = current;
    if (!previous) return;

    for (const threadId of current) {
      if (previous.has(threadId)) continue;
      const thread = threads.find(item => item.id === threadId);
      if (thread) void dispatchNotificationEvent(createThreadCompletedEvent(thread));
    }
  }, [completedThreadIds, threads]);

  return null;
};
