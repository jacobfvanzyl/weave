import { parseFrontmatter } from '../prompt-templates/frontmatter';
import { listPortalConnections, requestPortalTool } from '../portal/registry';
import { registerResolvedProfileSkills } from './skill-source';

export type WeaveContextFileKind = 'config' | 'mcp' | 'profile' | 'prompt' | 'skill' | 'agents';

export type WeaveContextFile = {
  kind: WeaveContextFileKind;
  path: string;
  content: string;
  size?: number;
  updatedAt?: string;
};

export type WeaveContextSnapshot = {
  scope: 'global' | 'project';
  portalId?: string;
  basePath?: string;
  workspacePath?: string;
  files: WeaveContextFile[];
  checkedAt: string;
};

export type DynamicProfile = {
  id: string;
  name: string;
  source: 'builtin' | 'global';
  description?: string;
  instructions: string;
  model?: string;
  reasoningEffort?: string;
  tools: string[];
  skills: string[];
  prompts: string[];
  mcp: string[];
  memory?: Record<string, unknown>;
};

export type RuntimeProjectContext = {
  thread?: any;
  threadMetadata?: Record<string, unknown>;
  project?: Record<string, any>;
  projectKind?: 'general' | 'git' | 'notes';
  projectSnapshot?: WeaveContextSnapshot;
  agentFiles: WeaveContextFile[];
};

export type ResolvedProfileContext = RuntimeProjectContext & {
  profile: DynamicProfile;
  profiles: DynamicProfile[];
  globalSnapshot?: WeaveContextSnapshot;
  selectedProfileId: string;
  requestedProfileId?: string;
};

export type ProfileResolutionInput = {
  mastra: any;
  resourceId: string;
  threadId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  profileId?: unknown;
};

const agentId = 'mageHandAgent';
const projectThreadId = (projectId: string) => `__project__${projectId}`;
const portalSettingsThreadIdPrefix = '__portal_settings__';
const globalSnapshotRefreshMs = 30_000;
const projectSnapshotRefreshMs = 30_000;

export const profileRequestContextKey = 'weave.profile';
export const profileSkillPathsRequestContextKey = 'weave.profileSkillPaths';

export const builtinDefaultProfile: DynamicProfile = {
  id: 'builtin-default',
  name: 'Default',
  source: 'builtin',
  instructions:
    'You are Mage Hand, a helpful, concise assistant. Be direct, practical, and use available tools when they help.',
  model: process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.5',
  reasoningEffort: 'medium',
  tools: ['renameThreadTool', 'updatePlanTool', 'webSearch', 'webExtract'],
  skills: [],
  prompts: [],
  mcp: [],
  memory: { lastMessages: 10 },
};

const globalSnapshots = new Map<string, WeaveContextSnapshot>();
const projectSnapshots = new Map<string, WeaveContextSnapshot>();

const nowIso = () => new Date().toISOString();

