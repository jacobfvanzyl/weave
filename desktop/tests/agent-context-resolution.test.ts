import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

type SkillSummary = {
  name: string;
  source: 'source' | 'global' | 'project';
  path: string;
  description?: string;
};

let expandPromptTemplate: (name: string, argsText: string, context?: unknown) => Promise<string | undefined>;
let listPromptSummaries: (context?: unknown) => Promise<unknown[]>;
let listResolvedContextSkillSummaries: (resolved: any) => SkillSummary[];
let registerResolvedContextSkills: (resolved: any) => string[];
let __contextSkillSourceTest: any;
let __agentContextResolverTest: any;
let __mageHandAgentTest: any;
let agentContextRequestContextKey: string;
let singletonAgentConfig: any;

beforeAll(async () => {
  const promptRegistryPath =
    new URL('../../server/src/agent/mastra/prompt-templates/registry.ts', import.meta.url).href;
  const resolverPath = new URL('../../server/src/agent/mastra/context/resolver.ts', import.meta.url).href;
  const skillSourcePath = new URL('../../server/src/agent/mastra/context/skill-source.ts', import.meta.url).href;
  const mageHandAgentPath = new URL('../../server/src/agent/mastra/agents/mage-hand-agent.ts', import.meta.url).href;
  const promptRegistry = await import(promptRegistryPath);
  const resolver = await import(resolverPath);
  const skillSource = await import(skillSourcePath);
  const mageHandAgent = await import(mageHandAgentPath);
  expandPromptTemplate = promptRegistry.expandPromptTemplate;
  listPromptSummaries = promptRegistry.listPromptSummaries;
  listResolvedContextSkillSummaries = skillSource.listResolvedContextSkillSummaries;
  registerResolvedContextSkills = skillSource.registerResolvedContextSkills;
  __contextSkillSourceTest = skillSource.__contextSkillSourceTest;
  __agentContextResolverTest = resolver.__agentContextResolverTest;
  __mageHandAgentTest = mageHandAgent.__mageHandAgentTest;
  agentContextRequestContextKey = resolver.agentContextRequestContextKey;
  singletonAgentConfig = resolver.singletonAgentConfig;
});

const snapshot = (scope: 'global' | 'project', files: any[]) => ({
  scope,
  checkedAt: '2026-06-03T00:00:00.000Z',
  files,
});

const resolvedContext = (patch: Record<string, unknown> = {}) => ({
  config: singletonAgentConfig,
  agentFiles: [],
  ...patch,
});

const requestContextFor = (context?: any) => ({
  get: (key: string) => key === agentContextRequestContextKey ? context : undefined,
});

