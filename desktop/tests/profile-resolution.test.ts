import { beforeAll, describe, expect, it } from 'vitest';

type DynamicProfile = {
  id: string;
  name: string;
  source: 'builtin' | 'global';
  instructions: string;
  model?: string;
  reasoningEffort?: string;
  tools: string[];
  skills: string[];
  prompts: string[];
  mcp: string[];
  memory?: Record<string, unknown>;
};

let expandPromptTemplate: (name: string, argsText: string, context?: unknown) => Promise<string | undefined>;
let listPromptSummaries: (context?: unknown) => Promise<unknown[]>;
let __profileResolverTest: any;
let builtinDefaultProfile: DynamicProfile;

beforeAll(async () => {
  const promptRegistryPath = new URL('../../server/src/mastra/prompt-templates/registry.ts', import.meta.url).href;
  const resolverPath = new URL('../../server/src/mastra/profiles/resolver.ts', import.meta.url).href;
  const promptRegistry = await import(promptRegistryPath);
  const resolver = await import(resolverPath);
  expandPromptTemplate = promptRegistry.expandPromptTemplate;
  listPromptSummaries = promptRegistry.listPromptSummaries;
  __profileResolverTest = resolver.__profileResolverTest;
  builtinDefaultProfile = resolver.builtinDefaultProfile;
});

const profile = (id: string, patch: Partial<DynamicProfile> = {}): DynamicProfile => ({
  id,
  name: id,
  source: 'global',
  instructions: `${id} instructions`,
  model: `openai/${id}`,
  reasoningEffort: 'medium',
  tools: [],
  skills: [],
  prompts: [],
  mcp: [],
  ...patch,
});

describe('dynamic profile resolver', () => {
  it('uses requested profile before project-kind config defaults', () => {
    const profiles = [profile('default'), profile('thread'), profile('git-default')];

    const result = __profileResolverTest.selectProfile(profiles, {
      requestedProfileId: 'thread',
      projectKind: 'git',
      config: {
        projectKinds: {
          git: { profile: 'git-default' },
        },
      },
    });

    expect(result.profile.id).toBe('thread');
    expect(result.selectedProfileId).toBe('thread');
  });

  it('uses draft thread profile before project default and configured defaults', () => {
    const profiles = [profile('default'), profile('draft'), profile('project'), profile('git-default')];
    const config = {
      defaultProfiles: {
        git: 'git-default',
      },
    };

    const draftRequestedProfileId = __profileResolverTest.requestedProfileIdForContext({
      threadMetadata: { profileId: 'draft' },
      project: { defaultProfileId: 'project' },
    });
    expect(__profileResolverTest.selectProfile(profiles, {
      requestedProfileId: draftRequestedProfileId,
      projectKind: 'git',
      config,
    }).profile.id).toBe('draft');

    const projectRequestedProfileId = __profileResolverTest.requestedProfileIdForContext({
      threadMetadata: {},
      project: { defaultProfileId: 'project' },
    });
    expect(__profileResolverTest.selectProfile(profiles, {
      requestedProfileId: projectRequestedProfileId,
      projectKind: 'git',
      config,
    }).profile.id).toBe('project');

    expect(__profileResolverTest.selectProfile(profiles, {
      requestedProfileId: undefined,
      projectKind: 'git',
      config,
    }).profile.id).toBe('git-default');
  });

  it('uses project-kind config, then default, then builtin fallback', () => {
    const profiles = [profile('default'), profile('git-default')];
    expect(__profileResolverTest.selectProfile(profiles, {
      projectKind: 'git',
      config: { defaultProfiles: { git: 'git-default' } },
    }).profile.id).toBe('git-default');

    expect(__profileResolverTest.selectProfile([profile('default')], {
      projectKind: 'general',
      config: {},
    }).profile.id).toBe('default');

    expect(__profileResolverTest.selectProfile([], {
      projectKind: 'general',
      config: {},
    }).profile).toBe(builtinDefaultProfile);
  });
});

describe('dynamic prompt resolution', () => {
  const resolvedProfile = {
    profile: profile('default', { prompts: ['ship'] }),
    profiles: [],
    selectedProfileId: 'default',
    agentFiles: [],
    globalSnapshot: {
      scope: 'global',
      checkedAt: '2026-06-03T00:00:00.000Z',
      files: [
        {
          kind: 'prompt',
          path: '.config/weave/prompts/ship.md',
          content: '---\ndescription: Global ship\n---\nGlobal ship $ARGUMENTS\n',
        },
      ],
    },
    projectSnapshot: {
      scope: 'project',
      checkedAt: '2026-06-03T00:00:00.000Z',
      files: [
        {
          kind: 'prompt',
          path: '.weave/prompts/ship.md',
          content: '---\ndescription: Project ship\n---\nProject ship $ARGUMENTS\n',
        },
        {
          kind: 'prompt',
          path: '.weave/prompts/review.md',
          content: 'Project review $ARGUMENTS\n',
        },
      ],
    },
  };

  it('merges app, global, and project prompts with project precedence and profile filtering', async () => {
    await expect(listPromptSummaries({ resolvedProfile })).resolves.toEqual([
      expect.objectContaining({
        name: 'ship',
        description: 'Project ship',
        source: 'project',
      }),
    ]);

    await expect(expandPromptTemplate('ship', 'now', { resolvedProfile })).resolves.toBe('Project ship now');
    await expect(expandPromptTemplate('review', 'now', { resolvedProfile })).resolves.toBeUndefined();
  });
});
