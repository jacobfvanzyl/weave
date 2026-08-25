import { useMemo, useState } from 'react';
import { createAcpShowcaseTranscript } from '@/chat/acp-showcase';
import { type AcpTranscript, createTranscript, queueOptimisticPrompt, reduceAcpEvent } from '@/chat/acp-transcript';
import type {
  AlphaConnectionStatus,
  AlphaController,
  AlphaWorkspace,
  AlphaViewModel,
  AlphaWorkspaceFiles,
} from './alpha-controller';

export const MOCK_SCENARIOS = [
  'disconnected',
  'connecting',
  'empty',
  'sidebar',
  'chat',
  'busy',
  'error',
] as const;

export type MockScenario = typeof MOCK_SCENARIOS[number];

const WORKSPACES: AlphaWorkspace[] = [
  {
    id: 'workspace-weave',
    name: 'weave',
    threads: [
      {
        id: 'thread-wve-47',
        title: 'Rework Weave interface',
        agentName: 'weave-codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-24T08:54:00.000Z',
        workspaceId: 'workspace-weave',
      },
      {
        id: 'thread-acp-host',
        title: 'Direct ACP host acceptance',
        agentName: 'weave-codex',
        hostName: 'macbook',
        status: 'closed',
        updatedAt: '2026-08-23T17:22:00.000Z',
        workspaceId: 'workspace-weave',
      },
    ],
  },
  {
    id: 'workspace-odin',
    name: 'odin',
    threads: [
      {
        id: 'thread-spray-upload',
        title: 'Diagnose Spray Instruction upload',
        agentName: 'weave-codex',
        hostName: 'bazzite',
        status: 'closed',
        updatedAt: '2026-08-23T11:05:00.000Z',
        workspaceId: 'workspace-odin',
      },
      {
        id: 'thread-release',
        title: 'Upcoming release changes',
        agentName: 'weave-codex',
        hostName: 'macbook',
        status: 'closed',
        updatedAt: '2026-08-22T14:30:00.000Z',
        workspaceId: 'workspace-odin',
      },
    ],
  },
];

const MOCK_WORKSPACE_ENTRIES: Record<
  string,
  AlphaWorkspaceFiles['directories'][string]['entries']
> = {
  '': [
    { name: 'src', path: 'src', type: 'directory' },
    { name: 'README.md', path: 'README.md', type: 'file', size: 36 },
  ],
  src: [{ name: 'main.ts', path: 'src/main.ts', type: 'file', size: 44 }],
};

const MOCK_FILE_CONTENT: Record<string, string> = {
  'README.md': '# Mock Workspace\n\nBrowse files locally.\n',
  'src/main.ts': "export const marker = 'WVE42_MOCK_WORKSPACE';\n",
};

const scenarioConnection = (scenario: MockScenario): AlphaConnectionStatus => {
  if (scenario === 'disconnected') return 'disconnected';
  if (scenario === 'connecting') return 'connecting';
  return 'connected';
};

const scenarioTranscript = (scenario: MockScenario) => {
  if (scenario !== 'sidebar' && scenario !== 'chat' && scenario !== 'busy' && scenario !== 'error') {
    return undefined;
  }
  const transcript = createAcpShowcaseTranscript();
  return scenario === 'busy' ? reduceAcpEvent(transcript, { type: 'turn/started' }) : transcript;
};

export const mockScenarioFromLocation = (): MockScenario | undefined => {
  if (!import.meta.env.DEV) return undefined;
  const requested = new URLSearchParams(window.location.search).get('mock');
  return MOCK_SCENARIOS.find((scenario) => scenario === requested);
};

