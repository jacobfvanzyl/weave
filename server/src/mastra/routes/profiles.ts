import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { builtinDefaultProfile, listResolvedProfiles, type DynamicProfile, type ProfileResolutionInput, type WeaveContextSnapshot } from '../profiles/resolver';

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const profileSummary = (profile: DynamicProfile) => ({
  id: profile.id,
  name: profile.name,
  source: profile.source,
  description: profile.description,
  model: profile.model,
  reasoningEffort: profile.reasoningEffort,
  tools: profile.tools,
  skills: profile.skills,
  prompts: profile.prompts,
  mcp: profile.mcp,
  memory: profile.memory,
});

const snapshotSummary = (snapshot: WeaveContextSnapshot | undefined) => snapshot
  ? {
      scope: snapshot.scope,
      portalId: snapshot.portalId,
      basePath: snapshot.basePath,
      workspacePath: snapshot.workspacePath,
      checkedAt: snapshot.checkedAt,
      files: snapshot.files.map(file => ({
        kind: file.kind,
        path: file.path,
        size: file.size,
        updatedAt: file.updatedAt,
      })),
    }
  : undefined;

const optionalQueryString = (c: any, name: string) => {
  const value = c.req.query(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const profileInput = (c: any): ProfileResolutionInput => ({
  mastra: c.get('mastra'),
  resourceId: getResourceId(c),
  threadId: optionalQueryString(c, 'threadId'),
  projectId: optionalQueryString(c, 'projectId'),
  workspaceId: optionalQueryString(c, 'workspaceId'),
  profileId: optionalQueryString(c, 'profileId'),
});

const resolvedResponse = async (c: any) => {
  const result = await listResolvedProfiles(profileInput(c));
  const profilesById = new Map<string, DynamicProfile>();
  for (const profile of result.profiles) profilesById.set(profile.id, profile);
  profilesById.set(builtinDefaultProfile.id, builtinDefaultProfile);

  return c.json({
    profiles: [...profilesById.values()].map(profileSummary),
    resolved: {
      profile: profileSummary(result.resolved.profile),
      selectedProfileId: result.resolved.profile.id,
      candidateProfileId: result.resolved.selectedProfileId,
      requestedProfileId: result.resolved.requestedProfileId,
      threadProfileId: typeof result.resolved.threadMetadata?.profileId === 'string' ? result.resolved.threadMetadata.profileId : undefined,
      projectDefaultProfileId: typeof result.resolved.project?.defaultProfileId === 'string' ? result.resolved.project.defaultProfileId : undefined,
      projectKind: result.resolved.projectKind,
      globalSnapshot: snapshotSummary(result.resolved.globalSnapshot),
      projectSnapshot: snapshotSummary(result.resolved.projectSnapshot),
      agentFiles: result.resolved.agentFiles.map(file => ({
        path: file.path,
        content: file.content,
        size: file.size,
        updatedAt: file.updatedAt,
      })),
    },
  });
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[profiles]', error);
  return c.json({ error: message }, 500);
};

export const profileRoutes = [
  registerApiRoute('/profiles', {
    method: 'GET',
    handler: async c => {
      try {
        return await resolvedResponse(c);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/profiles/resolved', {
    method: 'GET',
    handler: async c => {
      try {
        return await resolvedResponse(c);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
