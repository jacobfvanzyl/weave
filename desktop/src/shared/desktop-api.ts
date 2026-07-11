import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalWindowRecord,
} from './terminal';
import type {
  WorkspaceFileFile,
  WorkspaceFileDiffPreviewResult,
  WorkspaceFileHashResult,
  WorkspaceFileIndexResult,
  WorkspaceFileListResult,
  WorkspaceFileOperationResult,
  WorkspaceFileTarget,
  WorkspaceFileWatchEventEnvelope,
  WorkspaceFileWatchStartResult,
  WorkspaceFileWriteResult,
} from './workspace-file';
import type { LspSessionResult } from './language-intelligence';
import type {
  NativeNotificationAction,
  NativeNotificationShowResult,
  NotificationPermissionState,
  WeaveNotificationEvent,
} from '@weave/client/lib/notifications/types';

export type DesktopConnectionSettings = {
  mastraUrl: string;
  hasAuthToken: boolean;
};

export type DesktopConnectionInput = {
  mastraUrl: string;
  authToken?: string | null;
};

export type DesktopConnectionTestResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status?: number; error: string };

export type DesktopChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
};

export type WeaveDesktopBridge = {
  getConnectionSettings: () => Promise<DesktopConnectionSettings>;
  saveConnectionSettings: (input: DesktopConnectionInput) => Promise<DesktopConnectionSettings>;
  testConnection: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  openExternal: (url: string) => Promise<void>;
  connectChatGPT: () => Promise<DesktopChatGPTAuthStatus>;
  getPlatform: () => NodeJS.Platform;
  terminalSnapshot: () => Promise<TerminalWindowRecord[]>;
  terminalList: (input: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  terminalCreate: (input: TerminalTargetInput) => Promise<TerminalWindowRecord>;
  terminalStart: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  terminalInput: (terminalId: string, data: string) => Promise<void>;
  terminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (terminalId: string, input?: TerminalTargetInput) => Promise<void>;
  terminalDetach: (terminalId: string) => Promise<void>;
  onTerminalEvent: (listener: (event: TerminalHostEvent) => void) => () => void;
  workspaceFileList: (target: WorkspaceFileTarget, path?: string) => Promise<WorkspaceFileListResult>;
  workspaceFileRead: (target: WorkspaceFileTarget, path: string) => Promise<WorkspaceFileFile>;
  workspaceFileHash: (target: WorkspaceFileTarget, path: string) => Promise<WorkspaceFileHashResult>;
  workspaceFileDiffPreview: (target: WorkspaceFileTarget, path: string, diff: string) => Promise<WorkspaceFileDiffPreviewResult>;
  workspaceFileWrite: (target: WorkspaceFileTarget, path: string, content: string, version?: string) => Promise<WorkspaceFileWriteResult>;
  workspaceFileMkdir: (target: WorkspaceFileTarget, path: string) => Promise<WorkspaceFileOperationResult>;
  workspaceFileMove: (target: WorkspaceFileTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<WorkspaceFileOperationResult>;
  workspaceFileDelete: (target: WorkspaceFileTarget, path: string, recursive?: boolean) => Promise<WorkspaceFileOperationResult>;
  workspaceFileIndex: (target: WorkspaceFileTarget, path?: string) => Promise<WorkspaceFileIndexResult>;
  workspaceFileUpload: (
    target: WorkspaceFileTarget,
    path: string,
    base64Content: string,
    contentType?: string,
  ) => Promise<WorkspaceFileOperationResult>;
  workspaceFileWatchStart: (target: WorkspaceFileTarget, paths: string[]) => Promise<WorkspaceFileWatchStartResult>;
  workspaceFileWatchUpdate: (subscriptionId: string, paths: string[]) => Promise<WorkspaceFileWatchStartResult>;
  workspaceFileWatchStop: (subscriptionId: string) => Promise<void>;
  onWorkspaceFileWatchEvent: (listener: (event: WorkspaceFileWatchEventEnvelope) => void) => () => void;
  lspCreateSession: (target: WorkspaceFileTarget, path: string, languageId?: string, serverId?: string) => Promise<LspSessionResult>;
  nativeNotificationsGetPermissionState: () => Promise<NotificationPermissionState>;
  nativeNotificationsRequestPermission: () => Promise<NotificationPermissionState>;
  nativeNotificationsShow: (event: WeaveNotificationEvent) => Promise<NativeNotificationShowResult>;
  nativeNotificationsClear: (id?: string) => Promise<void>;
  onNativeNotificationAction: (listener: (action: NativeNotificationAction) => void) => () => void;
};
