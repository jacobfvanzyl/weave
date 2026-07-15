import {
  type WeaveNotificationEvent,
  weaveNotificationEventSchema,
} from "@weave/protocol";

export type WeaveNotificationPriority = WeaveNotificationEvent["priority"];
export type WeaveNotificationSource = WeaveNotificationEvent["source"];
export type WeaveNotificationTarget = NonNullable<
  WeaveNotificationEvent["target"]
>;
export type { WeaveNotificationEvent } from "@weave/protocol";

export type NotificationPermissionState =
  | "unsupported"
  | "prompt"
  | "granted"
  | "denied";

export type NativeNotificationAction = {
  event: WeaveNotificationEvent;
  actionId: string;
  inputValue?: string;
};

export type NativeNotificationShowResult =
  | { delivered: true }
  | { delivered: false; reason: "failed" | "unsupported"; message?: string };

export type NativeNotificationAdapter = {
  getPermissionState: () =>
    | Promise<NotificationPermissionState>
    | NotificationPermissionState;
  requestPermission: () => Promise<NotificationPermissionState>;
  show: (event: WeaveNotificationEvent) =>
    | Promise<NativeNotificationShowResult | void>
    | NativeNotificationShowResult
    | void;
  clear: (id?: string) => Promise<void> | void;
  onAction: (
    listener: (action: NativeNotificationAction) => void,
  ) => () => void;
};

export const parseWeaveNotificationEvent = (
  value: unknown,
): WeaveNotificationEvent | undefined => {
  const parsed = weaveNotificationEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
