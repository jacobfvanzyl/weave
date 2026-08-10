import type { WorkspaceComposition } from '@weave/protocol';
import { productProjectRepository } from '../../products/project-repository.ts';
import type { Project } from '../../products/types.ts';
import { workspaceCompositionRepository } from './repository.ts';

type ProjectLookup = {
  get(ownerId: string, projectId: string): Promise<Project | undefined>;
};

type CompositionStore = {
  getOrCreate(ownerId: string, workspaceId: string): Promise<WorkspaceComposition>;
};

class WorkspaceCompositionNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super('Workspace was not found.');
    this.name = 'WorkspaceCompositionNotFoundError';
  }
}

export class WorkspaceCompositionService {
  constructor(
    private readonly projects: ProjectLookup = productProjectRepository,
    private readonly compositions: CompositionStore = workspaceCompositionRepository,
  ) {}

  async getOrCreate(ownerId: string, projectId: string, workspaceId: string) {
    const project = await this.projects.get(ownerId, projectId);
    if (!project?.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new WorkspaceCompositionNotFoundError();
    }
    return await this.compositions.getOrCreate(ownerId, workspaceId);
  }
}

export const workspaceCompositionService = new WorkspaceCompositionService();
