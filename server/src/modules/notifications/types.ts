import type {
  StoredNotificationEvent as ProtocolStoredNotificationEvent,
  WeaveNotificationEvent as ProtocolWeaveNotificationEvent,
} from '@weave/protocol';

export type WeaveNotificationPriority = ProtocolWeaveNotificationEvent['priority'];

export type WeaveNotificationSource = ProtocolWeaveNotificationEvent['source'];

export type WeaveNotificationTarget = NonNullable<ProtocolWeaveNotificationEvent['target']>;
export type WeaveNotificationEvent = ProtocolWeaveNotificationEvent;

export type ServerNotificationInput = Omit<WeaveNotificationEvent, 'createdAt' | 'id' | 'source'> & {
  createdAt?: string;
  id?: string;
};

export type StoredNotificationEvent = ProtocolStoredNotificationEvent;
