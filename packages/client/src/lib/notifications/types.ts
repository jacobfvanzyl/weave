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

export type NotificationPermissionState = 'unsupported' | 'prompt' | 'granted' | 'denied';

export type NativeNotificationAction = {
  event: WeaveNotificationEvent;
  actionId: string;
  inputValue?: string;
};

export type NativeNotificationShowResult =
  | { delivered: true }
  | { delivered: false; reason: 'failed' | 'unsupported'; message?: string };

export type NativeNotificationAdapter = {
  getPermissionState: () => Promise<NotificationPermissionState> | NotificationPermissionState;
  requestPermission: () => Promise<NotificationPermissionState>;
  show: (event: WeaveNotificationEvent) =>
    | Promise<NativeNotificationShowResult | void>
    | NativeNotificationShowResult
    | void;
  clear: (id?: string) => Promise<void> | void;
  onAction: (listener: (action: NativeNotificationAction) => void) => () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isPriority = (value: unknown): value is WeaveNotificationPriority =>
  value === 'low' || value === 'normal' || value === 'high';

const isSource = (value: unknown): value is WeaveNotificationSource =>
  value === 'client' || value === 'server';

const parseTarget = (value: unknown): WeaveNotificationTarget | undefined => {
  if (!isRecord(value)) return undefined;
  const target: WeaveNotificationTarget = {
    ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
    ...(optionalString(value.projectId) ? { projectId: optionalString(value.projectId) } : {}),
    ...(optionalString(value.workspaceId) ? { workspaceId: optionalString(value.workspaceId) } : {}),
    ...(optionalString(value.url) ? { url: optionalString(value.url) } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
};

export const parseWeaveNotificationEvent = (value: unknown): WeaveNotificationEvent | undefined => {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id);
  const kind = optionalString(value.kind);
  const title = optionalString(value.title);
  const createdAt = optionalString(value.createdAt);
  const body = optionalString(value.body);
  const dedupeKey = optionalString(value.dedupeKey);
  const target = parseTarget(value.target);
  if (!id || !kind || !title || !createdAt || !isPriority(value.priority) || !isSource(value.source)) {
    return undefined;
  }

  return {
    id,
    kind,
    title,
    ...(body ? { body } : {}),
    createdAt,
    ...(dedupeKey ? { dedupeKey } : {}),
    priority: value.priority,
    ...(target ? { target } : {}),
    source: value.source,
  };
};
