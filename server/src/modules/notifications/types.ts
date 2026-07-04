export type WeaveNotificationPriority = 'low' | 'normal' | 'high';

export type WeaveNotificationSource = 'client' | 'server';

export type WeaveNotificationTarget = {
  threadId?: string;
  projectId?: string;
  workspaceId?: string;
  url?: string;
};

export type WeaveNotificationEvent = {
  id: string;
  kind: string;
  title: string;
  body?: string;
  createdAt: string;
  dedupeKey?: string;
  priority: WeaveNotificationPriority;
  target?: WeaveNotificationTarget;
  source: WeaveNotificationSource;
};

export type ServerNotificationInput = Omit<WeaveNotificationEvent, 'createdAt' | 'id' | 'source'> & {
  createdAt?: string;
  id?: string;
};

export type StoredNotificationEvent = {
  sequence: number;
  event: WeaveNotificationEvent;
};