describe('singleton agent context', () => {
  it('uses the singleton hybrid config', () => {
    expect(__agentContextResolverTest.singletonAgentConfig).toBe(singletonAgentConfig);
    expect(singletonAgentConfig.model).toBe(process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.5');
    expect(singletonAgentConfig.reasoningEffort).toBe('high');
    expect(singletonAgentConfig.serviceTier).toBeUndefined();
    expect(singletonAgentConfig.memory).toEqual({});
    expect(singletonAgentConfig.instructions).toBe(
      readFileSync(new URL('../../server/src/agent/mastra/context/base-instructions.md', import.meta.url), 'utf8')
        .trim(),
    );
    expect(singletonAgentConfig.instructions).toContain('research and repository work');
    expect(singletonAgentConfig.instructions).toContain('Inspect relevant files before changing code');
    expect(singletonAgentConfig.instructions).toContain('State assumptions when they affect correctness.');
    expect(singletonAgentConfig.instructions).toContain(
      "Prefer completing the user's request over explaining process.",
    );
    expect(singletonAgentConfig.instructions).toContain(
      'If a tool fails, report the failure and give the next best path.',
    );
    expect(singletonAgentConfig.instructions).toContain('Cite URLs when web tools are used.');
    expect(singletonAgentConfig.instructions).toContain(
      'Keep progress visible during longer work. Send brief user-visible status updates between tool batches, before making file edits, and periodically during long-running implementation or verification turns. These updates should state what you are doing or what you just learned, then continue working without waiting for the user unless they asked you to pause.',
    );
  });

  it('detects workspace and Portal-backed notes bindings from runtime context', () => {
    expect(__agentContextResolverTest.hasWorkspaceBinding(resolvedContext())).toBe(false);
    expect(__agentContextResolverTest.hasWorkspaceBinding(resolvedContext({
      threadMetadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      workspace: { id: 'workspace-1' },
    }))).toBe(true);
    expect(__agentContextResolverTest.hasPortalWorkspaceBinding(resolvedContext({
      threadMetadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      workspace: { id: 'workspace-1' },
      portalId: 'portal-1',
    }))).toBe(true);
    expect(__agentContextResolverTest.isPortalBackedNotesContext(resolvedContext({
      projectKind: 'notes',
      project: { notesStorage: { kind: 'remote' } },
    }))).toBe(false);
    expect(__agentContextResolverTest.isPortalBackedNotesContext(resolvedContext({
      projectKind: 'notes',
      project: { notesStorage: { kind: 'portal' } },
    }))).toBe(true);
  });
});

describe('context tool policy', () => {
  it('exposes only plain chat tools without a workspace context', () => {
    const keys = __mageHandAgentTest.toolKeysForContext(requestContextFor());
    expect([...keys].sort()).toEqual(['ask_user', 'renameThreadTool', 'webExtract', 'webSearch']);
  });

  it('adds Portal, Git, plan/proposal, and LSP tools for Git workspaces', () => {
    const keys = __mageHandAgentTest.toolKeysForContext(requestContextFor(resolvedContext({
      projectKind: 'git',
      threadMetadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      workspace: { id: 'workspace-1' },
      portalId: 'portal-1',
    })));
    expect([...keys]).toEqual(expect.arrayContaining([
      'read',
      'write',
      'edit',
      'bash',
      'editor_context',
      'git_status',
      'git_branch',
      'git_worktree',
      'updatePlanTool',
      'proposal_start',
      'proposal_read',
      'proposal_write',
      'proposal_edit',
      'proposal_delete',
      'proposal_discard',
      'proposal_status',
      'proposal_finalize',
      'proposal_mark',
      'code_diagnostics',
      'rename_preview',
    ]));
    expect(keys.has('file_read')).toBe(false);
  });

  it('adds notes file tools for notes workspaces and local tools only for Portal-backed notes', () => {
    const remoteNotesKeys = __mageHandAgentTest.toolKeysForContext(requestContextFor(resolvedContext({
      projectKind: 'notes',
      project: { notesStorage: { kind: 'remote' } },
      threadMetadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      workspace: { id: 'workspace-1' },
      portalId: 'portal-1',
    })));
    expect([...remoteNotesKeys]).toEqual(
      expect.arrayContaining(['file_index', 'file_read', 'file_write', 'editor_context']),
    );
    expect(remoteNotesKeys.has('bash')).toBe(false);
    expect(remoteNotesKeys.has('git_status')).toBe(false);

    const portalNotesKeys = __mageHandAgentTest.toolKeysForContext(requestContextFor(resolvedContext({
      projectKind: 'notes',
      project: { notesStorage: { kind: 'portal' } },
      threadMetadata: { mode: 'project', projectId: 'project-1', workspaceId: 'workspace-1' },
      workspace: { id: 'workspace-1' },
      portalId: 'portal-1',
    })));
    expect([...portalNotesKeys]).toEqual(expect.arrayContaining(['file_read', 'bash', 'read', 'write', 'edit']));
  });
});

describe('context prompt resolution', () => {
  const context = resolvedContext({
    globalSnapshot: snapshot('global', [
      {
        kind: 'prompt',
        path: '.config/weave/prompts/ship.md',
        content: '---\ndescription: Global ship\n---\nGlobal ship $ARGUMENTS\n',
      },
    ]),
    projectSnapshot: snapshot('project', [
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
    ]),
  });

  it('does not expose the removed bundled prompts', async () => {
    await expect(listPromptSummaries()).resolves.toEqual([]);

    for (const name of ['plan', 'review', 'summarize']) {
      await expect(expandPromptTemplate(name, 'now')).resolves.toBeUndefined();
    }
  });

  it('merges app, global, and project prompts with project precedence without profile filtering', async () => {
    const summaries = await listPromptSummaries({ resolvedContext: context }) as Array<
      { name: string; source: string; description: string }
    >;
    expect(summaries.map((prompt) => prompt.name)).toEqual(['review', 'ship']);
    expect(summaries.find((prompt) => prompt.name === 'ship')).toEqual(expect.objectContaining({
      description: 'Project ship',
      source: 'project',
    }));
    expect(summaries.find((prompt) => prompt.name === 'review')).toEqual(expect.objectContaining({
      description: 'Project review $ARGUMENTS',
      source: 'project',
    }));

    await expect(expandPromptTemplate('ship', 'now', { resolvedContext: context })).resolves.toBe('Project ship now');
    await expect(expandPromptTemplate('review', 'now', { resolvedContext: context })).resolves.toBe(
      'Project review now',
    );
  });
});

describe('context skill resolution', () => {
  const context = resolvedContext({
    globalSnapshot: snapshot('global', [
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
    ]),
    projectSnapshot: snapshot('project', [
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
    ]),
  });

  it('activates all discovered skills without profile allow-lists', () => {
    const summaries = listResolvedContextSkillSummaries(context);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'global-only',
        source: 'global',
        path: '.config/weave/skills/global-only/SKILL.md',
        description: 'Global only',
      }),
      expect.objectContaining({
        name: 'shared',
        source: 'project',
        path: '.weave/skills/shared/SKILL.md',
        description: 'Project shared',
      }),
      expect.objectContaining({
        name: 'project-only',
        source: 'project',
        path: '.weave/skills/project-only/SKILL.md',
        description: 'Project only',
      }),
    ]));
    expect(summaries.some((skill) => skill.name === 'shared' && skill.source === 'global')).toBe(false);

    const paths = registerResolvedContextSkills(context);
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/global\/global-only$/),
      expect.stringMatching(/\/project\/shared$/),
      expect.stringMatching(/\/project\/project-only$/),
    ]));
    expect(paths.filter((path) => path.endsWith('/shared'))).toHaveLength(1);
  });

  it('merges duplicate skill names with project over global over source precedence', () => {
    const byName = __contextSkillSourceTest.mergeSkillRecords(
      [{
        name: 'shared',
        source: 'source',
        path: 'skills/shared/SKILL.md',
        workspacePath: 'skills/shared',
        description: 'Source shared',
      }],
      [{
        name: 'shared',
        source: 'global',
        path: '.config/weave/skills/shared/SKILL.md',
        workspacePath: '__global/shared',
        description: 'Global shared',
      }],
      [{
        name: 'shared',
        source: 'project',
        path: '.weave/skills/shared/SKILL.md',
        workspacePath: '__project/shared',
        description: 'Project shared',
      }],
    );

    expect(byName.get('shared')).toEqual(expect.objectContaining({
      source: 'project',
      path: '.weave/skills/shared/SKILL.md',
      workspacePath: '__project/shared',
      description: 'Project shared',
    }));
  });
});
