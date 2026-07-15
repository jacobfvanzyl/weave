import type {
  Project,
} from '@weave/protocol';

export type { NotesStorageMetadata, Project, Workspace } from '@weave/protocol';

export type ProductId = 'code' | 'notes' | 'chat';

export const productForProject = (project: Pick<Project, 'projectKind' | 'systemKind'>): ProductId => {
  if (project.systemKind === 'adHoc') return 'code';
  if (project.projectKind === 'git') return 'code';
  if (project.projectKind === 'notes') return 'notes';
  return 'chat';
};
