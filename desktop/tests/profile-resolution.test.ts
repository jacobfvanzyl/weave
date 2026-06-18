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

type SkillSummary = {
  name: string;
  source: 'source' | 'global' | 'project';
  path: string;
  description?: string;
};

let expandPromptTemplate: (name: string, argsText: string, context?: unknown) => Promise<string | undefined>;
let listPromptSummaries: (context?: unknown) => Promise<unknown[]>;
let listResolvedProfileSkillSummaries: (resolved: any) => SkillSummary[];
let registerResolvedProfileSkills: (resolved: any) => string[];
let __profileSkillSourceTest: any;
let __profileResolverTest: any;
let builtinDefaultProfile: DynamicProfile;

beforeAll(async () => {
  const promptRegistryPath = new URL('../../server/src/mastra/prompt-templates/registry.ts', import.meta.url).href;
  const resolverPath = new URL('../../server/src/mastra/profiles/resolver.ts', import.meta.url).href;
  const skillSourcePath = new URL('../../server/src/mastra/profiles/skill-source.ts', import.meta.url).href;
  const promptRegistry = await import(promptRegistryPath);
  const resolver = await import(resolverPath);
  const skillSource = await import(skillSourcePath);
  expandPromptTemplate = promptRegistry.expandPromptTemplate;
  listPromptSummaries = promptRegistry.listPromptSummaries;
  listResolvedProfileSkillSummaries = skillSource.listResolvedProfileSkillSummaries;
  registerResolvedProfileSkills = skillSource.registerResolvedProfileSkills;
  __profileSkillSourceTest = skillSource.__profileSkillSourceTest;
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

  it('merges app, global, and project prompts with project precedence without profile filtering', async () => {
    const summaries = await listPromptSummaries({ resolvedProfile }) as Array<{ name: string; source: string; description: string }>;
    expect(summaries.map(prompt => prompt.name)).toEqual(['plan', 'review', 'ship', 'summarize']);
    expect(summaries.find(prompt => prompt.name === 'ship')).toEqual(expect.objectContaining({
      description: 'Project ship',
      source: 'project',
    }));
    expect(summaries.find(prompt => prompt.name === 'review')).toEqual(expect.objectContaining({
      description: 'Project review $ARGUMENTS',
      source: 'project',
    }));

    await expect(expandPromptTemplate('ship', 'now', { resolvedProfile })).resolves.toBe('Project ship now');
    await expect(expandPromptTemplate('review', 'now', { resolvedProfile })).resolves.toBe('Project review now');
  });
});

describe('dynamic skill resolution', () => {
  const resolvedProfile = {
    profile: profile('default', { skills: ['global-only'] }),
    profiles: [],
    selectedProfileId: 'default',
    agentFiles: [],
    globalSnapshot: {
      scope: 'global',
      checkedAt: '2026-06-03T00:00:00.000Z',
      files: [
        {
          kind: 'skill',
          path: '.config/weave/skills/global-only/SKILL.md',
          content: '---\nname: global-only\ndescription: Global only\n---\nGlobal only body\n',
        },
        {
          kind: 'skill',
          path: '.config/weave/skills/shared/SKILL.md',
          content: '---\nname: shared\ndescription: Global shared\n---\nGlobal shared body\n',
        },
      ],
    },
    projectSnapshot: {
      scope: 'project',
      checkedAt: '2026-06-03T00:00:00.000Z',
      files: [
        {
          kind: 'skill',
          path: '.weave/skills/shared/SKILL.md',
          content: '---\nname: shared\ndescription: Project shared\n---\nProject shared body\n',
        },
        {
          kind: 'skill',
          path: '.weave/skills/project-only/SKILL.md',
          content: '---\nname: project-only\ndescription: Project only\n---\nProject only body\n',
        },
      ],
    },
  };

  it('activates all discovered skills regardless of profile.skills', () => {
    const summaries = listResolvedProfileSkillSummaries(resolvedProfile);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'global-only', source: 'global', path: '.config/weave/skills/global-only/SKILL.md', description: 'Global only' }),
      expect.objectContaining({ name: 'shared', source: 'project', path: '.weave/skills/shared/SKILL.md', description: 'Project shared' }),
      expect.objectContaining({ name: 'project-only', source: 'project', path: '.weave/skills/project-only/SKILL.md', description: 'Project only' }),
    ]));
    expect(summaries.some(skill => skill.name === 'shared' && skill.source === 'global')).toBe(false);

    const paths = registerResolvedProfileSkills(resolvedProfile);
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/global\/global-only$/),
      expect.stringMatching(/\/project\/shared$/),
      expect.stringMatching(/\/project\/project-only$/),
    ]));
    expect(paths.filter(path => path.endsWith('/shared'))).toHaveLength(1);
  });

  it('merges duplicate skill names with project over global over source precedence', () => {
    const byName = __profileSkillSourceTest.mergeSkillRecords(
      [{ name: 'shared', source: 'source', path: 'skills/shared/SKILL.md', workspacePath: 'skills/shared', description: 'Source shared' }],
      [{ name: 'shared', source: 'global', path: '.config/weave/skills/shared/SKILL.md', workspacePath: '__global/shared', description: 'Global shared' }],
      [{ name: 'shared', source: 'project', path: '.weave/skills/shared/SKILL.md', workspacePath: '__project/shared', description: 'Project shared' }],
    );

    expect(byName.get('shared')).toEqual(expect.objectContaining({
      source: 'project',
      path: '.weave/skills/shared/SKILL.md',
      workspacePath: '__project/shared',
      description: 'Project shared',
    }));
  });
});
