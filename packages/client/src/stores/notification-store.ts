import { create } from 'zustand';

export type NotificationDeliveryFailure = {
  message: string;
  createdAt: string;
  eventKind?: string;
};

type NotificationSettingsState = {
  lastDeliveryFailure?: NotificationDeliveryFailure;
  setLastDeliveryFailure: (failure: NotificationDeliveryFailure | undefined) => void;
};

export const useNotificationSettingsStore = create<NotificationSettingsState>()(set => ({
  lastDeliveryFailure: undefined,
  setLastDeliveryFailure: lastDeliveryFailure => set({ lastDeliveryFailure }),
}));
