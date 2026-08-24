import { useMemo, useState } from 'react';
import type {
  AlphaConnectionStatus,
  AlphaController,
  AlphaProject,
  AlphaViewModel,
} from './alpha-controller';

export const MOCK_SCENARIOS = [
  'disconnected',
  'connecting',
  'empty',
  'sidebar',
  'busy',
  'error',
] as const;

export type MockScenario = typeof MOCK_SCENARIOS[number];

const PROJECTS: AlphaProject[] = [
  {
    id: 'workspace-weave',
    name: 'weave',
    threads: [
      {
        id: 'thread-wve-47',
        title: 'Rework Alpha interface',
        agentName: 'weave-codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-24T08:54:00.000Z',
        projectId: 'workspace-weave',
      },
      {
        id: 'thread-acp-host',
        title: 'Direct ACP host acceptance',
        agentName: 'weave-codex',
        hostName: 'macbook',
        status: 'closed',
        updatedAt: '2026-08-23T17:22:00.000Z',
        projectId: 'workspace-weave',
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
        projectId: 'workspace-odin',
      },
      {
        id: 'thread-release',
        title: 'Upcoming release changes',
        agentName: 'weave-codex',
        hostName: 'macbook',
        status: 'closed',
        updatedAt: '2026-08-22T14:30:00.000Z',
        projectId: 'workspace-odin',
      },
    ],
  },
];

const scenarioConnection = (scenario: MockScenario): AlphaConnectionStatus => {
  if (scenario === 'disconnected') return 'disconnected';
  if (scenario === 'connecting') return 'connecting';
  return 'connected';
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
  const [hostUrl, setHostUrl] = useState('ws://bazzite:4122');
  const [accessToken, setAccessToken] = useState('mock-token');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState(
    scenario === 'sidebar' || scenario === 'busy' || scenario === 'error'
      ? 'thread-wve-47'
      : undefined,
  );
  const [projects, setProjects] = useState<AlphaProject[]>(
    scenario === 'empty' ? PROJECTS.map((project) => ({ ...project, threads: [] })) : PROJECTS,
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
    projects,
    selectedThreadId,
    busy: scenario === 'busy',
    error: scenario === 'error' ? 'Portal lost the connection to this host.' : undefined,
  }), [
    accessToken,
    connectionStatus,
    hostUrl,
    scenario,
    searchQuery,
    selectedThreadId,
    projects,
  ]);

  return {
    model,
    actions: {
      setHostUrl,
      setAccessToken,
      setSearchQuery,
      connect: () => setConnectionStatus('connected'),
      disconnect: () => setConnectionStatus('disconnected'),
      refresh: () => undefined,
      createThread: (projectId) => {
        const targetId = projectId || projects[0]?.id;
        if (!targetId) return;
        const id = `mock-thread-${Date.now()}`;
        setProjects((current) => current.map((project) =>
          project.id === targetId
            ? {
              ...project,
              threads: [{
                id,
                title: 'New thread',
                agentName: 'weave-codex',
                hostName: 'bazzite',
                status: 'active',
                updatedAt: new Date().toISOString(),
                projectId: project.id,
              }, ...project.threads],
            }
            : project,
        ));
        setSelectedThreadId(id);
      },
      selectThread: setSelectedThreadId,
    },
  };
}
