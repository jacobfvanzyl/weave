import type { ReactNode } from 'react';
import { WeaveAppShell } from '../app-shell/WeaveAppShell';

type ChatPageProps = {
  connectionSettingsButton?: ReactNode;
};

export const ChatPage = (props: ChatPageProps = {}) => <WeaveAppShell {...props} />;
