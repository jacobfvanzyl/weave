import { getAuthHeaders, getMastraUrl } from './mastra-client';

export type DynamicProfileSummary = {
  id: string;
  name: string;
  source: 'builtin' | 'global';
  description?: string;
  model?: string;
  reasoningEffort?: string;
  tools: string[];
  skills: string[];
  prompts: string[];
  mcp: string[];
  memory?: Record<string, unknown>;
};

export type ResolvedProfileSourceFile = {
  kind?: string;
  path: string;
  size?: number;
  updatedAt?: string;
  content?: string;
};

export type ResolvedProfileSnapshot = {
  scope: 'global' | 'project';
  portalId?: string;
  basePath?: string;
  workspacePath?: string;
  checkedAt: string;
  files: ResolvedProfileSourceFile[];
};

export type ResolvedProfile = {
  profile: DynamicProfileSummary;
  selectedProfileId: string;
  candidateProfileId?: string;
  requestedProfileId?: string;
  threadProfileId?: string;
  projectDefaultProfileId?: string;
  projectKind?: 'general' | 'git';
  globalSnapshot?: ResolvedProfileSnapshot;
  projectSnapshot?: ResolvedProfileSnapshot;
  agentFiles: Array<ResolvedProfileSourceFile & { content: string }>;
};

export type ProfilesResponse = {
  profiles: DynamicProfileSummary[];
  resolved: ResolvedProfile;
};

export type ProfileResolutionContext = {
  threadId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  profileId?: string | null;
};

const normalizeContext = (context?: string | ProfileResolutionContext): ProfileResolutionContext =>
  typeof context === 'string' ? { threadId: context } : context ?? {};

export const profileParams = (context?: string | ProfileResolutionContext) => {
  const params = new URLSearchParams();
  const normalized = normalizeContext(context);
  if (normalized.threadId) params.set('threadId', normalized.threadId);
  if (normalized.projectId) params.set('projectId', normalized.projectId);
  if (normalized.workspaceId) params.set('workspaceId', normalized.workspaceId);
  if (normalized.profileId) params.set('profileId', normalized.profileId);
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const listProfiles = async (context?: string | ProfileResolutionContext) => {
  const response = await fetch(`${getMastraUrl()}/profiles${profileParams(context)}`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to list profiles: ${response.status}`);
  return response.json() as Promise<ProfilesResponse>;
};

export const getResolvedProfile = async (context?: string | ProfileResolutionContext) => {
  const response = await fetch(`${getMastraUrl()}/profiles/resolved${profileParams(context)}`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to resolve profile: ${response.status}`);
  return response.json() as Promise<ProfilesResponse>;
};