export function useMockAlphaController(scenario: MockScenario): AlphaController {
  const [connectionStatus, setConnectionStatus] = useState(
    scenarioConnection(scenario),
  );
  const [hostUrl, setHostUrl] = useState('bazzite');
  const [accessToken, setAccessToken] = useState('mock-token');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState(
    scenario === 'sidebar' || scenario === 'chat' || scenario === 'busy' || scenario === 'error'
      ? 'thread-wve-47'
      : undefined,
  );
  const [transcript, setTranscript] = useState<AcpTranscript | undefined>(
    () => scenarioTranscript(scenario),
  );
  const [workspaceFiles, setWorkspaceFiles] = useState<AlphaWorkspaceFiles | undefined>(() =>
    selectedThreadId
      ? {
        workspaceId: 'workspace-weave',
        workspaceName: 'weave',
        openFiles: [],
        directories: {
          '': { entries: MOCK_WORKSPACE_ENTRIES[''], truncated: false },
        },
      }
      : undefined
  );
  const [workspaces, setWorkspaces] = useState<AlphaWorkspace[]>(
    scenario === 'empty' ? WORKSPACES.map((workspace) => ({ ...workspace, threads: [] })) : WORKSPACES,
  );

  const model = useMemo<AlphaViewModel>(() => ({
    platform: 'mock',
    connection: {
      status: connectionStatus,
      hostUrl,
      hostName: 'bazzite',
    },
    accessToken,
    searchQuery,
    workspaces,
    selectedThreadId,
    transcript,
    workspaceFiles,
    busy: scenario === 'busy',
    error: scenario === 'error' ? 'Portal lost the connection to this host.' : undefined,
  }), [
    accessToken,
    connectionStatus,
    hostUrl,
    scenario,
    searchQuery,
    selectedThreadId,
    transcript,
    workspaceFiles,
    workspaces,
  ]);

  return {
    model,
    actions: {
      setHostUrl,
      setAccessToken,
      setSearchQuery,
      connect: () => setConnectionStatus('connected'),
      disconnect: () => {
        setConnectionStatus('disconnected');
        setWorkspaceFiles(undefined);
      },
      refresh: () => undefined,
      createThread: (workspaceId) => {
        const targetId = workspaceId || workspaces[0]?.id;
        if (!targetId) return;
        const id = `mock-thread-${Date.now()}`;
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.id === targetId
              ? {
                ...workspace,
                threads: [{
                  id,
                  title: 'New thread',
                  agentName: 'weave-codex',
                  hostName: 'bazzite',
                  status: 'active',
                  updatedAt: new Date().toISOString(),
                  workspaceId: workspace.id,
                }, ...workspace.threads],
              }
              : workspace
          )
        );
        setSelectedThreadId(id);
        setTranscript(createTranscript(id));
        const workspace = workspaces.find((candidate) => candidate.id === targetId);
        if (workspace) {
          setWorkspaceFiles({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            openFiles: [],
            directories: {
              '': { entries: MOCK_WORKSPACE_ENTRIES[''], truncated: false },
            },
          });
        }
      },
      selectThread: (threadId) => {
        const thread = workspaces.flatMap((workspace) => workspace.threads)
          .find((candidate) => candidate.id === threadId);
        const workspace = workspaces.find((candidate) => candidate.id === thread?.workspaceId);
        setSelectedThreadId(threadId);
        setTranscript(createAcpShowcaseTranscript());
        setWorkspaceFiles(workspace
          ? {
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            openFiles: [],
            directories: {
              '': { entries: MOCK_WORKSPACE_ENTRIES[''], truncated: false },
            },
          }
          : undefined);
      },
      openWorkspaceDirectory: (path) => {
        setWorkspaceFiles((current) => current
          ? {
            ...current,
            directories: current.directories[path]
              ? current.directories
              : {
                ...current.directories,
                [path]: { entries: MOCK_WORKSPACE_ENTRIES[path] ?? [], truncated: false },
              },
          }
          : current);
      },
      openWorkspaceFile: (path) => {
        const content = MOCK_FILE_CONTENT[path];
        if (content === undefined) return;
        setWorkspaceFiles((current) => current
          ? {
            ...current,
            openFiles: current.openFiles.some((file) => file.path === path)
              ? current.openFiles
              : [...current.openFiles, {
                kind: 'text',
                path,
                content,
                contentHash: '0'.repeat(64),
                size: new TextEncoder().encode(content).byteLength,
                changed: false,
              }],
            activeFilePath: path,
          }
          : current);
      },
      activateWorkspaceFile: (path) => {
        setWorkspaceFiles((current) => current?.openFiles.some((file) => file.path === path)
          ? { ...current, activeFilePath: path }
          : current);
      },
      closeWorkspaceFile: (path) => {
        setWorkspaceFiles((current) => {
          if (!current) return current;
          const closingIndex = current.openFiles.findIndex((file) => file.path === path);
          if (closingIndex === -1) return current;
          return {
            ...current,
            openFiles: current.openFiles.filter((file) => file.path !== path),
            activeFilePath: current.activeFilePath === path
              ? current.openFiles[closingIndex + 1]?.path ?? current.openFiles[closingIndex - 1]?.path
              : current.activeFilePath,
          };
        });
      },
      reloadWorkspaceFile: () => {
        setWorkspaceFiles((current) => current
          ? {
            ...current,
            openFiles: current.openFiles.map((file) =>
              file.kind === 'text' && file.path === current.activeFilePath
                ? { ...file, changed: false }
                : file
            ),
          }
          : current);
      },
      sendPrompt: (text) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(
              queueOptimisticPrompt(
                current,
                `mock-local-${Date.now()}`,
                [{ type: 'text', text }],
              ),
              { type: 'turn/started' },
            )
            : current
        ),
      cancelPrompt: () =>
        setTranscript((current) =>
          current ? reduceAcpEvent(current, { type: 'turn/stopped', stopReason: 'cancelled' }) : current
        ),
      respondToPermission: (requestId, optionId) =>
        setTranscript((current) =>
          current ? reduceAcpEvent(current, { type: 'permission/resolved', requestId, optionId }) : current
        ),
      respondToElicitation: (requestId, response) =>
        setTranscript((current) =>
          current ? reduceAcpEvent(current, { type: 'elicitation/resolved', requestId, response }) : current
        ),
      setMode: (modeId) =>
        setTranscript((current) =>
          current
            ? reduceAcpEvent(current, {
              type: 'session/update',
              update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
            })
            : current
        ),
      setConfigOption: (optionId, value) =>
        setTranscript((current) => {
          if (!current) return current;
          return {
            ...current,
            configOptions: current.configOptions.map((option) =>
              option.id === optionId ? { ...option, currentValue: value } as typeof option : option
            ),
          };
        }),
    },
  };
}
