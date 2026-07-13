import { productProjectRepository } from '../products/project-repository.ts';
import { getPortalConnection, listPortalConnections, requestPortalTool } from './registry.ts';
import { portalRepository } from './store.ts';

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const projectPortalIds = async (ownerId: string) => {
  const portalIds = new Set<string>();
  for (const project of await productProjectRepository.list(ownerId, { includeHidden: true })) {
    const projectPortalId = optionalString(project.portalId);
    if (projectPortalId) portalIds.add(projectPortalId);
    const notesPortalId = optionalString(project.notesStorage?.portalId);
    if (notesPortalId) portalIds.add(notesPortalId);
    for (const workspace of project.workspaces) {
      const workspacePortalId = optionalString(workspace.portalId);
      if (workspacePortalId) portalIds.add(workspacePortalId);
    }
  }
  return [...portalIds];
};

const requireOwnedPortal = (ownerId: string, portalId: string) => {
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== ownerId) throw new Error('Portal is offline or unavailable.');
  return portal;
};

export const listOwnerPortals = async (ownerId: string) => {
  const portals = listPortalConnections(ownerId);
  const storedPrimary = await portalRepository.getPrimaryPortalId(ownerId);
  const primaryPortalId = storedPrimary ?? portals[0]?.portalId;
  return portals.map(portal => ({ ...portal, primary: portal.portalId === primaryPortalId }));
};

export const browseOwnerPortal = async (input: {
  ownerId: string;
  portalId: string;
  rootId?: string;
  path?: string;
}) => {
  requireOwnedPortal(input.ownerId, input.portalId);
  return await requestPortalTool({
    portalId: input.portalId,
    tool: 'portal.fs.browse',
    args: { rootId: input.rootId ?? 'default', path: input.path ?? '' },
    timeoutMs: 10_000,
  });
};

export const setOwnerPrimaryPortal = async (ownerId: string, portalId: string) => {
  requireOwnedPortal(ownerId, portalId);
  await portalRepository.setPrimaryPortalId(ownerId, portalId);
  return {
    ok: true as const,
    primaryPortalId: portalId,
    portals: listPortalConnections(ownerId).map(portal => ({
      ...portal,
      primary: portal.portalId === portalId,
    })),
  };
};

export const issueOwnerPortalToken = async (ownerId: string) => {
  const mappedPortalIds = await projectPortalIds(ownerId);
  const portalId = mappedPortalIds[0] ??
    await portalRepository.getPrimaryPortalId(ownerId) ??
    `portal_${crypto.randomUUID()}`;
  const token = `mhb_${crypto.randomUUID().replace(/-/g, '')}`;
  await portalRepository.saveToken({ ownerId, portalId, token });
  await portalRepository.setPrimaryPortalId(ownerId, portalId);
  return { portalId, token };
};