const hashText = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const getMemory = async (mastra: any) => {
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const stale = (snapshot: WeaveContextSnapshot | undefined, refreshMs: number) =>
  !snapshot || Date.now() - Date.parse(snapshot.checkedAt) > refreshMs;

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const stringArray = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
  : typeof value === 'string' && value.trim()
  ? value.split(',').map(item => item.trim()).filter(Boolean)
  : [];

const parseJsonObject = (value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const profileIdFromPath = (path: string) => {
  const name = path.split('/').pop() ?? '';
  return name.endsWith('.md') ? name.slice(0, -3) : name;
};

const parseProfileFile = (file: WeaveContextFile): DynamicProfile | undefined => {
  const { data, content } = parseFrontmatter(file.content);
  const id = optionalString(data.id) ?? profileIdFromPath(file.path);
  if (!id) return undefined;
  const instructions = content.trim();
  if (!instructions) return undefined;

  return {
    id,
    name: optionalString(data.name) ?? id,
    source: 'global',
    description: optionalString(data.description),
    instructions,
    model: optionalString(data.model),
    reasoningEffort: optionalString(data['reasoning-effort']) ?? optionalString(data.reasoningEffort),
    tools: stringArray(data.tools),
    skills: stringArray(data.skills),
    prompts: stringArray(data.prompts),
    mcp: stringArray(data.mcp),
    memory: parseJsonObject(data.memory),
  };
};

const parseConfig = (snapshot: WeaveContextSnapshot | undefined) => {
  const file = snapshot?.files.find(item => item.kind === 'config');
  if (!file) return {};
  try {
    const parsed = JSON.parse(file.content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const getNestedString = (value: unknown, path: string[]) => {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return optionalString(current);
};

const configuredDefaultProfileId = (config: Record<string, unknown>, projectKind?: 'general' | 'git' | 'notes') =>
  (projectKind
    ? getNestedString(config, ['projectKinds', projectKind, 'profile'])
      ?? getNestedString(config, ['projectKinds', projectKind, 'profileId'])
      ?? getNestedString(config, ['defaults', 'projectKinds', projectKind])
      ?? getNestedString(config, ['defaultProfiles', projectKind])
    : undefined)
  ?? getNestedString(config, ['defaults', 'profile'])
  ?? getNestedString(config, ['defaults', 'profileId'])
  ?? optionalString(config.defaultProfile)
  ?? optionalString(config.defaultProfileId);

const parseProfiles = (snapshot: WeaveContextSnapshot | undefined) =>
  snapshot?.files.filter(file => file.kind === 'profile').flatMap(file => parseProfileFile(file) ?? []) ?? [];

const selectProfile = (
  profiles: DynamicProfile[],
  options: { requestedProfileId?: string; projectKind?: 'general' | 'git' | 'notes'; config: Record<string, unknown> },
) => {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const selectedProfileId = options.requestedProfileId
    ?? configuredDefaultProfileId(options.config, options.projectKind)
    ?? 'default';
  return {
    profile: byId.get(selectedProfileId) ?? byId.get('default') ?? builtinDefaultProfile,
    selectedProfileId,
  };
};

const requestedProfileIdForContext = (projectContext: Pick<RuntimeProjectContext, 'threadMetadata' | 'project'>) =>
  optionalString(projectContext.threadMetadata?.profileId)
  ?? optionalString(projectContext.project?.defaultProfileId);

const getPrimaryPortalId = async (memory: any, resourceId: string) => {
  const threadId = `${portalSettingsThreadIdPrefix}${await hashText(resourceId)}`;
  const thread = await memory.getThreadById({ threadId }).catch(() => undefined);
  const metadata = thread?.metadata as Record<string, unknown> | undefined;
  return optionalString(metadata?.primaryPortalId);
};

const discoverPortalContext = async (
  portalId: string,
  scope: 'global' | 'project',
  args: Record<string, unknown> = {},
) => {
  const result = await requestPortalTool({
    portalId,
    ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
    ...(typeof args.workspaceId === 'string' ? { workspaceId: args.workspaceId } : {}),
    ...(typeof args.rootId === 'string' ? { rootId: args.rootId } : {}),
    ...(typeof args.repoPath === 'string' ? { repoPath: args.repoPath } : {}),
    ...(typeof args.workspacePath === 'string' ? { workspacePath: args.workspacePath } : {}),
    tool: 'portal.context.discover',
    args: { scope },
    timeoutMs: 10_000,
  }) as { ok?: boolean; error?: string; scope?: string; basePath?: string; workspacePath?: string; files?: WeaveContextFile[] };
  if (result.ok === false) throw new Error(result.error ?? 'Portal context discovery failed');
  return {
    scope,
    portalId,
    basePath: optionalString(result.basePath),
    workspacePath: optionalString(result.workspacePath),
    files: Array.isArray(result.files) ? result.files.filter(file => file && typeof file.content === 'string' && typeof file.path === 'string') : [],
    checkedAt: nowIso(),
  } satisfies WeaveContextSnapshot;
};

const loadGlobalSnapshot = async (memory: any, resourceId: string) => {
  const cached = globalSnapshots.get(resourceId);
  if (!stale(cached, globalSnapshotRefreshMs)) return cached;

  const primaryPortalId = await getPrimaryPortalId(memory, resourceId);
  const portals = listPortalConnections(resourceId);
  const portal = primaryPortalId ? portals.find(item => item.portalId === primaryPortalId) : portals[0];
  if (!portal) return cached;

  try {
    const snapshot = await discoverPortalContext(portal.portalId, 'global');
    globalSnapshots.set(resourceId, snapshot);
    return snapshot;
  } catch (error) {
    console.warn('[profiles] global context discovery failed', error);
    return cached;
  }
};

const loadProjectSnapshot = async (project: Record<string, any>, workspace: Record<string, any> | undefined) => {
  const portalId = optionalString(workspace?.portalId) ?? optionalString(project.portalId);
  if (!portalId) return undefined;
  const workspacePath = optionalString(workspace?.path);
  const key = `${portalId}:${workspacePath ?? project.id ?? ''}`;
  const cached = projectSnapshots.get(key);
  if (!stale(cached, projectSnapshotRefreshMs)) return cached;

  try {
    const snapshot = await discoverPortalContext(portalId, 'project', {
      projectId: project.id,
      workspaceId: workspace?.id,
      rootId: project.portalRootId,
      repoPath: project.repoPath,
      workspacePath,
    });
    projectSnapshots.set(key, snapshot);
    return snapshot;
  } catch (error) {
    console.warn('[profiles] project context discovery failed', error);
    return cached;
  }
};

const getProjectContext = async (
  memory: any,
  resourceId: string,
  thread: any | undefined,
  threadMetadata: Record<string, unknown> | undefined,
): Promise<RuntimeProjectContext> => {
  if (threadMetadata?.mode !== 'project' || typeof threadMetadata.projectId !== 'string') {
    return { thread, threadMetadata, agentFiles: [] };
  }

  const projectThread = await memory.getThreadById({ threadId: projectThreadId(threadMetadata.projectId) }).catch(() => undefined);
  const project = projectThread?.metadata as Record<string, any> | undefined;
  if (!projectThread || projectThread.resourceId !== resourceId || project?.kind !== 'project') {
    return { thread, threadMetadata, agentFiles: [] };
  }

  const workspace = Array.isArray(project.workspaces) && typeof threadMetadata.workspaceId === 'string'
    ? project.workspaces.find((item: any) => item?.id === threadMetadata.workspaceId)
    : undefined;
  const projectSnapshot = await loadProjectSnapshot(project, workspace);
  return {
    thread,
    threadMetadata,
    project,
    projectKind: project.projectKind === 'git' || project.projectKind === 'notes' ? project.projectKind : 'general',
    projectSnapshot,
    agentFiles: projectSnapshot?.files.filter(file => file.kind === 'agents') ?? [],
  };
};

const getRuntimeProjectContext = async (
  memory: any,
  resourceId: string,
  input: Pick<ProfileResolutionInput, 'threadId' | 'projectId' | 'workspaceId' | 'profileId'>,
): Promise<RuntimeProjectContext> => {
  if (typeof input.threadId === 'string') {
    const thread = await memory.getThreadById({ threadId: input.threadId }).catch(() => undefined);
    if (thread?.resourceId === resourceId) {
      return getProjectContext(memory, resourceId, thread, thread.metadata as Record<string, unknown> | undefined);
    }
  }

  const draftProfileId = optionalString(input.profileId);
  const draftProjectId = optionalString(input.projectId);
  if (!draftProjectId) {
    return {
      threadMetadata: draftProfileId ? { profileId: draftProfileId } : undefined,
      agentFiles: [],
    };
  }

  const draftWorkspaceId = optionalString(input.workspaceId);
  return getProjectContext(memory, resourceId, undefined, {
    mode: 'project',
    projectId: draftProjectId,
    ...(draftWorkspaceId ? { workspaceId: draftWorkspaceId } : {}),
    ...(draftProfileId ? { profileId: draftProfileId } : {}),
  });
};

export const resolveProfileContext = async (input: ProfileResolutionInput): Promise<ResolvedProfileContext> => {
  const memory = await getMemory(input.mastra);
  const [globalSnapshot, projectContext] = await Promise.all([
    loadGlobalSnapshot(memory, input.resourceId),
    getRuntimeProjectContext(memory, input.resourceId, input),
  ]);
  const profiles = parseProfiles(globalSnapshot);
  const requestedProfileId = requestedProfileIdForContext(projectContext);
  const config = parseConfig(globalSnapshot);
  const { profile, selectedProfileId } = selectProfile(profiles, {
    requestedProfileId,
    projectKind: projectContext.projectKind,
    config,
  });

  return {
    ...projectContext,
    profile,
    profiles,
    globalSnapshot,
    requestedProfileId,
    selectedProfileId,
  };
};

export const putProfileContext = (requestContext: any, resolved: ResolvedProfileContext) => {
  requestContext?.set?.(profileRequestContextKey, resolved);
  requestContext?.set?.(profileSkillPathsRequestContextKey, registerResolvedProfileSkills(resolved));
};

export const getProfileContext = (requestContext: any) =>
  requestContext?.get?.(profileRequestContextKey) as ResolvedProfileContext | undefined;

export const listResolvedProfiles = async (input: ProfileResolutionInput) => {
  const resolved = await resolveProfileContext(input);
  const profiles = resolved.profiles.length ? resolved.profiles : [builtinDefaultProfile];
  return {
    profiles,
    resolved,
  };
};

export const __profileResolverTest = {
  configuredDefaultProfileId,
  parseConfig,
  parseProfiles,
  requestedProfileIdForContext,
  selectProfile,
};
